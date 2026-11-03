import * as path from 'path';

import { createAgentState } from '../../agentState.js';
import type { AgentStateStore, SourceProvider } from '../../agentStateStore.js';
import { assignPaletteIfNeeded } from '../../paletteAssigner.js';
import type { AgentState } from '../../types.js';
import {
  HERDR_POLL_INTERVAL_MS,
  OMO_READING_TOOLS,
  OMO_SESSION_POLL_INTERVAL_MS,
  OMO_SUBAGENT_TOOL_NAMES,
} from './constants.js';
import type { HerdrOmoAgent, HerdrSnapshot } from './herdrClient.js';
import { focusHerdrPane, readHerdrSnapshot } from './herdrClient.js';
import { applyOmoEvent, clearOmoTools, seedOmoTools, syncOmoSnapshot } from './omoActivity.js';
import {
  listOmoTranscripts,
  matchPanesToSessions,
  omoSessionDir,
  OmoSessionReader,
} from './omoSessionReader.js';

export const omoSourceProvider: SourceProvider = {
  id: 'omo',
  readingTools: new Set(OMO_READING_TOOLS),
  subagentToolNames: new Set(OMO_SUBAGENT_TOOL_NAMES),
  focusAgent: async (agent) => {
    if (agent.omoInfo) await focusHerdrPane(agent.omoInfo.paneId);
  },
};

interface OmoSourceOptions {
  readonly herdrBin?: string;
  readonly readHerdrSnapshot?: () => Promise<HerdrSnapshot>;
  readonly sessionsRoot?: string;
  readonly clock?: Pick<typeof globalThis, 'setInterval' | 'clearInterval'> & { now: () => number };
}

interface PaneSession {
  pane: HerdrOmoAgent;
  readonly agent: AgentState;
  reader?: OmoSessionReader;
  readonly kept: Set<string>;
  turnEnded: boolean;
}

/** Standalone source: herdr owns character identity; omo owns live activity. */
export class OmoSource {
  private readonly panes = new Map<string, PaneSession>();
  private readonly errors = new Set<string>();
  private readonly readSnapshot: () => Promise<HerdrSnapshot>;
  private readonly clock: NonNullable<OmoSourceOptions['clock']>;
  private timers: ReturnType<typeof setInterval>[] = [];
  private polling = false;
  private disposed = false;

  constructor(
    private readonly store: AgentStateStore,
    private readonly options: OmoSourceOptions = {},
  ) {
    this.readSnapshot =
      options.readHerdrSnapshot ?? (() => readHerdrSnapshot({ bin: options.herdrBin }));
    this.clock = options.clock ?? { setInterval, clearInterval, now: Date.now };
    store.sourceProvider = omoSourceProvider;
  }

  start(): void {
    if (this.timers.length || this.disposed) return;
    void this.pollHerdr();
    this.timers.push(
      this.clock.setInterval(() => void this.pollHerdr(), HERDR_POLL_INTERVAL_MS),
      this.clock.setInterval(() => this.pollSessions(), OMO_SESSION_POLL_INTERVAL_MS),
    );
  }

  async pollHerdr(): Promise<void> {
    if (this.polling || this.disposed) return;
    this.polling = true;
    try {
      const snapshot = await this.readSnapshot();
      if (this.disposed) return;
      this.store.setWorkspaces(snapshot.workspaces);
      const present = new Set(snapshot.agents.map((pane) => pane.paneId));
      for (const [paneId, session] of this.panes) {
        if (present.has(paneId)) continue;
        this.store.delete(session.agent.id);
        this.panes.delete(paneId);
      }
      const matches = matchPanesToSessions(snapshot.agents, (cwd) =>
        listOmoTranscripts(omoSessionDir(cwd, this.options.sessionsRoot)),
      );
      for (const pane of snapshot.agents) {
        let session = this.panes.get(pane.paneId);
        if (!session || !this.store.has(session.agent.id)) {
          const id = this.store.nextAgentId.current++;
          const agent = createAgentState({
            id,
            sessionId: pane.paneId,
            projectDir: pane.cwd,
            jsonlFile: '',
            isExternal: true,
            hooksOnly: true,
            hookDelivered: true,
            providerId: 'omo',
            directoryName: pane.sessionNameHint ?? path.basename(pane.cwd),
          });
          assignPaletteIfNeeded(agent, this.store);
          this.store.set(id, agent);
          session = { pane, agent, kept: new Set(), turnEnded: false };
          this.panes.set(pane.paneId, session);
          console.log(`[Pixel Agents] omo agent ${id} created for pane ${pane.paneId}`);
        }
        session.pane = pane;
        const file = matches.get(pane.paneId);
        const changed = session.reader?.filePath !== file;
        if (changed) {
          clearOmoTools(this.store, session.agent);
          session.kept.clear();
          session.turnEnded = false;
          session.reader = file ? new OmoSessionReader(file) : undefined;
          // Consume history once, then publish only the current snapshot.
          session.reader?.poll();
        }
        this.sync(session);
        if (changed && session.reader) {
          seedOmoTools(this.store, session.agent, session.reader.snapshot().activeTools);
        }
      }
    } catch (error) {
      this.reportError(error);
    } finally {
      this.polling = false;
    }
  }

  pollSessions(): void {
    if (this.polling || this.disposed) return;
    try {
      for (const session of this.panes.values()) {
        const reader = session.reader;
        if (!reader) continue;
        const events = reader.poll();
        const snapshot = reader.snapshot();
        for (const event of events) {
          if (event.kind === 'turnEnd') session.turnEnded = true;
          if (
            event.kind === 'turnStart' ||
            event.kind === 'toolStart' ||
            event.kind === 'lifecycle'
          ) {
            session.turnEnded = false;
          }
          applyOmoEvent(this.store, session.agent, { event, kept: session.kept, snapshot });
        }
        session.agent.lastDataAt = this.clock.now();
        this.sync(session);
      }
    } catch (error) {
      this.reportError(error);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers) this.clock.clearInterval(timer);
    this.timers = [];
    for (const session of this.panes.values()) this.store.delete(session.agent.id);
    this.panes.clear();
  }

  private sync(session: PaneSession): void {
    const snapshot = session.reader?.snapshot() ?? {
      lifecycle: 'idle',
      waitingOn: { children: 0, background: 0, human: 0 },
      activeTools: [],
      turnActive: false,
    };
    syncOmoSnapshot(this.store, session.agent, {
      pane: session.pane,
      snapshot,
      turnEnded: session.turnEnded,
    });
  }

  private reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (this.errors.has(message)) return;
    this.errors.add(message);
    console.error(`[Pixel Agents] omo source: ${message}`);
  }
}
