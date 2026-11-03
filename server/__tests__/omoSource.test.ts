import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { handleClientMessage } from '../src/clientMessageHandler.js';
import type { HerdrSnapshot } from '../src/providers/omo/herdrClient.js';
import { omoSessionDir } from '../src/providers/omo/omoSessionReader.js';
import { OmoSource } from '../src/providers/omo/omoSource.js';

describe('omo source', () => {
  let root: string;
  let file: string;
  let store: AgentStateStore;
  let source: OmoSource;
  let snapshot: HerdrSnapshot;
  let messages: Record<string, unknown>[];
  let removed: number[];

  function append(...records: Record<string, unknown>[]): void {
    fs.appendFileSync(file, records.map((record) => JSON.stringify(record) + '\n').join(''));
  }

  function lifecycle(state: string, children = 0): Record<string, unknown> {
    return {
      type: 'custom',
      customType: 'session-lifecycle',
      data: {
        state,
        waitingOn: { children, background: [], human: state === 'waiting_human' ? [{}] : [] },
      },
    };
  }

  function call(
    id: string,
    name = 'mcp__custom-tools__read',
    background = false,
  ): Record<string, unknown> {
    return {
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id,
            name,
            arguments: { summary: `Summary ${id}`, run_in_background: background },
          },
        ],
      },
    };
  }

  function ended(id: string): Record<string, unknown> {
    return {
      type: 'custom',
      customType: 'oppi-lifecycle',
      data: { event: 'tool_execution_end', toolCallId: id },
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-source-'));
    vi.stubEnv('HOME', root);
    const dir = omoSessionDir('/project', root);
    fs.mkdirSync(dir);
    file = path.join(dir, 'session.jsonl');
    fs.writeFileSync(file, '');
    snapshot = {
      workspaces: [{ id: 'w1', label: 'Work', number: 1, focused: true }],
      agents: [
        {
          paneId: 'w1:p1',
          workspaceId: 'w1',
          tabId: 'w1:t1',
          cwd: '/project',
          title: 'OmO - Session - project',
          sessionNameHint: 'Session',
          status: 'working',
          focused: true,
        },
      ],
    };
    store = new AgentStateStore();
    messages = [];
    removed = [];
    store.on('broadcast', (message) => messages.push(message));
    store.on('agentRemoved', (id) => removed.push(id));
    source = new OmoSource(store, {
      readHerdrSnapshot: async () => snapshot,
      sessionsRoot: root,
      clock: { setInterval, clearInterval, now: Date.now },
    });
  });

  afterEach(() => {
    source.dispose();
    store.dispose();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('creates one transcriptless agent per pane and closes it when the pane disappears', async () => {
    const added: number[] = [];
    store.on('agentAdded', (id) => added.push(id));
    await source.pollHerdr();
    await source.pollHerdr();
    expect(added).toEqual([1]);
    expect(store.get(1)).toMatchObject({ providerId: 'omo', hooksOnly: true, isExternal: true });
    expect(messages.filter((message) => message.type === 'agentOmoInfo')).toEqual([
      {
        type: 'agentOmoInfo',
        id: 1,
        workspaceId: 'w1',
        paneId: 'w1:p1',
        sessionName: 'Session',
        activity: undefined,
        lifecycle: 'idle',
        waitingOn: { children: 0, background: 0, human: 0 },
        herdrStatus: 'working',
      },
    ]);
    snapshot.agents = [];
    await source.pollHerdr();
    expect(removed).toEqual([1]);
    expect(store.size).toBe(0);
  });

  it('publishes live tool summaries and bare tool names on the 500 ms reader clock', async () => {
    await source.pollHerdr();
    source.start();
    append(lifecycle('running'), call('read-1'), {
      type: 'custom',
      customType: 'oppi-lifecycle',
      data: {
        event: 'tool_execution_start',
        toolCallId: 'read-1',
        toolName: 'mcp__custom-tools__read',
      },
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(messages.filter((message) => message.type === 'agentToolStart')).toEqual([
      {
        type: 'agentToolStart',
        id: 1,
        toolId: 'read-1',
        toolName: 'read',
        status: 'Summary read-1',
        runInBackground: false,
      },
    ]);
    expect(store.get(1)?.omoInfo?.activity).toBe('Summary read-1');
  });

  it.each(['waiting_human', 'blocked'])('marks %s as awaiting human input', async (condition) => {
    await source.pollHerdr();
    append(lifecycle(condition === 'blocked' ? 'running' : condition));
    source.pollSessions();
    if (condition === 'blocked') {
      snapshot.agents = snapshot.agents.map((pane) => ({ ...pane, status: 'blocked' }));
      await source.pollHerdr();
    }
    expect(messages.at(-2)).toMatchObject({
      type: 'agentStatus',
      status: 'waiting',
      awaitingInput: true,
    });
  });

  it.each(['done', 'idle', 'paused', 'failed'])(
    'clears tools on terminal lifecycle %s',
    async (state) => {
      await source.pollHerdr();
      append(lifecycle('running'), call('a'));
      source.pollSessions();
      append(lifecycle(state));
      source.pollSessions();
      expect(store.get(1)?.activeToolIds.size).toBe(0);
      expect(store.get(1)).toMatchObject({ isWaiting: true, awaitingInput: false });
      expect(messages).toContainEqual({ type: 'agentToolDone', id: 1, toolId: 'a' });
    },
  );

  it('keeps completed background task tools until children drop, ending the oldest first', async () => {
    await source.pollHerdr();
    append(
      lifecycle('waiting_children', 2),
      call('old', 'task', true),
      call('new', 'task', true),
      ended('old'),
      ended('new'),
    );
    source.pollSessions();
    expect([...(store.get(1)?.activeToolIds ?? [])]).toEqual(['old', 'new']);
    expect(messages.filter((message) => message.type === 'agentToolDone')).toEqual([]);
    append(lifecycle('waiting_children', 1));
    source.pollSessions();
    expect(messages.filter((message) => message.type === 'agentToolDone')).toEqual([
      { type: 'agentToolDone', id: 1, toolId: 'old' },
    ]);
    append(lifecycle('done'));
    source.pollSessions();
    expect([...(store.get(1)?.activeToolIds ?? [])]).toEqual([]);
  });

  it('seeds only the current snapshot, without replaying completed historical tools', async () => {
    append(call('past'), ended('past'), lifecycle('running'), call('live'));
    await source.pollHerdr();
    expect(
      messages
        .filter((message) => message.type === 'agentToolStart')
        .map((message) => message.toolId),
    ).toEqual(['live']);
    expect(messages.filter((message) => message.type === 'agentToolDone')).toEqual([]);
    expect(store.get(1)?.omoInfo?.activity).toBe('Summary live');
  });

  it('swaps readers when a pane matches a different session', async () => {
    append({ type: 'session_info', name: 'Session' }, lifecycle('running'), call('old'));
    await source.pollHerdr();
    const second = path.join(path.dirname(file), 'new.jsonl');
    fs.writeFileSync(second, JSON.stringify({ type: 'session_info', name: 'Replacement' }) + '\n');
    snapshot.agents = snapshot.agents.map((pane) => ({ ...pane, sessionNameHint: 'Replacement' }));
    await source.pollHerdr();
    append(call('stale'));
    source.pollSessions();
    expect(store.get(1)?.omoInfo?.sessionName).toBe('Replacement');
    expect(store.get(1)?.activeToolIds.size).toBe(0);
  });

  it('skips overlapping polls and ignores a snapshot that arrives after disposal', async () => {
    source.dispose();
    let resolve: (value: HerdrSnapshot) => void = () => {
      throw new Error('Snapshot reader not called');
    };
    const read = vi.fn(
      () =>
        new Promise<HerdrSnapshot>((done) => {
          resolve = done;
        }),
    );
    source = new OmoSource(store, { readHerdrSnapshot: read, sessionsRoot: root });
    const pending = source.pollHerdr();
    await source.pollHerdr();
    expect(read).toHaveBeenCalledTimes(1);
    source.dispose();
    resolve(snapshot);
    await pending;
    expect(store.size).toBe(0);
  });

  it('logs each distinct herdr error once and retries on the next tick', async () => {
    source.dispose();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const read = vi
      .fn<() => Promise<HerdrSnapshot>>()
      .mockRejectedValueOnce(new Error('socket down'))
      .mockRejectedValueOnce(new Error('socket down'))
      .mockResolvedValue(snapshot);
    source = new OmoSource(store, { readHerdrSnapshot: read, sessionsRoot: root });
    await source.pollHerdr();
    await source.pollHerdr();
    await source.pollHerdr();
    expect(log).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(1);
  });

  it('reconnects with workspaces then agents then omo metadata and no hooks consent', async () => {
    append(lifecycle('waiting_human'));
    await source.pollHerdr();
    const sent: Record<string, unknown>[] = [];
    handleClientMessage({ type: 'webviewReady' }, (message) => sent.push(message), {
      store,
      cache: null,
      privileged: true,
    });
    expect(
      sent
        .filter((message) =>
          ['workspacesLoaded', 'existingAgents', 'agentOmoInfo'].includes(String(message.type)),
        )
        .map((message) => message.type),
    ).toEqual(['workspacesLoaded', 'existingAgents', 'agentOmoInfo']);
    expect(sent.find((message) => message.type === 'providerCapabilities')).toMatchObject({
      readingTools: ['read', 'grep', 'glob', 'web_search', 'webfetch'],
      subagentToolNames: ['task'],
    });
    expect(sent.find((message) => message.type === 'agentStatus')).toMatchObject({
      awaitingInput: true,
    });
    expect(sent.some((message) => message.type === 'hooksConsentRequest')).toBe(false);
  });

  it('broadcasts workspaces only when their values change', async () => {
    await source.pollHerdr();
    snapshot.workspaces = snapshot.workspaces.map((workspace) => ({ ...workspace }));
    await source.pollHerdr();
    snapshot.workspaces[0].label = 'Renamed';
    await source.pollHerdr();
    expect(
      messages
        .filter((message) => message.type === 'workspacesLoaded')
        .map((message) => message.workspaces),
    ).toEqual([
      [{ id: 'w1', label: 'Work', number: 1, focused: true }],
      [{ id: 'w1', label: 'Renamed', number: 1, focused: true }],
    ]);
  });

  it('routes privileged focus to the source capability with the omo pane identity', async () => {
    await source.pollHerdr();
    let focusedPane: string | undefined;
    let complete = () => {};
    const focused = new Promise<void>((resolve) => {
      complete = resolve;
    });
    store.sourceProvider = {
      id: 'omo',
      readingTools: new Set(),
      subagentToolNames: new Set(),
      focusAgent: async (agent) => {
        focusedPane = agent.omoInfo?.paneId;
        complete();
      },
    };
    handleClientMessage({ type: 'focusAgent', id: 1 }, () => {}, {
      store,
      cache: null,
      privileged: true,
    });
    await focused;
    expect(focusedPane).toBe('w1:p1');
  });

  it('clears tools at agent end and stays waiting through the next herdr poll', async () => {
    await source.pollHerdr();
    append(
      lifecycle('running'),
      {
        type: 'custom',
        customType: 'oppi-lifecycle',
        data: { event: 'turn_start' },
      },
      call('a'),
    );
    source.pollSessions();
    append({ type: 'custom', customType: 'oppi-lifecycle', data: { event: 'turn_end' } });
    source.pollSessions();
    expect(store.get(1)).toMatchObject({ isWaiting: false });
    append({ type: 'custom', customType: 'oppi-lifecycle', data: { event: 'agent_end' } });
    source.pollSessions();
    await source.pollHerdr();
    expect(store.get(1)).toMatchObject({ isWaiting: true, awaitingInput: false });
    expect(store.get(1)?.activeToolIds.size).toBe(0);
  });
});
