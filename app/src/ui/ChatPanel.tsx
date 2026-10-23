import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { chatPanelVisible, mockMode } from "../chat/config.ts";
import type { ChatTurn } from "../chat/conversation.ts";
import { Markdown, StreamedAnswer } from "../chat/markdown.tsx";
import { createMockTransport } from "../chat/mockTransport.ts";
import type { ChatTransport } from "../chat/types.ts";
import { useChat } from "../chat/useChat.ts";
import { isTauri } from "../desktop.ts";
import { CloseIcon } from "./icons.tsx";
import "./ChatPanel.css";

/**
 * The floating chat panel (task C2, S1+S2): a ≈400×600 glass card in the
 * bottom-right corner, opened with `Ctrl+J` (preventDefault — WebView2 opens
 * Downloads on it), the launcher button, and closed with Esc, the launcher or
 * the close button. Desktop only, signed in; on the web it renders only while
 * developing with `?chatMock`, so a production web build never mounts it.
 *
 * The real transport is C1's Tauri bridge; until that lands on this branch the
 * non-mock desktop default is a transport that reports an error instead of
 * pretending to work. C3/C4 wire the real one by passing `transport`.
 *
 * Closing runs a 120 ms exit (`data-closing` keeps the card displayed but
 * `inert`, `chat-panel-out` plays, and `animationend` — with a ~200 ms
 * timeout fallback — hides it). The exit never cancels an in-flight stream:
 * the request keeps running hidden, so reopening shows the finished answer.
 */

/** Placeholder for C1's tauriTransport, which is wired at integration (C4). */
const unwiredTransport: ChatTransport = {
  stream: (_request, onEvent) =>
    new Promise(resolve => {
      onEvent({ type: "error", code: "provider", message: "Chat transport is not wired yet (task C4)." });
      resolve();
    }),
  cancel: () => Promise.resolve(),
  complete: () => Promise.reject(new Error("Chat transport is not wired yet (task C4).")),
};

const ChatIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.3 9 9 0 0 1-3.2-.6L4 20l1-4.1a8 8 0 0 1-1.5-4.4A8.4 8.4 0 0 1 12 3.2a8.4 8.4 0 0 1 9 8.3Z" />
  </svg>
);

const SendIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12h13" />
    <path d="M12 5.5 18.5 12 12 18.5" />
  </svg>
);

const StopIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
    <rect x="6" y="6" width="12" height="12" rx="2.5" />
  </svg>
);

/** The circular spinner the user asked to keep (S2). A rotating captured
 * stroke: transform only, one element, no layout. */
const Spinner = () => (
  <svg className="chat-spinner" viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
    <circle className="chat-spinner-track" cx="10" cy="10" r="7.5" />
    <circle className="chat-spinner-arc" cx="10" cy="10" r="7.5" />
  </svg>
);

/** Reduced motion, cached (review #4): `matchMedia` is read once per mount
 * and re-read on changes, never per frame. */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/**
 * FLIP glide (S2): when a turn is appended, everything already on screen
 * glides up instead of jumping. Layout is never animated — the effect measures
 * the children before and after the commit and animates only the compensating
 * `transform`, then clears it so no composited layer lingers under the text.
 * It runs only when `appendKey` changes (review #4): a pacer frame re-renders
 * the stream but never re-measures `getBoundingClientRect`.
 */
function useGlideOnAppend(columnRef: React.RefObject<HTMLDivElement | null>, appendKey: number, reduced: boolean) {
  const tops = useRef<Map<Element, number>>(new Map());
  const lastAppendKey = useRef(appendKey);
  useLayoutEffect(() => {
    const column = columnRef.current;
    if (column === null) return;
    const appended = appendKey > lastAppendKey.current;
    lastAppendKey.current = appendKey;
    const newTops = new Map<Element, number>();
    for (const child of column.children) newTops.set(child, child.getBoundingClientRect().top);
    if (appended && !reduced) {
      for (const [child, previousTop] of tops.current) {
        const newTop = newTops.get(child);
        if (newTop === undefined) continue;
        const delta = previousTop - newTop;
        if (Math.abs(delta) < 2) continue;
        child.animate([{ transform: `translateY(${delta}px)` }, { transform: "translateY(0px)" }], {
          duration: 180,
          easing: "cubic-bezier(0.23, 1, 0.32, 1)",
        });
      }
    }
    tops.current = newTops;
  }, [appendKey, reduced, columnRef]);
}

