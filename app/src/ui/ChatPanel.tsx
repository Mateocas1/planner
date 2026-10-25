import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { chatPanelVisible, mockMode } from "../chat/config.ts";
import type { ChatTurn, ToolCallCard } from "../chat/conversation.ts";
import { getKeyStatus } from "../chat/keyStore.ts";
import { Markdown, StreamedAnswer } from "../chat/markdown.tsx";
import { createMockTransport } from "../chat/mockTransport.ts";
import { describeToolCall, type ChatToolContext } from "../chat/tools.ts";
import type { ChatToolCall, ChatTransport } from "../chat/types.ts";
import { useChat } from "../chat/useChat.ts";
import { browserTimeZone } from "../data/profile.ts";
import { isTauri } from "../desktop.ts";
import { dateKey } from "./time.ts";
import { dur, easeOutBackCss, ms } from "./motion.ts";
import { useSwipeDismiss } from "./useSwipeDismiss.ts";
import { matchesEvent, parseAccelerator, useShortcutBinding } from "./settings/shortcutRegistry.ts";
import { CallsDroppedNote, ChatActionCard } from "./ChatActionCard.tsx";
import { CloseIcon } from "./icons.tsx";
import "./ChatPanel.css";

/**
 * The floating chat panel (task C2, S1+S2): a ≈400×600 glass card in the
 * bottom-right corner, opened with its rebindable chord (default `Ctrl+J`,
 * read live from the shortcut registry; preventDefault — WebView2 opens
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
 *
 * Swipe to dismiss (Ronda 4 S1, task T5): the panel shares the sheets'
 * gesture language through useSwipeDismiss — a drag on its header
 * (`data-drag-handle`) or on non-text, non-scrolled surface follows the
 * pointer, and a release past the distance/velocity thresholds flies the
 * panel out in the drag direction carrying the release velocity, then runs
 * the ordinary close path above (same `setOpen(false)`, same focus return,
 * `onConversationEnd` timing unchanged). The commit flight ends by holding
 * the panel invisible inline, so the CSS exit starts hidden instead of
 * flashing back to rest; the hook clears its styles when the panel is
 * active again. On the phone breakpoint the panel is the full viewport
 * (radius 0), so the drag rounds its corners 0 → 28 px with a
 * `clip-path: inset(0 round …)` as it shrinks; desktop keeps its
 * `--r-sheet` corners.
 */

/** The result of one confirmed (or failed) proposal, rendered on the card and
 * sent back to the model as the call's `tool` message (spec S1). */
export type ToolOutcome = { status: "confirmed" | "failed"; message: string };

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

/** The send button's rect at the moment of a send: the origin the user
 * bubble flies from (Ronda 4 S3). */
type SendOrigin = { left: number; top: number; width: number; height: number };

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

/**
 * The user bubble's send flight (Ronda 4 S3): the bubble appears to leave the
 * send button. The submit handler measures the button's rect before the send
 * swaps it for the stop button; this effect measures the landed bubble and
 * animates only the compensating `transform` (FLIP, top-left anchored) plus a
 * resolving blur (≤ 6 px) and opacity, with a short spring (easeOutBack —
 * WAAPI cannot take a Motion spring). It runs after the scroll effect, so the
 * delta is measured from the slot the bubble actually lands in.
 *
 * The contents cross-fade instead of riding the scale (the shared-element
 * rule: never distort text): the pill flies blurred, and the text fades in
 * once the scale is close to 1. `data-flown` stays on the bubble so the CSS
 * mount entrance (`chat-user-in`) never replays under it — the flight *is*
 * the entrance. Reduced motion: skipped entirely; the CSS opacity fade plays.
 *
 * Interruptible: each send targets its own freshly mounted bubble, so two
 * sends never stack transforms on one element (and a second send cannot fire
 * while one is in flight — the submit guard blocks it). The origin is
 * consumed whether or not a flight runs, so a stale origin never re-flies.
 */
