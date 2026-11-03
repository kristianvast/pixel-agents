import * as path from 'path';

import type { AgentStateStore } from '../../agentStateStore.js';
import type { AgentState } from '../../types.js';
import type { HerdrOmoAgent } from './herdrClient.js';
import type { OmoSessionEvent, OmoSessionSnapshot, OmoToolActivity } from './omoSessionReader.js';

export function endOmoTool(store: AgentStateStore, agent: AgentState, toolId: string): void {
  if (!agent.activeToolIds.delete(toolId)) return;
  agent.activeToolStatuses.delete(toolId);
  agent.activeToolNames.delete(toolId);
  agent.backgroundAgentToolIds.delete(toolId);
  store.broadcast({ type: 'agentToolDone', id: agent.id, toolId });
}

function startTool(store: AgentStateStore, agent: AgentState, tool: OmoToolActivity): void {
  const toolName = tool.toolName.replace(/^mcp__.+?__/, '');
  agent.activeToolIds.add(tool.toolCallId);
  agent.activeToolStatuses.set(tool.toolCallId, tool.summary);
  agent.activeToolNames.set(tool.toolCallId, toolName);
  if (toolName === 'task' && tool.runInBackground) {
    agent.backgroundAgentToolIds.add(tool.toolCallId);
  }
  agent.hadToolsInTurn = true;
  store.broadcast({
    type: 'agentToolStart',
    id: agent.id,
    toolId: tool.toolCallId,
    toolName,
    status: tool.summary,
    runInBackground: tool.runInBackground,
  });
}

export function clearOmoTools(store: AgentStateStore, agent: AgentState): void {
  for (const toolId of agent.activeToolIds) endOmoTool(store, agent, toolId);
  store.broadcast({ type: 'agentToolsClear', id: agent.id });
}

/** Completed background calls remain visible while their children are alive. */
export function applyOmoEvent(
  store: AgentStateStore,
  agent: AgentState,
  state: { event: OmoSessionEvent; kept: Set<string>; snapshot: OmoSessionSnapshot },
): void {
  const { event, kept, snapshot } = state;
  switch (event.kind) {
    case 'toolStart':
      startTool(store, agent, event.tool);
      break;
    case 'toolEnd':
      if (
        agent.backgroundAgentToolIds.has(event.toolCallId) &&
        snapshot.waitingOn.children >= kept.size + 1
      ) {
        kept.add(event.toolCallId);
      } else {
        endOmoTool(store, agent, event.toolCallId);
      }
      break;
    case 'turnEnd':
      // Status is decided by syncOmoSnapshot after the whole poll, so a
      // lifecycle record that follows agent_end (e.g. waiting_children) wins
      // without a waiting -> active blink.
      clearOmoTools(store, agent);
      kept.clear();
      break;
    case 'lifecycle': {
      const terminal = ['done', 'idle', 'failed', 'paused'].includes(event.lifecycle);
      const count = terminal ? 0 : event.waitingOn.children;
      for (const toolId of kept) {
        if (kept.size <= count) break;
        kept.delete(toolId);
        endOmoTool(store, agent, toolId);
      }
      if (terminal) clearOmoTools(store, agent);
      break;
    }
    case 'turnStart':
    case 'sessionName':
      break;
  }
}

export function syncOmoSnapshot(
  store: AgentStateStore,
  agent: AgentState,
  state: { pane: HerdrOmoAgent; snapshot: OmoSessionSnapshot; turnEnded: boolean },
): void {
  const { pane, snapshot, turnEnded } = state;
  const awaitingInput = pane.status === 'blocked' || snapshot.lifecycle === 'waiting_human';
  const waiting =
    awaitingInput || turnEnded || ['done', 'idle', 'failed', 'paused'].includes(snapshot.lifecycle);
  if (agent.isWaiting !== waiting || agent.awaitingInput !== awaitingInput) {
    agent.isWaiting = waiting;
    agent.awaitingInput = awaitingInput;
    store.broadcast({
      type: 'agentStatus',
      id: agent.id,
      status: waiting ? 'waiting' : 'active',
      awaitingInput,
    });
  }
  store.setOmoInfo(agent.id, {
    type: 'agentOmoInfo',
    id: agent.id,
    workspaceId: pane.workspaceId,
    paneId: pane.paneId,
    sessionName: snapshot.sessionName ?? pane.sessionNameHint ?? path.basename(pane.cwd),
    activity: snapshot.lastSummary,
    lifecycle: snapshot.lifecycle,
    waitingOn: snapshot.waitingOn,
    herdrStatus: pane.status,
  });
}

export function seedOmoTools(
  store: AgentStateStore,
  agent: AgentState,
  tools: OmoToolActivity[],
): void {
  for (const tool of tools) startTool(store, agent, tool);
}
