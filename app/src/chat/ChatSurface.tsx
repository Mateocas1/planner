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
import { createChatTask, applyChatTaskUpdate } from "../data/chatMove.ts";
import { setHolidayHidden } from "../data/holidays.ts";
import { setTaskCompleted, deleteTask } from "../data/tasks.ts";
import { linkedBlocks } from "../data/blocks.ts";
import { db } from "../data/client.ts";
import { isTauri } from "../desktop.ts";
import { t } from "../i18n/index.ts";
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
  affectedBlockIds,
  buildGetTaskResult,
  buildListHolidaysResult,
  buildListMemoriesResult,
  buildListTasksResult,
  deleteTaskKeptNote,
  deriveTopicKey,
  isReadTool,
  createConfirmGuard,
  moveTaskRemovals,
  validateToolCall,
  type ChatToolContext,
  type NormalizedCompleteTask,
  type NormalizedCreateTask,
  type NormalizedDeleteTask,
  type NormalizedForget,
  type NormalizedGetTask,
  type NormalizedHideHoliday,
  type NormalizedListTasks,
  type NormalizedMoveTask,
  type NormalizedRemember,
  type NormalizedUpdateTask,
  type ReadResult,
} from "./tools.ts";
import { setChatReadExecutor, type ChatReadOutcome } from "./readTools.ts";
import { createTauriChatTransport } from "./tauriTransport.ts";
import type { ChatToolCall, ChatTransport } from "./types.ts";
import { usePlannerSnapshot } from "./usePlannerSnapshot.ts";
import { MEMORIES_CHANGED_EVENT } from "./memoryStore.ts";

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
    // The store contract is an array; a transport that answers null (a Tauri
    // stub, a drifted Rust shape) must not poison every render that reads the
    // notes. One choke point keeps the ref and the state shape-true.
    const safe = Array.isArray(list) ? list : [];
    memoriesRef.current = safe;
    setMemories(safe);
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

  /** The AI settings memory list refreshes when the notes change under it
   * (a confirmed remember/forget, or extraction): one window event, one
   * listener in the settings tab. */
  const notifyMemoriesChanged = useCallback(() => {
    window.dispatchEvent(new CustomEvent(MEMORIES_CHANGED_EVENT));
  }, []);

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
      memoryTopics: (memoriesRef.current ?? []).map(memory => ({ topicKey: memory.topicKey, title: memory.title })),
      timeZone: live.timeZone,
      todayKey: dateKey(new Date(), live.timeZone),
    };
  }, []);

  // R1 (spec S1) + ronda4 (S4): the confirm flow. Validation is pure
  // (tools.ts) and runs against the LIVE context at confirm time; the write
  // goes through the app's own data functions for the signed-in user only.
  // Every task change lands in ONE writeBatch (`createChatTask` for creates
  // with their placement block, `applyChatTaskUpdate` for moves, updates and
  // unschedules with the blocks they replace or drop), so a failed write can
  // never leave half a change behind. Every outcome carries the created or
  // changed task's id and fields in the message, which rides the next
  // request's `tool` message so the model can reference what it just
  // changed. Invalid proposals fail before any write.
  //
  // Confirms also carry a per-callId once-guard (review finding 7): the first
  // confirm attempt claims the id, so the same card can never write twice.
  const confirmGuard = useMemo(() => createConfirmGuard(), []);
  const executeToolCall = useCallback(
    async (call: ChatToolCall): Promise<ToolOutcome> => {
      if (uid === null) return { status: "failed", message: t("chat.outcome.signIn") };
      // One Confirm, one write (review finding 7): the per-callId guard
      // claims the id before any await, so a repeated confirm can never run
      // a second write even if the panel's own busy guard is bypassed.
      if (!confirmGuard.claim(call.id)) {
        return { status: "failed", message: t("chat.outcome.alreadyConfirmed") };
      }
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
          const duration = value.estimateMinutes === undefined ? "" : ` · ${t("chat.minutes", { count: value.estimateMinutes })}`;
          return {
            status: "confirmed",
            message: t("chat.outcome.created", { id: taskId, title: value.title, details: `${when}${at}${duration}` }),
          };
        }
        if (call.name === "move_task") {
          const value = check.value as NormalizedMoveTask;
          const task = toolContext.tasks.find(entry => entry.id === value.taskId);
          const estimate = task?.estimateMinutes ?? 60;
          // The removals the card described (moveTaskRemovals): a start-time
          // move replaces the task's same-day blocks; `day: null` clears only
          // the due date and removes NO blocks (that is update_task's job).
          const removals = moveTaskRemovals(value, toolContext);
          await applyChatTaskUpdate(uid, {
            taskId: value.taskId,
            title: task?.title ?? value.title,
            ...(value.day === null ? { clearDeadline: true } : value.day !== undefined ? { deadline: value.day } : {}),
            ...(value.startMinutes !== undefined && value.day !== null
              ? {
                  block: {
                    start: toZonedInstant(localValue(value.day, value.startMinutes), toolContext.timeZone),
                    end: toZonedInstant(localValue(value.day, value.startMinutes + estimate), toolContext.timeZone),
                  },
                }
              : {}),
            ...(removals.length > 0 ? { removeBlockIds: removals.map(entry => entry.id) } : {}),
          }, db);
          const title = task?.title ?? value.title;
          const target = value.day === null ? t("chat.outcome.noDate") : value.day === undefined ? undefined : formatDateKey(value.day, toolContext.todayKey);
          const at = value.startMinutes === undefined ? "" : t("chat.outcome.at", { time: timeLabel(value.startMinutes) });
          const replaced = removals.length > 0 ? t("chat.outcome.movedReplaced", { count: removals.length }) : "";
          return {
            status: "confirmed",
            message:
              value.day === null
                ? t("chat.outcome.unscheduled", { id: value.taskId, title })
                : t("chat.outcome.moved", { id: value.taskId, title, target: target ?? "", at, replaced }),
          };
        }
        if (call.name === "update_task") {
          const value = check.value as NormalizedUpdateTask;
          const task = toolContext.tasks.find(entry => entry.id === value.taskId);
          // Removals recompute from the LIVE context at confirm time: a block
          // created or removed after the card was proposed is still handled
          // exactly (S4 freshness).
          const removals = affectedBlockIds(
            value.taskId,
            { clearDay: value.clearDay, ...(value.startDay !== undefined ? { startDay: value.startDay } : {}) },
            toolContext,
          );
          const placementEstimate = value.estimateMinutes ?? (value.clearEstimate === true ? undefined : task?.estimateMinutes) ?? 60;
          await applyChatTaskUpdate(uid, {
            taskId: value.taskId,
            title: task?.title ?? value.title,
            ...(value.newTitle !== undefined ? { newTitle: value.newTitle } : {}),
            ...(value.clearDay === true ? { clearDeadline: true } : value.day !== undefined ? { deadline: value.day } : {}),
            ...(value.clearEstimate === true
              ? { clearEstimate: true }
              : value.estimateMinutes !== undefined
                ? { estimate: value.estimateMinutes }
                : {}),
            ...(value.startMinutes !== undefined && value.startDay !== undefined
              ? {
                  block: {
                    start: toZonedInstant(localValue(value.startDay, value.startMinutes), toolContext.timeZone),
                    end: toZonedInstant(localValue(value.startDay, value.startMinutes + placementEstimate), toolContext.timeZone),
                  },
                }
              : {}),
            ...(removals.length > 0 ? { removeBlockIds: removals.map(entry => entry.id) } : {}),
          }, db);
          const title = value.newTitle ?? task?.title ?? value.title;
          const target = value.clearDay === true ? t("chat.outcome.noDate") : value.day !== undefined ? formatDateKey(value.day, toolContext.todayKey) : undefined;
          const at = value.startMinutes === undefined ? "" : t("chat.outcome.at", { time: timeLabel(value.startMinutes) });
          const removed = removals.length > 0 ? t("chat.outcome.updatedRemoved", { count: removals.length }) : "";
          const estimateWord = value.estimateMinutes !== undefined || value.clearEstimate === true ? t("chat.outcome.estimateUpdated") : "";
          return {
            status: "confirmed",
            message: t("chat.outcome.updated", { id: value.taskId, title, details: `${target === undefined ? "" : ` · ${target}`}${at}${estimateWord}${removed}` }),
          };
        }
        if (call.name === "complete_task") {
          const value = check.value as NormalizedCompleteTask;
          await setTaskCompleted(uid, value.taskId, value.completed);
          return {
            status: "confirmed",
            message: value.completed
              ? t("chat.outcome.completed", { id: value.taskId, title: value.title })
              : t("chat.outcome.reopened", { id: value.taskId, title: value.title }),
          };
        }
        if (call.name === "delete_task") {
          const value = check.value as NormalizedDeleteTask;
          // The executor deletes exactly the blocks the card names when the
          // user confirms (the live context's task-linked set, which the card
          // re-renders live) — no more, no fewer.
          const removed = await deleteTask(uid, value.taskId, value.blocks);
          // Anything still linked to the task reached the database after the
          // confirm-time check (another device or surface). It was never
          // confirmed, so it is kept — and the outcome says so.
          const keptNote = deleteTaskKeptNote(value.blocks, await linkedBlocks(uid, value.taskId));
          return {
            status: "confirmed",
            message: t("chat.outcome.deleted", {
              id: value.taskId,
              title: value.title,
              blocks: removed.length > 0 ? t("chat.outcome.deletedBlocks", { count: removed.length }) : "",
              kept: keptNote,
            }),
          };
        }
        if (call.name === "hide_holiday") {
          const value = check.value as NormalizedHideHoliday;
          await setHolidayHidden(uid, value.holidayId, !value.show);
          return {
            status: "confirmed",
            message: value.show
              ? t("chat.outcome.holidayShown", { title: value.title })
              : t("chat.outcome.holidayHidden", { title: value.title }),
          };
        }
        if (call.name === "remember") {
          const value = check.value as NormalizedRemember;
          const topicKey = value.topicKey ?? deriveTopicKey(value.title);
          // The outcome matches the card: when the key was already in the
          // live notes, this replaced that note's content (review finding 3).
          const current = await backend.list();
          const existing = current.find(memory => memory.topicKey === topicKey);
          setLatestMemories(await backend.apply([{ op: "upsert", topicKey, title: value.title, content: value.content }]));
          notifyMemoriesChanged();
          return {
            status: "confirmed",
            message:
              existing === undefined
                ? t("chat.outcome.remembered", { title: value.title, topic: topicKey })
                : t("chat.outcome.replacedNote", { title: existing.title, topic: topicKey }),
          };
        }
        if (call.name === "forget") {
          const value = check.value as NormalizedForget;
          // The note's existence is checked against the LIVE store: a topic
          // proposed from a stale notes block must fail, never no-op.
          const current = await backend.list();
          const note = current.find(memory => memory.topicKey === value.topicKey);
          if (note === undefined) return { status: "failed", message: t("chat.outcome.noteMissing", { topic: value.topicKey }) };
          setLatestMemories(await backend.apply([{ op: "delete", topicKey: value.topicKey }]));
          notifyMemoriesChanged();
          return { status: "confirmed", message: t("chat.outcome.forgotten", { title: note.title }) };
        }
        return { status: "failed", message: t("chat.outcome.unknown", { name: call.name }) };
      } catch (error) {
        return { status: "failed", message: error instanceof Error ? error.message : String(error) };
      }
    },
    [uid, buildToolContext, backend, notifyMemoriesChanged, confirmGuard],
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
          notifyMemoriesChanged();
        } catch (error) {
          // Silent to the user except a console warning; never blocks the UI.
          console.warn("chat: memory extraction failed", error);
        }
      })();
    },
    [backend, transport, setLatestMemories, notifyMemoriesChanged],
  );

  // Display-only context for the panel's card descriptions (the words a card
  // shows while pending). Built per render — a cheap object — so the "today"
  // wording is computed at describe time instead of frozen in a memo from
  // whatever render first built it (review finding 6). The authoritative
  // confirm-time validation and every request's prompt still read the live
  // refs via buildToolContext.
  const displayToolContext: ChatToolContext = {
    tasks: snapshot.tasks,
    blocks: snapshot.blocks,
    holidays: snapshot.holidays,
    memoryTopics: (memories ?? []).map(memory => ({ topicKey: memory.topicKey, title: memory.title })),
    timeZone,
    todayKey: dateKey(new Date(), timeZone),
  };

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
