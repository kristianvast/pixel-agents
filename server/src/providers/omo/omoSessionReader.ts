import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { OmoLifecycle, OmoWaitingOn } from '../../../../core/src/messages.js';
import { OMO_SUMMARY_MAX_CHARS, OMO_TAIL_READ_BYTES } from './constants.js';

export interface OmoToolActivity {
  toolCallId: string;
  toolName: string;
  summary: string;
  runInBackground: boolean;
}

export interface OmoSessionSnapshot {
  sessionId?: string;
  cwd?: string;
  sessionName?: string;
  lifecycle: OmoLifecycle;
  waitingOn: OmoWaitingOn;
  activeTools: OmoToolActivity[];
  lastSummary?: string;
  turnActive: boolean;
}

export type OmoSessionEvent =
  | { kind: 'toolStart'; tool: OmoToolActivity }
  | { kind: 'toolEnd'; toolCallId: string }
  | { kind: 'turnStart' }
  | { kind: 'turnEnd' }
  | { kind: 'lifecycle'; lifecycle: OmoLifecycle; waitingOn: OmoWaitingOn }
  | { kind: 'sessionName'; name: string };

const LIFECYCLES: readonly OmoLifecycle[] = [
  'running',
  'waiting_background',
  'waiting_children',
  'waiting_human',
  'done',
  'paused',
  'failed',
  'idle',
];
const TERMINAL_LIFECYCLES: readonly OmoLifecycle[] = ['done', 'idle', 'failed', 'paused'];

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function truncate(text: string): string {
  return text.length > OMO_SUMMARY_MAX_CHARS
    ? text.slice(0, OMO_SUMMARY_MAX_CHARS - 1) + '…'
    : text;
}

function firstString(args: Json, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = args[key];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return undefined;
}

export function summarizeToolCall(name: string, args: Record<string, unknown>): string {
  const explicit = firstString(args, ['summary', 'task_summary', 'description']);
  if (explicit) return truncate(explicit);

  const bare = name.replace(/^mcp__.+?__/, '');
  const filePath = firstString(args, ['path', 'file_path']);
  const base = filePath ? path.posix.basename(filePath.replaceAll('\\', '/')) : undefined;
  let text: string;
  switch (bare) {
    case 'read':
      text = `Reading ${base ?? 'file'}`;
      break;
    case 'edit':
    case 'write':
      text = `Editing ${base ?? 'file'}`;
      break;
    case 'grep':
      text = 'Searching code';
      break;
    case 'glob':
      text = 'Finding files';
      break;
    case 'web_search':
      text = 'Searching the web';
      break;
    case 'webfetch': {
      let host: string | undefined;
      const url = firstString(args, ['url']);
      if (url) {
        try {
          host = new URL(url).hostname || undefined;
        } catch {
          host = undefined;
        }
      }
      text = `Fetching ${host ?? 'page'}`;
      break;
    }
    case 'eval':
      text = 'Running code';
      break;
    case 'bash':
      text = 'Running command';
      break;
    case 'task':
      text = 'Delegating';
      break;
    case 'todo':
      text = 'Updating todos';
      break;
    case 'ask_user_question':
      text = 'Asking you';
      break;
    default:
      text = `Using ${bare}`;
  }
  return truncate(text);
}

export function omoSessionsRoot(home: string = os.homedir()): string {
  const override = process.env.OMO_CODING_AGENT_DIR;
  if (override) return path.join(override, 'sessions');
  return path.join(home, '.omo', 'agent', 'sessions');
}