function useSendFlight(
  columnRef: React.RefObject<HTMLDivElement | null>,
  origin: SendOrigin | null,
  reduced: boolean,
  consumeOrigin: () => void,
) {
  const flown = useRef<WeakSet<Element>>(new WeakSet());
  useLayoutEffect(() => {
    if (origin === null) return;
    consumeOrigin();
    if (reduced) return;
    const column = columnRef.current;
    if (column === null) return;
    const bubbles = column.querySelectorAll<HTMLElement>(".chat-user");
    const bubble = bubbles[bubbles.length - 1];
    if (bubble === undefined || flown.current.has(bubble)) return;
    flown.current.add(bubble);
    bubble.setAttribute("data-flown", "");
    const rect = bubble.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return; // never painted — skip
    const scaleX = origin.width / rect.width;
    const scaleY = origin.height / rect.height;
    const deltaX = origin.left - rect.left;
    const deltaY = origin.top - rect.top;
    const config = { duration: ms(dur.sendFlight), easing: easeOutBackCss };
    bubble.style.transformOrigin = "top left";
    const shell = bubble.animate(
      [
        {
          transform: `translate(${deltaX}px, ${deltaY}px) scale(${scaleX}, ${scaleY})`,
          opacity: 0.6,
          filter: "blur(4px)",
        },
        { transform: "translate(0px, 0px) scale(1, 1)", opacity: 1, filter: "blur(0px)" },
      ],
      config,
    );
    shell.finished.then(() => {
      bubble.style.transformOrigin = "";
    }, () => {}); // cancelled (bubble unmounted): nothing to restore
    const text = bubble.querySelector<HTMLElement>(".chat-user-text");
    if (text !== null) {
      text.animate([{ opacity: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 1 }], {
        duration: config.duration,
        easing: "ease-out",
      });
    }
  }, [origin, reduced, columnRef, consumeOrigin]);
}

/** The aria form of the current chord ("Control+Shift+J"), for assistive
 * tech that announces the launcher's shortcut. */
function ariaKeyShortcuts(accelerator: string): string {
  const combo = parseAccelerator(accelerator);
  if (combo === null) return "Control+J";
  const parts = [
    combo.ctrl && "Control",
    combo.alt && "Alt",
    combo.shift && "Shift",
    combo.meta && "Meta",
  ].filter(Boolean) as string[];
  return [...parts, combo.code.replace(/^Key/, "").replace(/^Digit/, "")].join("+");
}