export function ChatPanel({
  transport,
  buildSystemPrompt,
  signedIn = false,
}: {
  /** Defaults select the mock in dev-mock mode; C4 wires the Tauri bridge. */
  transport?: ChatTransport;
  buildSystemPrompt?: () => string;
  /** Review #2: the panel is an in-app surface, so the real (non-mock) panel
   * exists only for a signed-in session; App passes `user !== null`. */
  signedIn?: boolean;
}) {
  const [mockQuery] = useState(() => new URLSearchParams(window.location.search).get("chatMock"));
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [showJump, setShowJump] = useState(false);

  // The mock transport is per-mount: its scenario is fixed by the URL.
  const [mockTransport] = useState(() => createMockTransport(mockMode(mockQuery)));
  const resolvedTransport = transport ?? (mockQuery !== null ? mockTransport : unwiredTransport);
  const resolvedPrompt = buildSystemPrompt ?? (() => "");
  const { state, send, stop, retry, newChat } = useChat({ transport: resolvedTransport, buildSystemPrompt: resolvedPrompt });
  const inFlight = state.phase !== "idle";
  const streaming = state.phase === "streaming";

  // Recomputed every render (review #2), never frozen at mount: signing in or
  // out flips the launcher and panel on the next App render.
  const dev = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV === true;
  const visible = chatPanelVisible({ desktop: isTauri(), dev, mockQuery, signedIn });

  const launcherRef = useRef<HTMLButtonElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const stickyRef = useRef(true);
  /** Whether the panel has been opened, so closing returns focus only then. */
  const openedOnce = useRef(false);
  const reduced = useReducedMotion();
  /** True while the 120 ms exit animation plays: the card stays displayed but
   * inert until `animationend` (or the fallback timer) hides it. */
  const [closing, setClosing] = useState(false);
  const closeFallback = useRef<number | null>(null);

  const cancelExit = useCallback(() => {
    if (closeFallback.current !== null) {
      window.clearTimeout(closeFallback.current);
      closeFallback.current = null;
    }
  }, []);

  // Drive the exit (review #3). open → false starts it unless reduced motion
  // (which hides instantly, as before); `animationend` or the ~200 ms fallback
  // ends it. Reopening mid-exit cancels both, so the entrance restarts cleanly.

  const streamingTurn: (ChatTurn & { role: "assistant" }) | null = (() => {
    const last = state.turns[state.turns.length - 1];
    return streaming && last !== undefined && last.role === "assistant" ? last : null;
  })();

  // Auto-scroll: stick to the bottom while the user hasn't scrolled away.
  // This runs BEFORE the FLIP glide below, so the glide measures the final
  // painted positions (scroll applied) and animates the true visual delta.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (scroller === null || !stickyRef.current) return;
    scroller.scrollTop = scroller.scrollHeight;
  });

  // Structural appends (a new turn, the waiting bubble) drive the FLIP glide;
  // text growth inside a turn deliberately does not.
  const appendKey = state.turns.length + (state.phase === "pending" || state.phase === "reasoning" ? 1 : 0);
  useGlideOnAppend(columnRef, appendKey, reduced);

  const onScroll = useCallback(() => {
    const scroller = scrollRef.current;
    if (scroller === null) return;
    const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    stickyRef.current = distance < 48;
    setShowJump(distance >= 48);
  }, []);

  const jumpToLatest = useCallback(() => {
    const scroller = scrollRef.current;
    if (scroller === null) return;
    stickyRef.current = true;
    setShowJump(false);
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: reduced ? "auto" : "smooth" });
  }, [reduced]);

  // Ctrl+J toggles the panel from anywhere, fields included (the app's single-key
  // router ignores modified keys, so there is no conflict to arbitrate).
  useEffect(() => {
    if (!visible) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey || event.key.toLowerCase() !== "j") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(current => !current);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [visible]);

  // Esc closes while the panel is up; focus returns to the launcher.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open]);

  useEffect(() => {
    // Focus follows open/close only — never on the first mount, where the
    // panel has no claim on the caret the app already placed. On close the
    // launcher takes focus at once; `inert` on the closing panel stops the
    // composer from re-taking it (review #3).
    if (open) {
      openedOnce.current = true;
      fieldRef.current?.focus({ preventScroll: true });
    } else if (openedOnce.current) {
      openedOnce.current = false;
      launcherRef.current?.focus({ preventScroll: true });
    }
  }, [open]);

  // The exit lifecycle (review #3): see the comment above `closing`. Runs in a
  // layout effect so the closing card never paints as hidden for a frame.
  useLayoutEffect(() => {
    if (open || !openedOnce.current || reduced) {
      cancelExit();
      setClosing(false);
      return;
    }
    setClosing(true);
    closeFallback.current = window.setTimeout(() => {
      closeFallback.current = null;
      setClosing(false);
    }, 200);
  }, [open, reduced, cancelExit]);

  const onPanelAnimationEnd = (event: React.AnimationEvent<HTMLElement>) => {
    // Inner animations (bubbles, the spinner) bubble up — only the panel's own
    // exit ends the close.
    if (closing && event.animationName === "chat-panel-out") {
      cancelExit();
      setClosing(false);
    }
  };

  if (!visible) return null;

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (text === "" || inFlight) return;
    send(text);
    setDraft("");
  };

  const onFieldKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const canSend = draft.trim() !== "" && !inFlight;
  const isEmptyThread = state.turns.length === 0 && !inFlight && state.error === null;

  const renderTurn = (turn: ChatTurn, index: number): ReactNode => {
    if (turn.role === "user") {
      return (
        <div className="chat-bubble chat-user" key={turn.id}>
          {turn.text}
        </div>
      );
    }
    // The answer still streaming renders in the live slot below, so the
    // waiting bubble and the streaming answer are one element (the morph).
    if (streamingTurn !== null && index === state.turns.length - 1) return null;
    return (
      <div className="chat-bubble chat-answer" key={turn.id} aria-live="polite">
        <div className="chat-answer-body">
          <Markdown text={turn.text} />
        </div>
      </div>
    );
  };

  return (
    <>
      <button
        ref={launcherRef}
        type="button"
        className="chat-launcher glass glass-float"
        aria-label="Chat"
        aria-expanded={open}
        aria-keyshortcuts="Control+J"
        onClick={() => setOpen(current => !current)}
      >
        <ChatIcon />
      </button>
      <section
        className="chat-panel glass glass-thick"
        data-open={open}
        data-closing={closing || undefined}
        inert={closing || undefined}
        onAnimationEnd={onPanelAnimationEnd}
        aria-label="Chat"
        role="dialog"
        aria-modal="false"
      >
        <div className="chat-inner">
          <header className="chat-head">
            <span className="chat-head-title">Chat</span>
            <button type="button" className="chat-new-chat" onClick={newChat} disabled={state.turns.length === 0 && !inFlight}>
              New chat
            </button>
            <button type="button" className="chat-icon-button" aria-label="Close chat" onClick={() => setOpen(false)}>
              <CloseIcon />
            </button>
          </header>
          <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
            <div className="chat-column" ref={columnRef}>
              {isEmptyThread ? (
                <div className="chat-empty">
                  <p className="chat-empty-hi">Hi</p>
                  <h2 className="chat-empty-heading">What do you need?</h2>
                </div>
              ) : (
                state.turns.map(renderTurn)
              )}
              {(state.phase === "pending" || state.phase === "reasoning" || streamingTurn !== null) && (
                <div className="chat-bubble chat-answer" data-live key="assistant-live">
                  {/* The spinner stays mounted through the morph: the same
                      bubble cross-fades from waiting to text, no pop. */}
                  <span className={`chat-waiting${streamingTurn !== null ? " is-done" : ""}`}>
                    <Spinner />
                  </span>
                  {streamingTurn !== null && (
                    <div className="chat-answer-body">
                      <StreamedAnswer text={streamingTurn.text} segments={streamingTurn.segments} />
                    </div>
                  )}
                </div>
              )}
              {state.error !== null && (
                <div className="chat-error" role="alert">
                  <p className="chat-error-message">{state.error.message}</p>
                  <button type="button" className="chat-retry" onClick={retry} disabled={inFlight}>
                    Retry
                  </button>
                </div>
              )}
            </div>
          </div>
          {!showJump ? null : (
            <button type="button" className="chat-jump" onClick={jumpToLatest}>
              Jump to latest ↓
            </button>
          )}
          <form className="chat-composer" onSubmit={submit}>
            <textarea
              ref={fieldRef}
              className="chat-field"
              placeholder="Type your message…"
              aria-label="Message"
              rows={1}
              value={draft}
              onChange={event => setDraft(event.target.value)}
              onKeyDown={onFieldKeyDown}
            />
            {inFlight ? (
              <button type="button" className="chat-send is-stop" aria-label="Stop" onClick={stop}>
                <StopIcon />
              </button>
            ) : (
              <button type="submit" className="chat-send" aria-label="Send" disabled={!canSend}>
                <SendIcon />
              </button>
            )}
          </form>
        </div>
      </section>
    </>
  );
}
