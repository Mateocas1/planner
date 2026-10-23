/**
 * The chat surface (task C3a): the composition layer between App's single
 * mount point and the ChatPanel. It owns everything C3 wires — the real
 * Tauri transport on desktop, the planner snapshot feed, the memory backend
 * (Rust file on desktop, in-memory behind `?chatMock`) and the
 * end-of-conversation extraction — while the panel keeps its own look and
 * motion. App renders this instead of ChatPanel directly; on the web without
 * `?chatMock` no transport exists and the panel falls back to its unwired
 * error transport, exactly as before C3a.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatPanel, type ToolOutcome } from "../ui/ChatPanel.tsx";
import { addTask } from "../data/tasks.ts";
import { moveTaskWithBlock } from "../data/chatMove.ts";
import { db } from "../data/client.ts";
import { isTauri } from "../desktop.ts";
import { dateKey, localValue, toZonedInstant } from "../ui/time.ts";
import { getChatModel, mockMode } from "./config.ts";
import type { ChatTurn } from "./conversation.ts";
import { createInMemoryMemoryBackend, tauriMemoryBackend, type ChatMemoryBackend } from "./memoryBackend.ts";
import { buildExtractionRequest, parseMemoryOps } from "./memoryExtract.ts";
import type { Memory } from "./memoryStore.ts";
import { createMockTransport } from "./mockTransport.ts";
import { buildSystemPrompt } from "./systemPrompt.ts";
import { validateToolCall, type ChatToolContext, type NormalizedCreateTask, type NormalizedMoveTask } from "./tools.ts";
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

  // Rebuilt per request: fresh clock, fresh snapshot, fresh notes (S4).
  const buildPrompt = useCallback(
    () => buildSystemPrompt({ snapshot, memories: memoriesRef.current, now: new Date(), timeZone }),
    [snapshot, timeZone],
  );

  // R1 (spec S1): the confirm flow. Validation is pure (tools.ts) — every
  // check, including the midnight room check for a start time, runs before
  // any data call — and the write goes through the app's own data functions
  // for the signed-in user only. `move_task` maps onto what the app already
  // does: a target day is `setTaskDeadline`'s deadline (null = unschedule),
  // and a start time — the app's primitive for placing a task at a time —
  // adds a task-linked work block for the estimate's duration. Both land in
  // ONE writeBatch (`moveTaskWithBlock`), so a move is atomic. Invalid
  // proposals fail before any write; a failed write leaves the card failed
  // and data untouched by this flow.
  const toolContext = useMemo<ChatToolContext>(
    () => ({ tasks: snapshot.tasks, timeZone, todayKey: dateKey(new Date(), timeZone) }),
    [snapshot.tasks, timeZone],
  );

  const executeToolCall = useCallback(
    async (call: ChatToolCall): Promise<ToolOutcome> => {
      if (uid === null) return { status: "failed", message: "Sign in to let the assistant change your planner." };
      const check = validateToolCall(call, toolContext);
      if (!check.ok) return { status: "failed", message: check.error };
      try {
        if (call.name === "create_task") {
          const value = check.value as NormalizedCreateTask;
          await addTask(uid, value.title, value.day, value.estimateMinutes);
          return { status: "confirmed", message: "Task created." };
        }
        if (call.name === "move_task") {
          const value = check.value as NormalizedMoveTask;
          const estimate = toolContext.tasks.find(task => task.id === value.taskId)?.estimateMinutes ?? 60;
          await moveTaskWithBlock(uid, {
            taskId: value.taskId,
            title: value.title,
            ...(value.day === null ? {} : { deadline: value.day }),
            ...(value.startMinutes !== undefined && value.day !== null
              ? {
                  block: {
                    start: toZonedInstant(localValue(value.day, value.startMinutes), timeZone),
                    end: toZonedInstant(localValue(value.day, value.startMinutes + estimate), timeZone),
                  },
                }
              : {}),
          }, db);
          const message =
            value.day === null
              ? "The task was unscheduled."
              : value.startMinutes !== undefined
                ? "The task was moved and placed on the schedule."
                : "The task was moved.";
          return { status: "confirmed", message };
        }
        return { status: "failed", message: `Unknown action "${call.name}".` };
      } catch (error) {
        return { status: "failed", message: error instanceof Error ? error.message : String(error) };
      }
    },
    [uid, toolContext, timeZone],
  );

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

  return (
    <ChatPanel
      signedIn={signedIn}
      {...(transport !== null ? { transport } : {})}
      buildSystemPrompt={buildPrompt}
      onConversationEnd={onConversationEnd}
      onSetupKey={onSetupKey}
      toolContext={toolContext}
      onConfirmToolCall={executeToolCall}
    />
  );
}
