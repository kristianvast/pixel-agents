import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { HERDR_EXEC_TIMEOUT_MS, HERDR_MAX_BUFFER_BYTES } from './constants.js';

export type HerdrAgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

export interface HerdrWorkspaceInfo {
  id: string;
  label: string;
  number: number;
  focused: boolean;
}

export interface HerdrOmoAgent {
  paneId: string;
  workspaceId: string;
  tabId: string;
  cwd: string;
  status: HerdrAgentStatus;
  title: string;
  sessionNameHint?: string;
  focused: boolean;
}

export interface HerdrSnapshot {
  workspaces: HerdrWorkspaceInfo[];
  agents: HerdrOmoAgent[];
}

export class HerdrSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HerdrSnapshotError';
  }
}

const KNOWN_STATUSES: readonly HerdrAgentStatus[] = ['idle', 'working', 'blocked', 'done'];
const OMO_TITLE_PREFIX = 'OmO - ';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function reqString(obj: Record<string, unknown>, key: string, what: string): string {
  const v = obj[key];
  if (typeof v !== 'string') throw new HerdrSnapshotError(`${what}.${key} must be a string`);
  return v;
}

function mapStatus(v: unknown): HerdrAgentStatus {
  return KNOWN_STATUSES.find((s) => s === v) ?? 'unknown';
}

/** "OmO - <name> - <basename(cwd)>" -> "<name>"; the trailing basename part is optional. */
export function sessionNameFromTitle(title: string, cwd: string): string | undefined {
  if (!title.startsWith(OMO_TITLE_PREFIX)) return undefined;
  let name = title.slice(OMO_TITLE_PREFIX.length);
  const base = path.basename(cwd);
  const suffix = ` - ${base}`;
  if (base && name.endsWith(suffix)) name = name.slice(0, -suffix.length);
  name = name.trim();
  return name === '' ? undefined : name;
}

export function parseHerdrSnapshot(json: unknown): HerdrSnapshot {
  const result = isRecord(json) ? json.result : undefined;
  const snapshot = isRecord(result) ? result.snapshot : undefined;
  if (!isRecord(snapshot)) throw new HerdrSnapshotError('missing result.snapshot');
  const { workspaces, agents } = snapshot;
  if (!Array.isArray(workspaces)) throw new HerdrSnapshotError('snapshot.workspaces not an array');
  if (!Array.isArray(agents)) throw new HerdrSnapshotError('snapshot.agents not an array');

  const outWorkspaces = workspaces.map((w): HerdrWorkspaceInfo => {
    if (!isRecord(w)) throw new HerdrSnapshotError('workspace entry not an object');
    if (typeof w.number !== 'number') throw new HerdrSnapshotError('workspace.number not a number');
    return {
      id: reqString(w, 'workspace_id', 'workspace'),
      label: reqString(w, 'label', 'workspace'),
      number: w.number,
      focused: w.focused === true,
    };
  });
  outWorkspaces.sort((a, b) => a.number - b.number);

  const outAgents: HerdrOmoAgent[] = [];
  for (const a of agents) {
    if (!isRecord(a)) throw new HerdrSnapshotError('agent entry not an object');
    if (a.agent !== 'omo') continue;
    const cwd =
      typeof a.foreground_cwd === 'string' && a.foreground_cwd !== ''
        ? a.foreground_cwd
        : reqString(a, 'cwd', 'agent');
    const rawTitle = a.terminal_title_stripped ?? a.terminal_title;
    const title = typeof rawTitle === 'string' ? rawTitle : '';
    const hint = sessionNameFromTitle(title, cwd);
    const agent: HerdrOmoAgent = {
      paneId: reqString(a, 'pane_id', 'agent'),
      workspaceId: reqString(a, 'workspace_id', 'agent'),
      tabId: reqString(a, 'tab_id', 'agent'),
      cwd,
      status: mapStatus(a.agent_status),
      title,
      focused: a.focused === true,
    };
    if (hint !== undefined) agent.sessionNameHint = hint;
    outAgents.push(agent);
  }

  return { workspaces: outWorkspaces, agents: outAgents };
}

export function resolveHerdrBin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.HERDR_BIN_PATH;
  if (explicit && fs.existsSync(explicit)) return explicit;
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'herdr');
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

interface HerdrExecOpts {
  bin?: string;
  timeoutMs?: number;
}

function runHerdr(args: string[], opts: HerdrExecOpts | undefined): Promise<string> {
  const bin = opts?.bin ?? resolveHerdrBin();
  if (!bin) return Promise.reject(new Error('herdr binary not found'));
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: opts?.timeoutMs ?? HERDR_EXEC_TIMEOUT_MS, maxBuffer: HERDR_MAX_BUFFER_BYTES },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr).trim();
          reject(new Error(detail || err.message));
          return;
        }
        resolve(String(stdout));
      },
    );
  });
}

export async function readHerdrSnapshot(opts?: HerdrExecOpts): Promise<HerdrSnapshot> {
  const stdout = await runHerdr(['api', 'snapshot'], opts);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new HerdrSnapshotError('herdr api snapshot returned invalid JSON');
  }
  return parseHerdrSnapshot(parsed);
}

export async function focusHerdrPane(paneId: string, opts?: HerdrExecOpts): Promise<void> {
  await runHerdr(['agent', 'focus', paneId], opts);
}