export function omoSessionDir(cwd: string, root: string = omoSessionsRoot()): string {
  return path.join(root, '--' + cwd.replace(/^\//, '').replaceAll('/', '-') + '--');
}

function toBool(v: unknown): boolean {
  return v === true || (typeof v === 'string' && v.toLowerCase() === 'true');
}

export class OmoSessionReader {
  readonly filePath: string;
  private offset = 0;
  private pending: Buffer = Buffer.alloc(0);

  private sessionId?: string;
  private cwd?: string;
  private sessionName?: string;
  private lifecycle: OmoLifecycle = 'idle';
  private waitingOn: OmoWaitingOn = { children: 0, background: 0, human: 0 };
  private turnActive = false;
  private lastSummary?: string;
  private readonly active = new Map<string, OmoToolActivity>();
  private readonly callCache = new Map<string, { summary: string; runInBackground: boolean }>();
  private readonly started = new Set<string>();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  poll(): OmoSessionEvent[] {
    const events: OmoSessionEvent[] = [];
    let size: number;
    try {
      size = fs.statSync(this.filePath).size;
    } catch {
      return events;
    }
    if (size < this.offset) this.reset();
    if (size === this.offset) return events;

    const chunk = Buffer.alloc(size - this.offset);
    let fd: number;
    try {
      fd = fs.openSync(this.filePath, 'r');
    } catch {
      return events;
    }
    let read = 0;
    try {
      read = fs.readSync(fd, chunk, 0, chunk.length, this.offset);
    } finally {
      fs.closeSync(fd);
    }
    this.offset += read;

    const data = Buffer.concat([this.pending, chunk.subarray(0, read)]);
    const lastNl = data.lastIndexOf(0x0a);
    if (lastNl === -1) {
      this.pending = data;
      return events;
    }
    this.pending = data.subarray(lastNl + 1);
    for (const line of data.subarray(0, lastNl).toString('utf8').split('\n')) {
      if (line.trim() === '') continue;
      let rec: unknown;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (isObject(rec)) this.handleRecord(rec, events);
    }
    return events;
  }

  snapshot(): OmoSessionSnapshot {
    return {
      sessionId: this.sessionId,
      cwd: this.cwd,
      sessionName: this.sessionName,
      lifecycle: this.lifecycle,
      waitingOn: { ...this.waitingOn },
      activeTools: [...this.active.values()].map((t) => ({ ...t })),
      lastSummary: this.lastSummary,
      turnActive: this.turnActive,
    };
  }

  private reset(): void {
    this.offset = 0;
    this.pending = Buffer.alloc(0);
    this.sessionId = undefined;
    this.cwd = undefined;
    this.sessionName = undefined;
    this.lifecycle = 'idle';
    this.waitingOn = { children: 0, background: 0, human: 0 };
    this.turnActive = false;
    this.lastSummary = undefined;
    this.active.clear();
    this.callCache.clear();
    this.started.clear();
  }

  private handleRecord(rec: Json, events: OmoSessionEvent[]): void {
    // startupBookkeeping records mark a new omo process attaching to the session
    // (start, resume, reload). Waits recorded by the previous process are gone:
    // omo re-writes session-lifecycle for anything still pending (a restored
    // question comes back as waiting_human with the same requestId), so reset
    // here instead of trusting a stale waiting_human forever.
    if (rec.startupBookkeeping === true) this.resetForNewProcess(events);
    switch (rec.type) {
      case 'session':
        if (typeof rec.id === 'string') this.sessionId = rec.id;
        if (typeof rec.cwd === 'string') this.cwd = rec.cwd;
        break;
      case 'session_info':
        if (typeof rec.name === 'string' && rec.name !== '') {
          this.sessionName = rec.name;
          events.push({ kind: 'sessionName', name: rec.name });
        }
        break;
      case 'custom':
        this.handleCustom(rec, events);
        break;
      case 'message':
        if (isObject(rec.message)) this.handleMessage(rec.message, events);
        break;
    }
  }

  private resetForNewProcess(events: OmoSessionEvent[]): void {
    if (this.turnActive) {
      this.turnActive = false;
      events.push({ kind: 'turnEnd' });
    }
    const zero: OmoWaitingOn = { children: 0, background: 0, human: 0 };
    const changed =
      this.lifecycle !== 'idle' ||
      this.waitingOn.children !== 0 ||
      this.waitingOn.background !== 0 ||
      this.waitingOn.human !== 0;
    if (!changed) return;
    this.lifecycle = 'idle';
    this.waitingOn = zero;
    events.push({ kind: 'lifecycle', lifecycle: 'idle', waitingOn: { ...zero } });
    for (const id of [...this.active.keys()]) this.endTool(id, events);
  }

  private handleCustom(rec: Json, events: OmoSessionEvent[]): void {
    const data = isObject(rec.data) ? rec.data : undefined;
    if (!data) return;
    if (rec.customType === 'session-lifecycle') {
      this.handleLifecycle(data, events);
    } else if (rec.customType === 'oppi-lifecycle') {
      this.handleOppi(data, events);
    }
  }

  private handleLifecycle(data: Json, events: OmoSessionEvent[]): void {
    const state = LIFECYCLES.find((s) => s === data.state);
    if (!state) return;
    const w = isObject(data.waitingOn) ? data.waitingOn : {};
    const children = Number(w.children) || 0;
    let background = 0;
    if (Array.isArray(w.background)) {
      for (const entry of w.background) {
        const n = isObject(entry) && typeof entry.activeCount === 'number' ? entry.activeCount : 1;
        background += n;
      }
    }
    const human = Array.isArray(w.human) ? w.human.length : 0;
    const next: OmoWaitingOn = { children, background, human };
    const changed =
      state !== this.lifecycle ||
      next.children !== this.waitingOn.children ||
      next.background !== this.waitingOn.background ||
      next.human !== this.waitingOn.human;
    this.lifecycle = state;
    this.waitingOn = next;
    if (changed) events.push({ kind: 'lifecycle', lifecycle: state, waitingOn: { ...next } });
    if (TERMINAL_LIFECYCLES.includes(state)) {
      for (const id of [...this.active.keys()]) this.endTool(id, events);
    }
  }

  private handleOppi(data: Json, events: OmoSessionEvent[]): void {
    switch (data.event) {
      case 'turn_start':
        this.turnActive = true;
        events.push({ kind: 'turnStart' });
        break;
      // omo's turn_start/turn_end bracket each model step inside one run; only
      // agent_end ends the run the user sees, so turn_end must not end the turn.
      case 'agent_end':
        if (this.turnActive) {
          this.turnActive = false;
          events.push({ kind: 'turnEnd' });
        }
        break;
      case 'tool_execution_start':
        if (typeof data.toolCallId === 'string' && typeof data.toolName === 'string') {
          this.startTool(data.toolCallId, data.toolName, events);
        }
        break;
      case 'tool_execution_end':
        if (typeof data.toolCallId === 'string') this.endTool(data.toolCallId, events);
        break;
    }
  }

  private handleMessage(message: Json, events: OmoSessionEvent[]): void {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const item of message.content) {
        if (!isObject(item) || item.type !== 'toolCall') continue;
        if (typeof item.id !== 'string' || typeof item.name !== 'string') continue;
        const args = isObject(item.arguments) ? item.arguments : {};
        this.callCache.set(item.id, {
          summary: summarizeToolCall(item.name, args),
          runInBackground: toBool(args.run_in_background),
        });
        // Older omo emits no tool_execution_start: the toolCall itself starts the tool.
        this.startTool(item.id, item.name, events);
      }
    } else if (message.role === 'toolResult' && typeof message.toolCallId === 'string') {
      this.endTool(message.toolCallId, events);
    }
  }

  private startTool(id: string, name: string, events: OmoSessionEvent[]): void {
    if (this.started.has(id)) return;
    this.started.add(id);
    const cached = this.callCache.get(id);
    const tool: OmoToolActivity = {
      toolCallId: id,
      toolName: name,
      summary: cached?.summary ?? summarizeToolCall(name, {}),
      runInBackground: cached?.runInBackground ?? false,
    };
    this.active.set(id, tool);
    this.lastSummary = tool.summary;
    events.push({ kind: 'toolStart', tool });
  }

  private endTool(id: string, events: OmoSessionEvent[]): void {
    if (!this.active.delete(id)) return;
    events.push({ kind: 'toolEnd', toolCallId: id });
  }
}

