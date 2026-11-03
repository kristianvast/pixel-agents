# omo + herdr source (fork: kristianvast/pixel-agents, branch `omo-herdr`)

This fork drives the office from **omo agents running in herdr panes** instead of Claude Code transcripts.
One herdr Workspace = one room. One omo agent (a herdr pane whose `agent` is `omo`) = one character.

## Data sources (verified on a live machine, herdr 0.9.5, omo 5.1.56)

### herdr: `herdr api snapshot` (JSON on stdout)

`result.snapshot` keys: `agents, focused_pane_id, focused_tab_id, focused_workspace_id, layouts, panes, protocol, tabs, version, workspaces`.

```json
// result.snapshot.workspaces[i]
{"active_tab_id":"wA:tK","agent_status":"idle","focused":false,"label":"~","number":1,"pane_count":5,"tab_count":5,"workspace_id":"wA"}
// result.snapshot.agents[i]
{"agent":"omo","agent_status":"idle","completion_seq":3264,"cwd":"/Users/kristianvastveit","focused":false,
 "foreground_cwd":"/Users/kristianvastveit","pane_id":"wA:p2","revision":113,"state_change_seq":3264,"tab_id":"wA:t2",
 "terminal_id":"term_65f50ae2ab3bb69","terminal_title":"OmO - Herdr Mac keybinds like Hyprland - kristianvastveit",
 "terminal_title_stripped":"OmO - Herdr Mac keybinds like Hyprland - kristianvastveit","workspace_id":"wA"}
```

- `agent_status`: `idle | working | blocked | done | unknown`. `blocked` = herdr recognised an approval/question UI.
- Only agents with `agent === "omo"` are characters. Other agents (claude, codex, ...) are ignored in this fork.
- Focus a pane: `herdr agent focus <pane_id>` (JSON result). The CLI must run with the herdr env: `HERDR_SOCKET_PATH` is inherited when the server is launched from a herdr pane; when absent, the CLI uses the default socket `~/.config/herdr/herdr.sock`.
- `terminal_title` format: `OmO - <omo session name> - <basename(cwd)>`.

### omo: session JSONL

Path: `~/.omo/agent/sessions/<slug>/<ISO-timestamp>_<sessionId>.jsonl`, where `<slug>` = `--` + cwd with every `/` replaced by `-`, minus the leading `-`, + `--`.
Example: cwd `/Users/kristianvastveit/projects/pixel-agents` -> `--Users-kristianvastveit-projects-pixel-agents--`. Sibling `*-artifacts/` dirs and `*.json` files are NOT transcripts. The file is append-only, one JSON object per line.

Records that matter (all others are ignored):

```json
{"type":"session","version":3,"id":"<sessionId>","timestamp":"...","cwd":"/abs/cwd"}            // first line
{"type":"session_info","name":"Test omo agents in herdr workspaces", ...}                       // session title; latest wins
{"type":"custom","customType":"session-lifecycle","data":{"state":"running","runActive":true,
  "role":"root","sessionId":"...","waitingOn":{"children":0,"background":[{"source":"...","activeCount":1,"items":[...]}],"human":[{"kind":"question",...}]}}}
{"type":"custom","customType":"oppi-lifecycle","data":{"version":1,"event":"agent_start"}}
   // events: agent_start, turn_start{turnIndex}, turn_end{turnIndex}, agent_end, agent_settled,
   //         tool_execution_start{toolCallId,toolName}, tool_execution_end{toolCallId,toolName,isError}
{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","id":"toolu_...","name":"eval",
  "arguments":{"language":"js","summary":"Installing Blender via Homebrew ...","code":"..."}}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","id":"toolu_...","name":"task",
  "arguments":{"category":"deep-low","description":"World Labs client","task_summary":"Build stdlib World Labs CLI","run_in_background":"True","prompt":"..."}}]}}
```

