import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { OmoTranscriptCandidate } from '../src/providers/omo/omoSessionReader.js';
import {
  listOmoTranscripts,
  matchPanesToSessions,
  omoSessionDir,
  OmoSessionReader,
  omoSessionsRoot,
  summarizeToolCall,
} from '../src/providers/omo/omoSessionReader.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-reader-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const line = (rec: unknown): string => JSON.stringify(rec) + '\n';
const lifecycle = (state: string, waitingOn?: unknown): string =>
  line({ type: 'custom', customType: 'session-lifecycle', data: { state, waitingOn } });
const oppi = (event: string, extra: Record<string, unknown> = {}): string =>
  line({ type: 'custom', customType: 'oppi-lifecycle', data: { version: 1, event, ...extra } });
const toolCall = (id: string, name: string, args: Record<string, unknown>): string =>
  line({
    type: 'message',
    message: { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }] },
  });
const toolResult = (id: string): string =>
  line({ type: 'message', message: { role: 'toolResult', toolCallId: id, content: [] } });
const sessionLine = line({ type: 'session', version: 3, id: 'sess-1', cwd: '/work/proj' });

function newFile(name = 's.jsonl'): string {
  return path.join(tmp, name);
}

describe('OmoSessionReader', () => {
  it('reads incrementally and buffers a partial trailing line', () => {
    const file = newFile();
    fs.writeFileSync(
      file,
      sessionLine + line({ type: 'session_info', name: 'Alpha' }).slice(0, 20),
    );
    const reader = new OmoSessionReader(file);
    expect(reader.poll()).toEqual([]);
    expect(reader.snapshot().sessionId).toBe('sess-1');
    expect(reader.snapshot().cwd).toBe('/work/proj');
    expect(reader.snapshot().sessionName).toBeUndefined();

    fs.appendFileSync(file, line({ type: 'session_info', name: 'Alpha' }).slice(20));
    fs.appendFileSync(file, 'not json at all\n');
    expect(reader.poll()).toEqual([{ kind: 'sessionName', name: 'Alpha' }]);
    expect(reader.snapshot().sessionName).toBe('Alpha');
    expect(reader.poll()).toEqual([]);
  });

  it('resets when the file shrinks', () => {
    const file = newFile();
    fs.writeFileSync(file, sessionLine + lifecycle('running'));
    const reader = new OmoSessionReader(file);
    reader.poll();
    expect(reader.snapshot().lifecycle).toBe('running');
    fs.writeFileSync(file, line({ type: 'session', id: 'b' }));
    reader.poll();
    expect(reader.snapshot().sessionId).toBe('b');
    expect(reader.snapshot().lifecycle).toBe('idle');
  });

  it('maps lifecycle and waitingOn counts, emitting only on change', () => {
    const file = newFile();
    fs.writeFileSync(file, '');
    const reader = new OmoSessionReader(file);
    expect(reader.snapshot().lifecycle).toBe('idle');
    expect(reader.snapshot().waitingOn).toEqual({ children: 0, background: 0, human: 0 });

    fs.appendFileSync(
      file,
      lifecycle('waiting_background', {
        children: 2,
        background: [{ activeCount: 3 }, {}],
        human: [{ kind: 'question' }],
      }) +
        lifecycle('waiting_background', {
          children: 2,
          background: [{ activeCount: 3 }, {}],
          human: [{ kind: 'question' }],
        }) +
        lifecycle('bogus_state'),
    );
    const events = reader.poll();
    expect(events).toEqual([
      {
        kind: 'lifecycle',
        lifecycle: 'waiting_background',
        waitingOn: { children: 2, background: 4, human: 1 },
      },
    ]);
    expect(reader.snapshot().lifecycle).toBe('waiting_background');
  });

  it('tracks tools via oppi-lifecycle with summary from args, and turns', () => {
    const file = newFile();
    fs.writeFileSync(
      file,
      oppi('turn_start') +
        toolCall('t1', 'mcp__custom-tools__eval', {
          summary: 'Installing deps',
          run_in_background: 'True',
        }) +
        oppi('tool_execution_start', { toolCallId: 't1', toolName: 'mcp__custom-tools__eval' }) +
        oppi('tool_execution_start', { toolCallId: 't2', toolName: 'read' }),
    );
    const reader = new OmoSessionReader(file);
    const events = reader.poll();
    const starts = events.filter((e) => e.kind === 'toolStart');
    expect(starts).toHaveLength(2);
    expect(events[0]).toEqual({ kind: 'turnStart' });
    expect(reader.snapshot().turnActive).toBe(true);
    expect(reader.snapshot().activeTools).toEqual([
      {
        toolCallId: 't1',
        toolName: 'mcp__custom-tools__eval',
        summary: 'Installing deps',
        runInBackground: true,
      },
      { toolCallId: 't2', toolName: 'read', summary: 'Reading file', runInBackground: false },
    ]);
    expect(reader.snapshot().lastSummary).toBe('Reading file');

    fs.appendFileSync(file, oppi('tool_execution_end', { toolCallId: 't1' }) + oppi('turn_end'));
    expect(reader.poll()).toEqual([{ kind: 'toolEnd', toolCallId: 't1' }]);
    expect(reader.snapshot().turnActive).toBe(true);

    fs.appendFileSync(file, oppi('agent_end'));
    expect(reader.poll()).toEqual([{ kind: 'turnEnd' }]);
    expect(reader.snapshot().turnActive).toBe(false);
  });

  it('falls back to toolCall/toolResult for older omo without duplicates', () => {
    const file = newFile();
    fs.writeFileSync(
      file,
      toolCall('a1', 'grep', { pattern: 'x' }) +
        toolResult('a1') +
        toolResult('a1') +
        toolCall('a2', 'edit', { path: '/x/y/file.ts' }),
    );
    const reader = new OmoSessionReader(file);
    expect(reader.poll()).toEqual([
      {
        kind: 'toolStart',
        tool: {
          toolCallId: 'a1',
          toolName: 'grep',
          summary: 'Searching code',
          runInBackground: false,
        },
      },
      { kind: 'toolEnd', toolCallId: 'a1' },
      {
        kind: 'toolStart',
        tool: {
          toolCallId: 'a2',
          toolName: 'edit',
          summary: 'Editing file.ts',
          runInBackground: false,
        },
      },
    ]);
  });

  it('does not duplicate when both toolCall and oppi events arrive', () => {
    const file = newFile();
    fs.writeFileSync(
      file,
      toolCall('b1', 'bash', {}) +
        oppi('tool_execution_start', { toolCallId: 'b1', toolName: 'bash' }) +
        oppi('tool_execution_end', { toolCallId: 'b1' }) +
        toolResult('b1'),
    );
    const events = new OmoSessionReader(file).poll();
    expect(events.map((e) => e.kind)).toEqual(['toolStart', 'toolEnd']);
  });

  it('drops a waiting_human left by a previous process when omo restarts the session', () => {
    const file = newFile();
    const question = { kind: 'question', requestId: 'question:q1:7' };
    const bookkeeping = line({
      type: 'custom',
      customType: 'pi-rules.scan',
      data: { reason: 'reload' },
      startupBookkeeping: true,
    });
    fs.writeFileSync(file, sessionLine + lifecycle('waiting_human', { human: [question] }));
    const reader = new OmoSessionReader(file);
    reader.poll();
    expect(reader.snapshot().lifecycle).toBe('waiting_human');

    // Restart with no pending question re-asserted: the stale wait is gone.
    fs.appendFileSync(file, bookkeeping + bookkeeping);
    expect(reader.poll()).toEqual([
      { kind: 'lifecycle', lifecycle: 'idle', waitingOn: { children: 0, background: 0, human: 0 } },
    ]);

    // A still-pending question is re-written by omo after the restart and wins.
    fs.appendFileSync(file, bookkeeping + lifecycle('waiting_human', { human: [question] }));
    reader.poll();
    expect(reader.snapshot()).toMatchObject({
      lifecycle: 'waiting_human',
      waitingOn: { children: 0, background: 0, human: 1 },
    });
  });

  it('ends all active tools when lifecycle becomes done', () => {
    const file = newFile();
    fs.writeFileSync(
      file,
      lifecycle('running') +
        toolCall('c1', 'eval', {}) +
        toolCall('c2', 'task', { run_in_background: true }),
    );
    const reader = new OmoSessionReader(file);
    reader.poll();
    expect(reader.snapshot().activeTools).toHaveLength(2);
    fs.appendFileSync(file, lifecycle('done'));
    const events = reader.poll();
    expect(events.map((e) => e.kind)).toEqual(['lifecycle', 'toolEnd', 'toolEnd']);
    expect(reader.snapshot().activeTools).toEqual([]);
  });
});

