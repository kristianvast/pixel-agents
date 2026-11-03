import { Fragment, useEffect, useRef, useState } from 'react';

import { Button } from '../../components/ui/Button.js';
import {
  BUBBLE_FADE_DURATION_SEC,
  BUBBLE_SITTING_OFFSET_PX,
  BUBBLE_VERTICAL_OFFSET_PX,
  CHARACTER_SITTING_OFFSET_PX,
  CONTEXT_CRITICAL_THRESHOLD,
  CONTEXT_DANGER_THRESHOLD,
  CONTEXT_GAUGE_BG,
  CONTEXT_GAUGE_COLOR_CRITICAL,
  CONTEXT_GAUGE_COLOR_DANGER,
  CONTEXT_GAUGE_COLOR_OK,
  CONTEXT_GAUGE_COLOR_WARN,
  CONTEXT_GAUGE_HEIGHT_PX,
  CONTEXT_GAUGE_WIDTH_PX,
  CONTEXT_WARN_THRESHOLD,
  OMO_BADGE_FAILED_BG,
  OMO_BADGE_FAILED_COLOR,
  OMO_BADGE_NEEDS_YOU_BG,
  OMO_BADGE_NEEDS_YOU_COLOR,
  OMO_BADGE_PAUSED_BG,
  OMO_BADGE_PAUSED_COLOR,
  OMO_BADGE_WAITING_BG,
  OMO_BADGE_WAITING_COLOR,
  OMO_FAILED_TEXT,
  OMO_NEEDS_YOU_TEXT,
  OMO_PAUSED_TEXT,
  OMO_SESSION_NAME_COLOR,
  OMO_WAITING_BACKGROUND_TEXT,
  OVERLAY_BUBBLE_Z_INDEX,
  OVERLAY_LABEL_SELECTED_Z_INDEX,
  OVERLAY_LABEL_Z_INDEX,
  TEAM_LEAD_COLOR,
  TEAM_ROLE_COLOR,
  TOOL_OVERLAY_BASE_LIFT_PX,
  TOOL_OVERLAY_EXTRA_LIFT_PX,
  TOOL_OVERLAY_OMO_LIFT_PX,
  TOOL_OVERLAY_VERTICAL_OFFSET,
} from '../../constants.js';
import type { AgentOmoState, SubagentCharacter } from '../../hooks/useExtensionMessages.js';
import type { OfficeState } from '../engine/officeState.js';
import { overlayProjection } from '../projection.js';
import { getCachedSprite } from '../sprites/spriteCache.js';
import { BUBBLE_PERMISSION_SPRITE, BUBBLE_WAITING_SPRITE } from '../sprites/spriteData.js';
import type { Character, ToolActivity } from '../types.js';
import { CharacterState } from '../types.js';

// Both turn-end states show the green checkmark bubble. A finished turn (Stop)
// shows ONLY the checkmark (the label falls through to its normal idle text);
// going idle waiting on the user (Notification(idle_prompt)) additionally
// surfaces this label. Driven by Character.waitingAwaitingInput.
const WAITING_INPUT_ACTIVITY_TEXT = 'Waiting for input';

interface ToolOverlayProps {
  officeState: OfficeState;
  agents: number[];
  agentTools: Record<number, ToolActivity[]>;
  agentOmoInfos?: Record<number, AgentOmoState>;
  subagentTools: Record<number, Record<string, ToolActivity[]>>;
  subagentCharacters: SubagentCharacter[];
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
  onCloseAgent: (id: number) => void;
  alwaysShowOverlay: boolean;
}

interface OmoBadgeInfo {
  text: string;
  color: string;
  bg: string;
  isNeedsYou?: boolean;
}