export interface OmoTranscriptCandidate {
  path: string;
  mtimeMs: number;
  sessionName?: string;
}

function lastSessionName(text: string): string | undefined {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"session_info"')) continue;
    try {
      const rec: unknown = JSON.parse(line);
      if (
        isObject(rec) &&
        rec.type === 'session_info' &&
        typeof rec.name === 'string' &&
        rec.name
      ) {
        return rec.name;
      }
    } catch {
      // partial line at the tail window start, or corrupt: skip
    }
  }
  return undefined;
}

function findSessionName(file: string, size: number): string | undefined {
  try {
    const start = Math.max(0, size - OMO_TAIL_READ_BYTES);
    const buf = Buffer.alloc(size - start);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buf, 0, buf.length, start);
    } finally {
      fs.closeSync(fd);
    }
    const tail = lastSessionName(buf.toString('utf8'));
    if (tail !== undefined || start === 0) return tail;
    return lastSessionName(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

export function listOmoTranscripts(
  dir: string,
  opts?: { maxAgeMs?: number },
): OmoTranscriptCandidate[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const now = Date.now();
  const out: OmoTranscriptCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const full = path.join(dir, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (opts?.maxAgeMs !== undefined && now - stat.mtimeMs > opts.maxAgeMs) continue;
    out.push({ path: full, mtimeMs: stat.mtimeMs, sessionName: findSessionName(full, stat.size) });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : 1));
  return out;
}

export function matchPanesToSessions(
  panes: { paneId: string; cwd: string; sessionNameHint?: string }[],
  candidatesFor: (cwd: string) => OmoTranscriptCandidate[],
): Map<string, string> {
  const result = new Map<string, string>();
  const used = new Set<string>();
  const cache = new Map<string, OmoTranscriptCandidate[]>();
  const candidates = (cwd: string): OmoTranscriptCandidate[] => {
    let c = cache.get(cwd);
    if (!c) {
      c = candidatesFor(cwd);
      cache.set(cwd, c);
    }
    return c;
  };

  for (const pane of panes) {
    if (!pane.sessionNameHint) continue;
    const hit = candidates(pane.cwd).find(
      (c) => !used.has(c.path) && c.sessionName === pane.sessionNameHint,
    );
    if (hit) {
      used.add(hit.path);
      result.set(pane.paneId, hit.path);
    }
  }
  for (const pane of panes) {
    if (result.has(pane.paneId)) continue;
    const hit = candidates(pane.cwd).find((c) => !used.has(c.path));
    if (hit) {
      used.add(hit.path);
      result.set(pane.paneId, hit.path);
    }
  }
  return result;
}