describe('summarizeToolCall', () => {
  it('prefers summary, task_summary, then description', () => {
    expect(summarizeToolCall('eval', { summary: 'S', task_summary: 'T', description: 'D' })).toBe(
      'S',
    );
    expect(summarizeToolCall('task', { summary: ' ', task_summary: 'T', description: 'D' })).toBe(
      'T',
    );
    expect(summarizeToolCall('task', { description: 'D' })).toBe('D');
  });

  it('humanises tool names and strips the mcp prefix', () => {
    expect(summarizeToolCall('mcp__custom-tools__eval', {})).toBe('Running code');
    expect(summarizeToolCall('read', { file_path: '/a/b/c.ts' })).toBe('Reading c.ts');
    expect(summarizeToolCall('write', { path: '/a/b/d.ts' })).toBe('Editing d.ts');
    expect(summarizeToolCall('glob', {})).toBe('Finding files');
    expect(summarizeToolCall('web_search', {})).toBe('Searching the web');
    expect(summarizeToolCall('webfetch', { url: 'https://example.com/x?y=1' })).toBe(
      'Fetching example.com',
    );
    expect(summarizeToolCall('bash', {})).toBe('Running command');
    expect(summarizeToolCall('task', {})).toBe('Delegating');
    expect(summarizeToolCall('todo', {})).toBe('Updating todos');
    expect(summarizeToolCall('ask_user_question', {})).toBe('Asking you');
    expect(summarizeToolCall('mcp__srv__custom_thing', {})).toBe('Using custom_thing');
  });

  it('truncates to 120 chars with an ellipsis', () => {
    const out = summarizeToolCall('eval', { summary: 'x'.repeat(300) });
    expect(out).toHaveLength(120);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('paths', () => {
  it('builds the session dir slug', () => {
    expect(omoSessionDir('/Users/kristianvastveit/projects/pixel-agents', '/r')).toBe(
      path.join('/r', '--Users-kristianvastveit-projects-pixel-agents--'),
    );
  });

  it('honours OMO_CODING_AGENT_DIR', () => {
    const prev = process.env.OMO_CODING_AGENT_DIR;
    try {
      process.env.OMO_CODING_AGENT_DIR = '/custom';
      expect(omoSessionsRoot('/home/u')).toBe(path.join('/custom', 'sessions'));
      delete process.env.OMO_CODING_AGENT_DIR;
      expect(omoSessionsRoot('/home/u')).toBe(path.join('/home/u', '.omo', 'agent', 'sessions'));
    } finally {
      if (prev === undefined) delete process.env.OMO_CODING_AGENT_DIR;
      else process.env.OMO_CODING_AGENT_DIR = prev;
    }
  });
});

describe('listOmoTranscripts', () => {
  function write(name: string, content: string, mtimeSec: number): string {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, content);
    fs.utimesSync(p, mtimeSec, mtimeSec);
    return p;
  }

  it('returns [] for a missing dir', () => {
    expect(listOmoTranscripts(path.join(tmp, 'nope'))).toEqual([]);
  });

  it('lists only top-level jsonl newest first with the latest session name', () => {
    const now = Math.floor(Date.now() / 1000);
    const old = write(
      'old.jsonl',
      line({ type: 'session_info', name: 'first' }) +
        line({ type: 'session_info', name: 'renamed' }),
      now - 1000,
    );
    const fresh = write('new.jsonl', sessionLine, now - 10);
    write('meta.json', '{}', now);
    fs.mkdirSync(path.join(tmp, 'x-artifacts'));
    write(path.join('x-artifacts', 'inner.jsonl'), sessionLine, now);

    const out = listOmoTranscripts(tmp);
    expect(out.map((c) => c.path)).toEqual([fresh, old]);
    expect(out[0].sessionName).toBeUndefined();
    expect(out[1].sessionName).toBe('renamed');
  });

  it('filters by maxAgeMs', () => {
    const now = Math.floor(Date.now() / 1000);
    write('old.jsonl', sessionLine, now - 100_000);
    const fresh = write('new.jsonl', sessionLine, now);
    expect(listOmoTranscripts(tmp, { maxAgeMs: 60_000 }).map((c) => c.path)).toEqual([fresh]);
  });

  it('falls back to a full scan when the name is outside the tail window', () => {
    const padding = line({ type: 'noise', text: 'p'.repeat(1000) }).repeat(400);
    const p = write('big.jsonl', line({ type: 'session_info', name: 'early' }) + padding, 1000);
    expect(listOmoTranscripts(tmp).find((c) => c.path === p)?.sessionName).toBe('early');
  });
});

describe('matchPanesToSessions', () => {
  const c = (p: string, mtimeMs: number, sessionName?: string): OmoTranscriptCandidate => ({
    path: p,
    mtimeMs,
    sessionName,
  });
  const byCwd: Record<string, OmoTranscriptCandidate[]> = {
    '/a': [c('/a/3', 3, 'three'), c('/a/2', 2, 'two'), c('/a/1', 1)],
    '/b': [c('/b/1', 1)],
  };
  const candidatesFor = (cwd: string): OmoTranscriptCandidate[] => byCwd[cwd] ?? [];

  it('matches by name hint first, then newest unused per cwd', () => {
    const map = matchPanesToSessions(
      [
        { paneId: 'p1', cwd: '/a' },
        { paneId: 'p2', cwd: '/a', sessionNameHint: 'two' },
        { paneId: 'p3', cwd: '/a' },
        { paneId: 'p4', cwd: '/a' },
        { paneId: 'p5', cwd: '/b', sessionNameHint: 'missing' },
        { paneId: 'p6', cwd: '/none' },
      ],
      candidatesFor,
    );
    expect(Object.fromEntries(map)).toEqual({
      p2: '/a/2',
      p1: '/a/3',
      p3: '/a/1',
      p5: '/b/1',
    });
    expect(map.has('p4')).toBe(false);
    expect(map.has('p6')).toBe(false);
  });
});