- Lifecycle `state` values observed across ~26k records: `running, waiting_background, waiting_children, waiting_human, done, paused, failed`. Latest record wins.
- `waitingOn` counts for the wire: `children` (number), `background` = sum of `activeCount` over the array, `human` = array length.
- **omo summaries** = per tool call, first non-empty of `arguments.summary`, `arguments.task_summary`, `arguments.description`; otherwise a humanised tool name (e.g. `eval` -> "Running code", `read` -> "Reading <basename(path)>", `edit`/`write` -> "Editing <basename(path)>", `task` -> "Delegating"). Tool names may carry an `mcp__custom-tools__` prefix; strip it.
- The character label is `session_info.name` (fallback: basename of cwd).

### pane <-> session matching

For each herdr omo agent: candidates = transcript files in `<slug(agent.cwd)>`, newest mtime first. Pick the candidate whose latest `session_info.name` equals the middle part of `terminal_title_stripped` (strip leading `OmO - ` and trailing ` - <basename(cwd)>`). Else pick the newest candidate not already matched to another pane. Re-evaluate on every poll (a pane can start a new session). No candidate -> character still exists with lifecycle `idle`.

## Wire contract (already in `core/asyncapi.yaml`, generated into `core/src/messages.ts`)

- `workspacesLoaded { workspaces: HerdrWorkspace[] }`, `HerdrWorkspace { id, label, number, focused }`. Sent after `webviewReady` and on any change.
- `agentOmoInfo { id, workspaceId, paneId, sessionName?, activity?, lifecycle: OmoLifecycle, waitingOn: {children, background, human}, herdrStatus? }`. Full value every time, sent after `agentCreated` and on any change.
- `OmoLifecycle` = `running | waiting_background | waiting_children | waiting_human | done | paused | failed | idle`.
- Existing messages keep their meaning: `agentCreated`/`agentClosed` per herdr omo pane; `agentToolStart{status}` carries the omo summary as `status`; `agentToolDone`; `agentStatus{status: active|waiting, awaitingInput}`; `focusAgent{id}` from the client -> server runs `herdr agent focus <paneId>`.
- `providerCapabilities` for the omo source: `readingTools: ["read","grep","glob","web_search","webfetch"]`, `subagentToolNames: ["task"]`.

## Behaviour mapping (server -> what the office shows)

| omo / herdr                                | `agentStatus`               | character                                                                 |
| ------------------------------------------ | --------------------------- | ------------------------------------------------------------------------- |
| lifecycle `running` with an active tool    | active                      | at desk, typing (reading for readingTools), bubble = omo summary          |
| `running`, no active tool (model thinking) | active                      | at desk, typing, bubble = last summary                                    |
| `waiting_children`                         | active                      | at desk, "Waiting on N agents" badge; `task` sub-agent characters visible |
| `waiting_background`                       | active                      | at desk, "Waiting on background" badge                                    |
| `waiting_human` or herdr `blocked`         | waiting, awaitingInput=true | "Needs you" bubble + sound                                                |
| `done` / `idle` / herdr `idle`/`done`      | waiting                     | turn ended: wanders inside its own room                                   |
| `paused`                                   | waiting                     | "Paused" badge                                                            |
| `failed`                                   | waiting                     | "Failed" badge (red)                                                      |

## Rooms

The client builds the office from `workspacesLoaded`: one room per Workspace in `number` order, laid out on a grid, each with a name plate (workspace label) and enough desk seats for its agents (min 4, grows when more). Characters sit and wander only in their own room. The generated layout replaces the saved layout while the omo source is active (no layout editing of generated rooms in v1).

## Mode selection

`npx pixel-agents` / `node dist/cli.js` picks the source with `--source omo|claude` (default `omo` in this fork when the `herdr` binary resolves on PATH, else `claude`). The omo source disables the Claude JSONL project/external scanners and hook-consent prompts, so omo's own `claude` child transcripts never appear as duplicate characters.
