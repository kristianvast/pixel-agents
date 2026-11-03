import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  HerdrSnapshotError,
  parseHerdrSnapshot,
  resolveHerdrBin,
  sessionNameFromTitle,
} from '../src/providers/omo/herdrClient.js';

function agent(over: Record<string, unknown>): Record<string, unknown> {
  return {
    agent: 'omo',
    agent_status: 'idle',
    completion_seq: 1,
    cwd: '/Users/kv',
    focused: false,
    foreground_cwd: '/Users/kv',
    pane_id: 'wA:p2',
    revision: 1,
    state_change_seq: 1,
    tab_id: 'wA:t2',
    terminal_id: 'term_1',
    terminal_title: 'OmO - Some name - kv',
    terminal_title_stripped: 'OmO - Some name - kv',
    workspace_id: 'wA',
    ...over,
  };
}

function workspace(over: Record<string, unknown>): Record<string, unknown> {
  return {
    active_tab_id: 'wA:tK',
    agent_status: 'idle',
    focused: false,
    label: '~',
    number: 1,
    pane_count: 5,
    tab_count: 5,
    workspace_id: 'wA',
    ...over,
  };
}

function snap(workspaces: unknown[], agents: unknown[]): unknown {
  return { id: 'x', result: { snapshot: { workspaces, agents } } };
}

describe('parseHerdrSnapshot', () => {
  it('keeps only omo agents and sorts workspaces by number', () => {
    const out = parseHerdrSnapshot(
      snap(
        [
          workspace({ workspace_id: 'wB', number: 2, label: 'b' }),
          workspace({ workspace_id: 'wA', number: 1, focused: true }),
        ],
        [agent({}), agent({ agent: 'claude', pane_id: 'wA:p3' })],
      ),
    );
    expect(out.workspaces.map((w) => w.id)).toEqual(['wA', 'wB']);
    expect(out.workspaces[0]).toEqual({ id: 'wA', label: '~', number: 1, focused: true });
    expect(out.agents).toHaveLength(1);
    expect(out.agents[0]).toMatchObject({
      paneId: 'wA:p2',
      workspaceId: 'wA',
      tabId: 'wA:t2',
      status: 'idle',
      sessionNameHint: 'Some name',
      focused: false,
    });
  });

  it('maps known statuses and falls back to unknown', () => {
    const out = parseHerdrSnapshot(
      snap(
        [],
        [
          agent({ pane_id: 'p1', agent_status: 'working' }),
          agent({ pane_id: 'p2', agent_status: 'blocked' }),
          agent({ pane_id: 'p3', agent_status: 'done' }),
          agent({ pane_id: 'p4', agent_status: 'weird' }),
        ],
      ),
    );
    expect(out.agents.map((a) => a.status)).toEqual(['working', 'blocked', 'done', 'unknown']);
  });

  it('prefers foreground_cwd over cwd', () => {
    const out = parseHerdrSnapshot(
      snap(
        [],
        [
          agent({ cwd: '/a', foreground_cwd: '/b' }),
          agent({ cwd: '/a', foreground_cwd: undefined }),
        ],
      ),
    );
    expect(out.agents.map((a) => a.cwd)).toEqual(['/b', '/a']);
  });

  it('throws HerdrSnapshotError on malformed input', () => {
    expect(() => parseHerdrSnapshot(null)).toThrow(HerdrSnapshotError);
    expect(() => parseHerdrSnapshot({ result: {} })).toThrow(HerdrSnapshotError);
    expect(() =>
      parseHerdrSnapshot({ result: { snapshot: { workspaces: {}, agents: [] } } }),
    ).toThrow(HerdrSnapshotError);
    expect(() => parseHerdrSnapshot(snap([], [agent({ pane_id: 5 })]))).toThrow(HerdrSnapshotError);
    expect(() => parseHerdrSnapshot(snap([workspace({ number: 'x' })], []))).toThrow(
      HerdrSnapshotError,
    );
  });
});

describe('sessionNameFromTitle', () => {
  it('extracts the name between prefix and basename', () => {
    expect(
      sessionNameFromTitle(
        'OmO - Herdr Mac keybinds - kristianvastveit',
        '/Users/kristianvastveit',
      ),
    ).toBe('Herdr Mac keybinds');
  });

  it('keeps " - " inside the name', () => {
    expect(sessionNameFromTitle('OmO - a - b - proj', '/x/proj')).toBe('a - b');
  });

  it('handles a title without the trailing basename', () => {
    expect(sessionNameFromTitle('OmO - Just a name', '/x/proj')).toBe('Just a name');
  });

  it('returns undefined for non-omo titles or an empty name', () => {
    expect(sessionNameFromTitle('claude - foo - proj', '/x/proj')).toBeUndefined();
    expect(sessionNameFromTitle('OmO - ', '/x/proj')).toBeUndefined();
    expect(sessionNameFromTitle('OmO -  - proj', '/x/proj')).toBeUndefined();
  });
});

describe('resolveHerdrBin', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-bin-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('prefers an existing HERDR_BIN_PATH', () => {
    const bin = path.join(dir, 'custom');
    fs.writeFileSync(bin, '');
    expect(resolveHerdrBin({ HERDR_BIN_PATH: bin, PATH: '' })).toBe(bin);
  });

  it('falls back to herdr on PATH when HERDR_BIN_PATH is missing on disk', () => {
    const bin = path.join(dir, 'herdr');
    fs.writeFileSync(bin, '');
    expect(resolveHerdrBin({ HERDR_BIN_PATH: path.join(dir, 'nope'), PATH: dir })).toBe(bin);
  });

  it('returns undefined when nothing resolves', () => {
    expect(resolveHerdrBin({ PATH: dir })).toBeUndefined();
  });
});