export function ChatPanel({
  transport,
  buildSystemPrompt,
  signedIn = false,
  onConversationEnd,
  onSetupKey,
  toolContext,
  onConfirmToolCall,
}: {
  /** Defaults select the mock in dev-mock mode; C3a's ChatSurface wires the
   * Tauri bridge on desktop and the mock in dev-mock runs. */
  transport?: ChatTransport;
  buildSystemPrompt?: () => string;
  /** Review #2: the panel is an in-app surface, so the real (non-mock) panel
   * exists only for a signed-in session; App passes `user !== null`. */
  signedIn?: boolean;
  /** C3a: fired once per conversation end with the transcript turns (spec S5
   * memory extraction); the panel only forwards it to `useChat`. */
  onConversationEnd?: (turns: ChatTurn[]) => void;
  /** C3a: the no-key empty state's button — opens the Settings "AI" tab. */
  onSetupKey?: () => void;
  /** R1: planner data the action cards read (descriptions) and the confirm
   * flow validates against. */
  toolContext?: ChatToolContext;
  /** R1: runs one confirmed proposal through the app's data writes for the
   * signed-in user, returning the card outcome. Discard never writes and is
   * handled here. */
  onConfirmToolCall?: (call: ChatToolCall) => Promise<ToolOutcome>;
}) {
  const [mockQuery] = useState(() => new URLSearchParams(window.location.search).get("chatMock"));
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [showJump, setShowJump] = useState(false);

  // The mock transport is per-mount: its scenario is fixed by the URL.
  const [mockTransport] = useState(() => createMockTransport(mockMode(mockQuery)));
  const resolvedTransport = transport ?? (mockQuery !== null ? mockTransport : unwiredTransport);
  const resolvedPrompt = buildSystemPrompt ?? (() => "");
  const { state, send, stop, retry, newChat, resolveToolCall } = useChat({
    transport: resolvedTransport,
    buildSystemPrompt: resolvedPrompt,
    panelOpen: open,
    onConversationEnd,
  });
  const inFlight = state.phase !== "idle";
  const streaming = state.phase === "streaming";

  // Recomputed every render (review #2), never frozen at mount: signing in or
  // out flips the launcher and panel on the next App render.
  const dev = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV === true;
  const visible = chatPanelVisible({ desktop: isTauri(), dev, mockQuery, signedIn });
  // The panel's chord, read live from the shortcut registry (S2): a rebind in
  // Settings → Shortcuts takes effect at once, on every listening surface and
  // tab, without a reload.
  const chatChord = useShortcutBinding("chat");

  const launcherRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const sendButtonRef = useRef<HTMLButtonElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const stickyRef = useRef(true);
  /** The action card whose confirm write is running; others disable meanwhile.
   * The in-flight guard is a ref, not just this state: two rapid confirms on
   * the same card both run before React re-renders, and only the ref sees the
   * second one (one Confirm → exactly one write). */
  const [busyCallId, setBusyCallId] = useState<string | null>(null);
  const busyCallRef = useRef<string | null>(null);
  /** Whether the panel has been opened, so closing returns focus only then. */
  const openedOnce = useRef(false);
  const reduced = useReducedMotion();
  /** True while the 120 ms exit animation plays: the card stays displayed but
   * inert until `animationend` (or the fallback timer) hides it. */
  const [closing, setClosing] = useState(false);
  const closeFallback = useRef<number | null>(null);
  /** The latest open state, read by the gesture's declined-commit probe. */
  const openRef = useRef(open);
  openRef.current = open;
  // Swipe to dismiss (S1): the sheet's exact gesture language on the chat
  // panel. The header is the drag handle; listeners run only while the panel
  // is open. A commit flies the panel out, then closes it through the
  // ordinary path — the same `setOpen(false)` Esc and the close button use.
  useSwipeDismiss({
    surfaceRef: panelRef,
    handleSelector: ".chat-head",
    reduced,
    active: open,
    onDismiss: () => setOpen(false),
    closeStarted: () => !openRef.current,
  });
  /** The send button's rect at the last submit: the user bubble's flight
   * origin (S3). Consumed by the flight effect so it never re-flies. */
  const [sendOrigin, setSendOrigin] = useState<SendOrigin | null>(null);

  // No API key (S3, C3a): the desktop panel opens onto a setup empty state
  // instead of a chat that can only fail. Checked on every open: the panel
  // stays mounted for the whole session, so a key saved in Settings must be
  // seen the next time it opens, not after a restart.
  const [noKey, setNoKey] = useState(false);
  useEffect(() => {
    if (!open || mockQuery !== null || !isTauri()) return undefined;
    let alive = true;
    getKeyStatus()
      .then(status => {
        if (alive) setNoKey(!status.hasKey);
      })
      .catch(() => {
        // Rust unreachable (unexpected on desktop): keep the chat UI; the
        // first send reports the failure through the transport error path.
      });
    return () => {
      alive = false;
    };
  }, [open, mockQuery]);

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

  // The send flight measures after the scroll effect above, so it starts from
  // the slot the bubble actually lands in.
  const consumeOrigin = useCallback(() => setSendOrigin(null), []);
  useSendFlight(columnRef, sendOrigin, reduced, consumeOrigin);

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

  // The chat chord toggles the panel from anywhere, fields included (the
  // app's single-key router ignores modified keys, so there is no conflict to
  // arbitrate). The default is Ctrl+J; the registry owns the current value.
  useEffect(() => {
    if (!visible) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (!matchesEvent(chatChord, event)) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(current => !current);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [visible, chatChord]);

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
    // composer from re-taking it (review #3). When a reopen lands inside the
    // exit, the composer is still inert in this commit — the effect re-runs
    // once the exit is cancelled and focuses then.
    if (open) {
      openedOnce.current = true;
      if (!closing) fieldRef.current?.focus({ preventScroll: true });
    } else if (openedOnce.current) {
      openedOnce.current = false;
      launcherRef.current?.focus({ preventScroll: true });
    }
  }, [open, closing]);

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

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (text === "" || inFlight) return;
    // Measure the send button before the send swaps it for the stop button:
    // the bubble flies from where the user just clicked (S3). The composer
    // clears in the same commit, in sync with the flight.
    const button = sendButtonRef.current?.getBoundingClientRect();
    send(text);
    setDraft("");
    if (button !== undefined) {
      setSendOrigin({ left: button.left, top: button.top, width: button.width, height: button.height });
    }
  };

  const onFieldKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const canSend = draft.trim() !== "" && !inFlight;
  const isEmptyThread = state.turns.length === 0 && !inFlight && state.error === null;

  // R1: action cards. The description is computed from the raw arguments by
  // the pure describeToolCall — never from unvalidated data — and Confirm is
  // the only path that writes, through ChatSurface's executor. Discard writes
  // nothing, ever.
  const resolvedToolContext: ChatToolContext =
    toolContext ?? { tasks: [], timeZone: browserTimeZone, todayKey: dateKey(new Date(), browserTimeZone) };

  const confirmCard = useCallback(
    async (card: ToolCallCard) => {
      // One Confirm, one write: a card already in flight (the ref, set before
      // any await) or already resolved (its status) never confirms again.
      if (busyCallRef.current !== null || card.status !== "pending") return;
      busyCallRef.current = card.callId;
      setBusyCallId(card.callId);
      try {
        const outcome =
          (await onConfirmToolCall?.({ id: card.callId, name: card.name, arguments: card.arguments })) ??
          { status: "failed" as const, message: "Proposed actions need a signed-in session." };
        resolveToolCall(card.callId, outcome.status, outcome.message);
      } finally {
        busyCallRef.current = null;
        setBusyCallId(null);
      }
    },
    [onConfirmToolCall, resolveToolCall],
  );

  const discardCard = useCallback(
    (card: ToolCallCard) => {
      resolveToolCall(card.callId, "discarded");
    },
    [resolveToolCall],
  );

  // Only after every hook: `visible` flips false → true when the desktop
  // session restores, and an early return above a hook makes React throw #310
  // ("Rendered more hooks"), leaving the main window blank.
  if (!visible) return null;

  const renderCards = (turn: ChatTurn & { role: "assistant" }): ReactNode => (
    <>
      {turn.toolCalls?.map(card => (
        <ChatActionCard
          key={card.callId}
          card={card}
          description={describeToolCall(card, resolvedToolContext)}
          disabled={busyCallId !== null && busyCallId !== card.callId}
          busy={busyCallId === card.callId}
          onConfirm={() => void confirmCard(card)}
          onDiscard={() => discardCard(card)}
        />
      ))}
      {turn.callsDropped !== undefined && turn.callsDropped > 0 ? <CallsDroppedNote dropped={turn.callsDropped} /> : null}
    </>
  );

  const renderTurn = (turn: ChatTurn, index: number): ReactNode => {
    if (turn.role === "user") {
      return (
        <div className="chat-bubble chat-user" key={turn.id}>
          <span className="chat-user-text">{turn.text}</span>
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
        {turn.role === "assistant" ? renderCards(turn) : null}
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
        aria-keyshortcuts={ariaKeyShortcuts(chatChord)}
        onClick={() => setOpen(current => !current)}
      >
        <ChatIcon />
      </button>
      <section
        ref={panelRef}
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
              noKey ? (
                <div className="chat-empty">
                  <p className="chat-empty-hi">Your assistant is not set up yet.</p>
                  <h2 className="chat-empty-heading">Add an API key to start chatting.</h2>
                  <button type="button" className="chat-retry" onClick={() => onSetupKey?.()}>
                    Set up the assistant
                  </button>
                </div>
              ) : (
                <div className="chat-empty">
                  <p className="chat-empty-hi">Hi</p>
                  <h2 className="chat-empty-heading">What do you need?</h2>
                </div>
              )
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
                  {streamingTurn !== null && renderCards(streamingTurn)}
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
              <button ref={sendButtonRef} type="submit" className="chat-send" aria-label="Send" disabled={!canSend}>
                <SendIcon />
              </button>
            )}
          </form>
        </div>
      </section>
    </>
  );
}