function getOmoBadge(ch: Character, omoInfo?: AgentOmoState): OmoBadgeInfo | null {
  const lifecycle = omoInfo?.lifecycle ?? ch.omoLifecycle;
  const waitingOn = omoInfo?.waitingOn ?? ch.omoWaitingOn;
  const herdrStatus = omoInfo?.herdrStatus ?? ch.herdrStatus;

  if (lifecycle === 'waiting_human' || herdrStatus === 'blocked') {
    return {
      text: OMO_NEEDS_YOU_TEXT,
      color: OMO_BADGE_NEEDS_YOU_COLOR,
      bg: OMO_BADGE_NEEDS_YOU_BG,
      isNeedsYou: true,
    };
  }
  if (lifecycle === 'waiting_children') {
    const count = waitingOn?.children ?? 0;
    return {
      text: `Waiting on ${count} agents`,
      color: OMO_BADGE_WAITING_COLOR,
      bg: OMO_BADGE_WAITING_BG,
    };
  }
  if (lifecycle === 'waiting_background') {
    return {
      text: OMO_WAITING_BACKGROUND_TEXT,
      color: OMO_BADGE_WAITING_COLOR,
      bg: OMO_BADGE_WAITING_BG,
    };
  }
  if (lifecycle === 'paused') {
    return {
      text: OMO_PAUSED_TEXT,
      color: OMO_BADGE_PAUSED_COLOR,
      bg: OMO_BADGE_PAUSED_BG,
    };
  }
  if (lifecycle === 'failed') {
    return {
      text: OMO_FAILED_TEXT,
      color: OMO_BADGE_FAILED_COLOR,
      bg: OMO_BADGE_FAILED_BG,
    };
  }
  return null;
}

/** Derive a short human-readable activity string from tools/status */
function getActivityText(
  agentId: number,
  agentTools: Record<number, ToolActivity[]>,
  isActive: boolean,
  bubbleType: 'permission' | 'waiting' | null,
  waitingAwaitingInput: boolean,
  ch: Character,
  omoInfo?: AgentOmoState,
): string {
  const lifecycle = omoInfo?.lifecycle ?? ch.omoLifecycle;
  const herdrStatus = omoInfo?.herdrStatus ?? ch.herdrStatus;
  const omoActivity = omoInfo?.activity ?? ch.omoActivity;
  const isOmo = Boolean(lifecycle || omoInfo || ch.workspaceId);

  if (lifecycle === 'waiting_human' || herdrStatus === 'blocked') {
    return OMO_NEEDS_YOU_TEXT;
  }
  if (bubbleType === 'permission') {
    return isOmo ? OMO_NEEDS_YOU_TEXT : 'Needs approval';
  }
  // Only the idle case ("Waiting for input") gets a dedicated label. A finished
  // turn (Stop, waitingAwaitingInput=false) falls through so the checkmark alone
  // signals "done", same as the original behavior.
  if (bubbleType === 'waiting' && waitingAwaitingInput) {
    return isOmo ? OMO_NEEDS_YOU_TEXT : WAITING_INPUT_ACTIVITY_TEXT;
  }

  const tools = agentTools[agentId];
  if (tools && tools.length > 0) {
    // Find the latest non-done tool
    const activeTool = [...tools].reverse().find((t) => !t.done);
    if (activeTool) {
      if (activeTool.permissionWait) return isOmo ? OMO_NEEDS_YOU_TEXT : 'Needs approval';
      return activeTool.status;
    }
    if (lifecycle === 'running' && omoActivity) {
      return omoActivity;
    }
    // All tools done but agent still active (mid-turn) — keep showing last tool status
    if (isActive) {
      const lastTool = tools[tools.length - 1];
      if (lastTool) return lastTool.status;
    }
  }

  if (lifecycle === 'running') {
    return omoActivity || 'Thinking...';
  }

  const badge = getOmoBadge(ch, omoInfo);
  if (badge) {
    return badge.text;
  }

  return 'Idle';
}

function getFuelColor(ratio: number): string {
  if (ratio >= CONTEXT_CRITICAL_THRESHOLD) return CONTEXT_GAUGE_COLOR_CRITICAL;
  if (ratio >= CONTEXT_DANGER_THRESHOLD) return CONTEXT_GAUGE_COLOR_DANGER;
  if (ratio >= CONTEXT_WARN_THRESHOLD) return CONTEXT_GAUGE_COLOR_WARN;
  return CONTEXT_GAUGE_COLOR_OK;
}

/** A speech-bubble sprite blitted into a DOM canvas. Bubbles live in the DOM
 *  (not the office canvas) so they can stack ABOVE the status label panels —
 *  canvas content can never out-paint the DOM overlay. */
