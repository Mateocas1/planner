/**
 * The chat surface (task C3a; ronda4 T4): the composition layer between App's
 * single mount point and the ChatPanel. It owns everything C3 wires — the
 * real Tauri transport on desktop, the planner snapshot feed, the memory
 * backend (Rust file on desktop, in-memory behind `?chatMock`) and the
 * end-of-conversation extraction — while the panel keeps its own look and
 * motion. App renders this instead of ChatPanel directly; on the web without
 * `?chatMock` no transport exists and the panel falls back to its unwired
 * error transport, exactly as before C3a.
 *
 * Freshness (ronda4 S4 diagnosis): every request and every confirm rebuilds
 * its view of the planner from the live snapshot, the live clock and the live
 * notes — never from a value frozen at some earlier render. The latest
 * snapshot, zone and notes are mirrored into refs on every render, and the
 * prompt builder, the tool-validation context and the read executor read
 * those refs at call time, so a request sent right after a data change (or a
 * card confirmed minutes after it was proposed) sees the planner as it is
 * now, and `todayKey` can never go stale across midnight.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatPanel, type ToolOutcome } from "../ui/ChatPanel.tsx";
import { moveTaskWithBlock, createChatTask } from "../data/chatMove.ts";
import { db } from "../data/client.ts";
import { isTauri } from "../desktop.ts";
import { formatDateKey } from "../ui/format.ts";
import { dateKey, localValue, toZonedInstant } from "../ui/time.ts";
import { getChatModel, mockMode } from "./config.ts";
import type { ChatTurn } from "./conversation.ts";
import { createInMemoryMemoryBackend, tauriMemoryBackend, type ChatMemoryBackend } from "./memoryBackend.ts";
import { buildExtractionRequest, parseMemoryOps } from "./memoryExtract.ts";
import type { Memory } from "./memoryStore.ts";
import { createMockTransport } from "./mockTransport.ts";
import { buildSystemPrompt } from "./systemPrompt.ts";
import {
  buildGetTaskResult,
  buildListHolidaysResult,
  buildListMemoriesResult,
  buildListTasksResult,
  isReadTool,
  validateToolCall,
  type ChatToolContext,
  type NormalizedCreateTask,
  type NormalizedGetTask,
  type NormalizedListTasks,
  type NormalizedMoveTask,
  type ReadResult,
} from "./tools.ts";
import { setChatReadExecutor, type ChatReadOutcome } from "./readTools.ts";
import { createTauriChatTransport } from "./tauriTransport.ts";
import type { ChatToolCall, ChatTransport } from "./types.ts";
import { usePlannerSnapshot } from "./usePlannerSnapshot.ts";

export function ChatSurface({
  signedIn,
  uid,
  onSetupKey,
}: {
  signedIn: boolean;
  uid: string | null;
  onSetupKey?: () => void;
}) {
  const [mockQuery] = useState(() => new URLSearchParams(window.location.search).get("chatMock"));
  const mock = mockQuery !== null;
  const desktop = isTauri();

  // Read-only planner context (S4), refetched through the app's own data hooks.
  const { snapshot, timeZone } = usePlannerSnapshot(uid);

  const transport = useMemo<ChatTransport | null>(() => {
    if (mock) return createMockTransport(mockMode(mockQuery));
    if (desktop) return createTauriChatTransport();
    return null;
  }, [mock, mockQuery, desktop]);

  const backend = useMemo<ChatMemoryBackend>(() => (mock ? createInMemoryMemoryBackend() : tauriMemoryBackend), [mock]);

  const [memories, setMemories] = useState<Memory[]>([]);
  /** Mirrors `memories` so the prompt builder reads fresh notes per request
   * without re-creating `startStream` on every apply. */
  const memoriesRef = useRef<Memory[]>([]);
  const setLatestMemories = useCallback((list: Memory[]) => {
    memoriesRef.current = list;
    setMemories(list);
  }, []);

  const refreshMemories = useCallback(async () => {
    try {
      setLatestMemories(await backend.list());
    } catch (error) {
      // Silent to the user (spec S5): the chat works without notes.
      console.warn("chat: loading memories failed", error);
    }
  }, [backend, setLatestMemories]);
  useEffect(() => {
    void refreshMemories();
  }, [refreshMemories]);

  // The live view of the planner, mirrored on every render so per-request
  // builders read the latest committed store state (see the header comment).
  const liveRef = useRef({ snapshot, timeZone });
  liveRef.current = { snapshot, timeZone };

  // Rebuilt per request from the live refs: fresh clock, fresh snapshot,
  // fresh notes (S4). The callback itself stays stable, so nothing above
  // re-arms when data changes — only reads at call time.
  const buildPrompt = useCallback(
    () =>
      buildSystemPrompt({
        snapshot: liveRef.current.snapshot,
        memories: memoriesRef.current,
        now: new Date(),
        timeZone: liveRef.current.timeZone,
      }),
    [],
  );

  /** The tool context as of NOW: the caller builds it per request or per
   * confirm from the live refs, so ids, titles and `todayKey` are current. */
  const buildToolContext = useCallback((): ChatToolContext => {
    const live = liveRef.current;
    return {
      tasks: live.snapshot.tasks,
      blocks: live.snapshot.blocks,
      holidays: live.snapshot.holidays,
      timeZone: live.timeZone,
      todayKey: dateKey(new Date(), live.timeZone),
    };
  }, []);

  // R1 (spec S1) + ronda4 (S4): the confirm flow. Validation is pure
  // (tools.ts) and runs against the LIVE context at confirm time; the write
  // goes through the app's own data functions for the signed-in user only.
  // `move_task` maps onto what the app already does: a target day is
  // `setTaskDeadline`'s deadline (null = unschedule), and a start time — the
  // app's primitive for placing a task at a time — adds a task-linked work
  // block for the estimate's duration. Both land in ONE writeBatch
  // (`moveTaskWithBlock`), so a move is atomic; `create_task` with a start
  // time lands its task and its block in ONE batch (`createChatTask`). Every
  // outcome carries the created/changed task's id and fields in `result`,
  // which rides the next request's `tool` message so the model can reference
  // what it just changed. Invalid proposals fail before any write.
  const executeToolCall = useCallback(
    async (call: ChatToolCall): Promise<ToolOutcome> => {
      if (uid === null) return { status: "failed", message: "Sign in to let the assistant change your planner." };
      const toolContext = buildToolContext();
      const check = validateToolCall(call, toolContext);
      if (!check.ok) return { status: "failed", message: check.error };
      try {
        if (call.name === "create_task") {
          const value = check.value as NormalizedCreateTask;
          const estimate = value.estimateMinutes ?? 60;
          const { taskId } = await createChatTask(uid, {
            title: value.title,
            ...(value.day === undefined ? {} : { deadline: value.day }),
            ...(value.estimateMinutes === undefined ? {} : { estimateMinutes: value.estimateMinutes }),
            ...(value.startMinutes !== undefined && value.day !== undefined
              ? {
                  block: {
                    start: toZonedInstant(localValue(value.day, value.startMinutes), toolContext.timeZone),
                    end: toZonedInstant(localValue(value.day, value.startMinutes + estimate), toolContext.timeZone),
                  },
                }
              : {}),
          }, db);
          // The outcome is one line for both audiences: the user reads what
          // happened, and the model reads the id it must use to reference
          // this task in a follow-up (S4 diagnosis D2.1).
          const when = value.day === undefined ? "" : ` · ${formatDateKey(value.day, toolContext.todayKey)}`;
          const at = value.startMinutes === undefined ? "" : ` ${timeLabel(value.startMinutes)}`;
          const duration = value.estimateMinutes === undefined ? "" : ` · ${value.estimateMinutes} min`;
          return {
            status: "confirmed",
            message: `Created task id=${taskId} — "${value.title}"${when}${at}${duration}`,
          };
        }
        if (call.name === "move_task") {
          const value = check.value as NormalizedMoveTask;
          const task = toolContext.tasks.find(entry => entry.id === value.taskId);
          const estimate = task?.estimateMinutes ?? 60;
          await moveTaskWithBlock(uid, {
            taskId: value.taskId,
            title: task?.title ?? value.title,
            ...(value.day === null ? {} : { deadline: value.day }),
            ...(value.startMinutes !== undefined && value.day !== null
              ? {
                  block: {
                    start: toZonedInstant(localValue(value.day, value.startMinutes), toolContext.timeZone),
                    end: toZonedInstant(localValue(value.day, value.startMinutes + estimate), toolContext.timeZone),
                  },
                }
              : {}),
          }, db);
          const target = value.day === null ? "no date" : formatDateKey(value.day, toolContext.todayKey);
          const at = value.startMinutes === undefined ? "" : ` at ${timeLabel(value.startMinutes)}`;
          return {
            status: "confirmed",
            message:
              value.day === null
                ? `Unscheduled task id=${value.taskId} — "${task?.title ?? value.title}" (due date cleared)`
                : `Moved task id=${value.taskId} — "${task?.title ?? value.title}" to ${target}${at}`,
          };
        }
        return { status: "failed", message: `Unknown action "${call.name}".` };
      } catch (error) {
        return { status: "failed", message: error instanceof Error ? error.message : String(error) };
      }
    },
    [uid, buildToolContext],
  );

  /** Reads (S4): run the moment the model proposes them — no confirmation.
   * Validation is the same pure rules the card used; the data comes from the
   * live context (tasks, blocks, holidays) or the live notes store, never
   * from the render that happened to be on screen when the request started. */
  const executeReadTool = useCallback(
    async (call: ChatToolCall): Promise<ChatReadOutcome> => {
      if (!isReadTool(call.name)) return { ok: false, error: `Unknown action "${call.name}".` };
      const toolContext = buildToolContext();
      const check = validateToolCall(call, toolContext);
      if (!check.ok) return { ok: false, error: check.error };
      const found = ({ summary, result }: ReadResult): ChatReadOutcome => ({ ok: true, summary, result });
      if (call.name === "list_tasks") return found(buildListTasksResult(check.value as NormalizedListTasks, toolContext));
      if (call.name === "get_task") return found(buildGetTaskResult((check.value as NormalizedGetTask).taskId, toolContext));
      if (call.name === "list_holidays") return found(buildListHolidaysResult(toolContext));
      // list_memories reads the live notes store, not the render-time mirror.
      try {
        const notes = await backend.list();
        return found(buildListMemoriesResult(notes));
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    [backend, buildToolContext],
  );

  // The panel's own useChat call site is owned by another worker, so the
  // executor is installed through the readTools registry (see that module's
  // header) instead of a new panel prop.
  useEffect(() => {
    setChatReadExecutor(executeReadTool);
    return () => setChatReadExecutor(null);
  }, [executeReadTool]);

  const onConversationEnd = useCallback(
    (turns: ChatTurn[]) => {
      if (transport === null) return;
      void (async () => {
        try {
          const current = await backend.list();
          const request = buildExtractionRequest(turns, current);
          const raw = await transport.complete({
            id: `x${Date.now()}`,
            model: getChatModel(),
            messages: request.messages,
          });
          const ops = parseMemoryOps(raw);
          if (ops.length === 0) return;
          setLatestMemories(await backend.apply(ops));
        } catch (error) {
          // Silent to the user except a console warning; never blocks the UI.
          console.warn("chat: memory extraction failed", error);
        }
      })();
    },
    [backend, transport, setLatestMemories],
  );

  // Display-only context for the panel's card descriptions (the words a card
  // shows while pending). The authoritative validation at confirm time and
  // every request's prompt read the live refs instead, so this memo only
  // needs to track the snapshot for re-rendering descriptions.
  const displayToolContext = useMemo<ChatToolContext>(
    () => buildToolContext(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- snapshot identity changes on every store event
    [snapshot, timeZone, buildToolContext],
  );

  return (
    <ChatPanel
      signedIn={signedIn}
      {...(transport !== null ? { transport } : {})}
      buildSystemPrompt={buildPrompt}
      onConversationEnd={onConversationEnd}
      onSetupKey={onSetupKey}
      toolContext={displayToolContext}
      onConfirmToolCall={executeToolCall}
    />
  );
}

/** Minutes since midnight as wall-clock HH:MM (outcomes and descriptions). */
function timeLabel(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}
