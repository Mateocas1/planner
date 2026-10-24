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
import { ChatPanel } from "../ui/ChatPanel.tsx";
import { isTauri } from "../desktop.ts";
import { DEFAULT_CHAT_MODEL, mockMode } from "./config.ts";
import type { ChatTurn } from "./conversation.ts";
import { createInMemoryMemoryBackend, tauriMemoryBackend, type ChatMemoryBackend } from "./memoryBackend.ts";
import { buildExtractionRequest, parseMemoryOps } from "./memoryExtract.ts";
import type { Memory } from "./memoryStore.ts";
import { createMockTransport } from "./mockTransport.ts";
import { buildSystemPrompt } from "./systemPrompt.ts";
import { createTauriChatTransport } from "./tauriTransport.ts";
import type { ChatTransport } from "./types.ts";
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

  const onConversationEnd = useCallback(
    (turns: ChatTurn[]) => {
      if (transport === null) return;
      void (async () => {
        try {
          const current = await backend.list();
          const request = buildExtractionRequest(turns, current);
          const raw = await transport.complete({
            id: `x${Date.now()}`,
            model: DEFAULT_CHAT_MODEL,
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
    />
  );
}