function OverlayBubble({ cached, dpr }: { cached: HTMLCanvasElement; dpr: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = cached.width;
    canvas.height = cached.height;
    canvas.getContext('2d')?.drawImage(cached, 0, 0);
  }, [cached]);
  return (
    <canvas
      ref={canvasRef}
      className="block"
      style={{ width: cached.width / dpr, height: cached.height / dpr }}
    />
  );
}

export function ToolOverlay({
  officeState,
  agents,
  agentTools,
  agentOmoInfos,
  subagentTools,
  subagentCharacters,
  containerRef,
  zoom,
  panRef,
  onCloseAgent,
  alwaysShowOverlay,
}: ToolOverlayProps) {
  const [, setTick] = useState(0);
  useEffect(() => {
    let rafId = 0;
    const tick = () => {
      setTick((n) => n + 1);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  const el = containerRef.current;
  if (!el) return null;
  // dpr is also needed to size the bubble canvases in CSS px (OverlayBubble).
  const dpr = window.devicePixelRatio || 1;
  const project = overlayProjection(
    officeState.getLayout(),
    el.getBoundingClientRect(),
    zoom,
    panRef.current,
    dpr,
  );

  const selectedId = officeState.selectedAgentId;
  const hoveredId = officeState.hoveredAgentId;

  // All character IDs
  const allIds = [...agents, ...subagentCharacters.map((s) => s.id)];

  return (
    <>
      {allIds.map((id) => {
        const ch = officeState.characters.get(id);
        if (!ch) return null;

        const isSelected = selectedId === id;
        const isHovered = hoveredId === id;
        const isSub = ch.isSubagent;
        const omoInfo = !isSub ? agentOmoInfos?.[id] : undefined;
        const omoBadge = !isSub ? getOmoBadge(ch, omoInfo) : null;
        const omoLifecycle = omoInfo?.lifecycle ?? ch.omoLifecycle;
        const isOmoActiveOrBadge =
          Boolean(omoBadge) || omoLifecycle === 'running' || officeState.roomsMode;

        // Speech bubble (permission dots / done checkmark) — rendered here in
        // the DOM, above the label panels (OVERLAY_BUBBLE_Z_INDEX over the label panels), for every
        // character regardless of label visibility. Mirrors the geometry the
        // canvas renderer used. The idle "Waiting for input" state speaks
        // through its label, not a bubble.
        let bubbleNode = null;
        if (ch.bubbleType && !(ch.bubbleType === 'waiting' && ch.waitingAwaitingInput)) {
          const cachedBubble = getCachedSprite(
            ch.bubbleType === 'permission' ? BUBBLE_PERMISSION_SPRITE : BUBBLE_WAITING_SPRITE,
            zoom,
          );
          const bubbleSittingOff = ch.state === CharacterState.TYPE ? BUBBLE_SITTING_OFFSET_PX : 0;
          const alpha =
            ch.bubbleType === 'waiting' && ch.bubbleTimer < BUBBLE_FADE_DURATION_SEC
              ? ch.bubbleTimer / BUBBLE_FADE_DURATION_SEC
              : 1;
          bubbleNode = (
            <div
              className="absolute -translate-x-1/2 pointer-events-none"
              style={{
                left: project.toScreenX(ch.x),
                // Bubble bottom sits one sprite pixel above the character's
                // anchor: project the anchor, then lift by the bubble's own
                // device-pixel height plus one zoomed pixel, in CSS px.
                top:
                  project.toScreenY(ch.y + bubbleSittingOff - BUBBLE_VERTICAL_OFFSET_PX) -
                  (cachedBubble.height + zoom) / dpr,
                opacity: alpha,
                zIndex: OVERLAY_BUBBLE_Z_INDEX,
              }}
            >
              <OverlayBubble cached={cachedBubble} dpr={dpr} />
            </div>
          );
        }

        // Only show the label for hovered or selected agents (unless
        // always-show is on or omo rooms mode / badge is active) — the bubble renders regardless.
        if (!alwaysShowOverlay && !isSelected && !isHovered && !isOmoActiveOrBadge) {
          return bubbleNode && <Fragment key={id}>{bubbleNode}</Fragment>;
        }

        // Position above character
        const sittingOffset = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
        const screenX = project.toScreenX(ch.x);
        const screenY = project.toScreenY(ch.y + sittingOffset - TOOL_OVERLAY_VERTICAL_OFFSET);

        // A "Done" agent (finished turn: waiting bubble without awaitingInput)
        // shows ONLY its floating green checkmark bubble, never the label panel
        // (the panel would cover the bubble). Render an empty positioned marker
        // so overlay counts stay stable and hover/select can still bring the
        // panel back. When always-show is off, the early return above already
        // keeps the panel hidden for idle agents.
        const isDone = ch.bubbleType === 'waiting' && !ch.waitingAwaitingInput && !omoBadge;
        if (isDone && !isSelected && !isHovered && !officeState.roomsMode) {
          return (
            <Fragment key={id}>
              {bubbleNode}
              <div
                className="absolute"
                style={{ left: screenX, top: screenY, pointerEvents: 'none' }}
                data-testid="agent-overlay"
                data-agent-id={id}
              />
            </Fragment>
          );
        }

        // Get activity text
        const hasWaitingBubble = ch.bubbleType === 'waiting';
        const subHasPermission = isSub && ch.bubbleType === 'permission';
        let activityText: string;
        if (hasWaitingBubble && ch.waitingAwaitingInput && !omoBadge) {
          // Idle, waiting on the user -> dedicated label. A finished turn (Stop)
          // shows only the checkmark and falls through to the normal idle text.
          activityText = WAITING_INPUT_ACTIVITY_TEXT;
        } else if (isSub) {
          if (subHasPermission) {
            activityText = 'Needs approval';
          } else {
            // Hover shows the subtask title; SELECTING the sub reveals its live
            // tool activity (watched sub-agents stream it via subagentToolStart).
            const sub = subagentCharacters.find((s) => s.id === id);
            const rows = sub ? subagentTools[sub.parentAgentId]?.[sub.parentToolId] : undefined;
            const activeRow =
              isSelected && rows ? [...rows].reverse().find((t) => !t.done) : undefined;
            activityText = activeRow?.status ?? (sub?.label || 'Subtask');
          }
        } else {
          activityText = getActivityText(
            id,
            agentTools,
            ch.isActive,
            ch.bubbleType,
            ch.waitingAwaitingInput ?? false,
            ch,
            omoInfo,
          );
        }

        // Determine dot color
        const tools = agentTools[id];
        const hasPermission =
          subHasPermission ||
          omoBadge?.isNeedsYou === true ||
          tools?.some((t) => t.permissionWait && !t.done);
        const hasActiveTools = tools?.some((t) => !t.done);
        const isActive = ch.isActive;
        const hasWaiting = ch.bubbleType === 'waiting';

        let dotColor: string | null = null;
        if (omoLifecycle === 'failed') {
          dotColor = 'var(--color-status-error)';
        } else if (hasPermission || hasWaiting) {
          dotColor = 'var(--color-status-permission)';
        } else if (omoBadge) {
          dotColor = omoBadge.color;
        } else if (isActive && (hasActiveTools || omoLifecycle === 'running')) {
          dotColor = 'var(--color-status-active)';
        }

        // Name label: sessionName (fallback existing team/directory label)
        const sessionLabel = omoInfo?.sessionName ?? ch.sessionName;
        const teamRoleLabel = ch.isTeamLead ? 'LEAD' : ch.agentName || null;
        const primaryNameLabel = sessionLabel || teamRoleLabel || ch.directoryName || null;
        const secondaryDirLabel =
          !officeState.roomsMode && (sessionLabel || teamRoleLabel)
            ? ch.directoryName && ch.directoryName !== primaryNameLabel
              ? ch.directoryName
              : null
            : null;
        const showDedicatedBadgePill = Boolean(omoBadge) && activityText !== omoBadge?.text;
        const hasExtraLines = Boolean(
          primaryNameLabel || secondaryDirLabel || showDedicatedBadgePill,
        );
        const labelLiftPx = officeState.roomsMode
          ? TOOL_OVERLAY_OMO_LIFT_PX
          : hasExtraLines
            ? TOOL_OVERLAY_EXTRA_LIFT_PX
            : TOOL_OVERLAY_BASE_LIFT_PX;

        // Context gauge. Every agent gets one — lead, teammate, adopted,
        // headless — as soon as it has taken a turn. Sub-agents never do: they
        // have no session of their own, so contextTokens stays 0.
        const contextRatio = ch.contextTokens / ch.maxContextTokens;
        const showContextGauge = !isSub && ch.contextTokens > 0;

        return (
          <Fragment key={id}>
            {bubbleNode}
            <div
              className="absolute flex flex-col items-center -translate-x-1/2"
              style={{
                left: screenX,
                top: screenY - labelLiftPx,
                pointerEvents: isSelected ? 'auto' : 'none',
                opacity: alwaysShowOverlay && !isSelected && !isHovered ? (isSub ? 0.5 : 0.75) : 1,
                zIndex: isSelected ? OVERLAY_LABEL_SELECTED_Z_INDEX : OVERLAY_LABEL_Z_INDEX,
              }}
              data-testid="agent-overlay"
              data-agent-id={id}
            >
              <div
                className={`flex items-center border-border px-6 pt-2 pb-3 gap-4 pixel-panel whitespace-nowrap ${officeState.roomsMode ? 'max-w-[196px]' : 'max-w-2xs'}`}
              >
                {dotColor && (
                  <span
                    className={`w-6 h-6 rounded-full shrink-0 ${isActive && !hasPermission && !hasWaiting ? 'pixel-pulse' : ''}`}
                    style={{ background: dotColor }}
                  />
                )}
                <div className="flex flex-col gap-0 overflow-hidden">
                  {primaryNameLabel && (
                    <span
                      className="overflow-hidden text-ellipsis block leading-none"
                      style={{
                        fontSize: '18px',
                        color: sessionLabel
                          ? OMO_SESSION_NAME_COLOR
                          : ch.isTeamLead
                            ? TEAM_LEAD_COLOR
                            : teamRoleLabel
                              ? TEAM_ROLE_COLOR
                              : undefined,
                        fontWeight: ch.isTeamLead || sessionLabel ? 'bold' : undefined,
                      }}
                    >
                      {primaryNameLabel}
                    </span>
                  )}
                  <span
                    className="overflow-hidden text-ellipsis block leading-none"
                    style={{
                      fontSize: isSub ? '20px' : '22px',
                      fontStyle: isSub ? 'italic' : undefined,
                      color:
                        omoBadge && activityText === omoBadge.text ? omoBadge.color : undefined,
                      backgroundColor:
                        omoBadge && activityText === omoBadge.text ? omoBadge.bg : undefined,
                      padding: omoBadge && activityText === omoBadge.text ? '1px 4px' : undefined,
                    }}
                    data-testid={omoBadge ? 'agent-omo-badge' : undefined}
                  >
                    {activityText}
                  </span>
                  {showDedicatedBadgePill && omoBadge && (
                    <span
                      className="text-2xs leading-none overflow-hidden text-ellipsis block"
                      style={{
                        color: omoBadge.color,
                        backgroundColor: omoBadge.bg,
                        padding: '1px 4px',
                      }}
                      data-testid="agent-omo-badge"
                    >
                      {omoBadge.text}
                    </span>
                  )}
                  {secondaryDirLabel && (
                    <span className="text-2xs leading-none overflow-hidden text-ellipsis block">
                      {secondaryDirLabel}
                    </span>
                  )}
                </div>
                {isSelected && !isSub && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCloseAgent(id);
                    }}
                    title="Close agent"
                    className="ml-2 shrink-0 leading-none"
                  >
                    ×
                  </Button>
                )}
              </div>
              {showContextGauge && (
                <div
                  style={{
                    width: CONTEXT_GAUGE_WIDTH_PX,
                    height: CONTEXT_GAUGE_HEIGHT_PX,
                    background: CONTEXT_GAUGE_BG,
                    marginTop: 2,
                  }}
                  title={`${Math.round(contextRatio * 100)}% context used (${(ch.contextTokens / 1000).toFixed(0)}k of ${(ch.maxContextTokens / 1000).toFixed(0)}k tokens)`}
                  data-testid="context-gauge"
                  data-context-pct={Math.round(contextRatio * 100)}
                >
                  <div
                    style={{
                      width: `${Math.min(contextRatio * 100, 100)}%`,
                      height: '100%',
                      background: getFuelColor(contextRatio),
                    }}
                  />
                </div>
              )}
            </div>
          </Fragment>
        );
      })}
    </>
  );
}
