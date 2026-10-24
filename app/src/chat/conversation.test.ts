import assert from "node:assert/strict";
import test from "node:test";
import type { ChatEvent } from "./types.ts";
import { createAnswerCallGate, emptyConversation, hasExchange, lastUserText, reduceConversation, type ConversationState } from "./conversation.ts";

const send = (state: ConversationState, id: string, text: string) => reduceConversation(state, { type: "send", id, text });
const event = (state: ConversationState, chatEvent: ChatEvent) => reduceConversation(state, { type: "event", event: chatEvent });

test("send appends the user turn and opens a pending request", () => {
  const state = send(emptyConversation, "r1", "  Hello there  ");
  assert.deepEqual(state.turns, [{ id: "ur1", role: "user", text: "Hello there" }]);
  assert.equal(state.phase, "pending");
  assert.equal(state.requestId, "r1");
  assert.equal(state.error, null);
});

test("a blank message never opens a request", () => {
  const state = send(emptyConversation, "r1", "   ");
  assert.deepEqual(state, emptyConversation);
});

test("a second send is ignored while a request is in flight", () => {
  const state = send(send(emptyConversation, "r1", "first"), "r2", "second");
  assert.equal(state.requestId, "r1");
  assert.equal(state.turns.length, 1);
});

test("reasoning moves pending to reasoning without adding a turn", () => {
  const state = event(send(emptyConversation, "r1", "hi"), {  type: "reasoning"  });
  assert.equal(state.phase, "reasoning");
  assert.equal(state.turns.length, 1);
});

test("the first delta opens the assistant turn, later deltas grow it", () => {
  let state = event(send(emptyConversation, "r1", "hi"), {  type: "delta", text: "He"  });
  assert.equal(state.phase, "streaming");
  assert.deepEqual(state.turns[1], { id: "ar1", role: "assistant", text: "He", segments: ["He"] });
  state = event(state, {  type: "delta", text: "llo"  });
  assert.deepEqual(state.turns[1], { id: "ar1", role: "assistant", text: "Hello", segments: ["He", "llo"] });
});

test("done closes the request and keeps the answer", () => {
  let state = event(send(emptyConversation, "r1", "hi"), {  type: "delta", text: "Answer"  });
  state = event(state, {  type: "done"  });
  assert.equal(state.phase, "idle");
  assert.equal(state.requestId, null);
  assert.equal((state.turns[1] as { text: string }).text, "Answer");
});

test("cancel during streaming keeps the partial answer", () => {
  let state = event(send(emptyConversation, "r1", "hi"), {  type: "delta", text: "Part"  });
  state = event(state, {  type: "cancelled"  });
  assert.equal(state.phase, "idle");
  assert.equal((state.turns[1] as { text: string }).text, "Part");
});

test("cancel before any text leaves no empty bubble", () => {
  let state = event(send(emptyConversation, "r1", "hi"), {  type: "reasoning"  });
  state = event(state, {  type: "cancelled"  });
  assert.equal(state.phase, "idle");
  assert.equal(state.turns.length, 1);
});

test("an error records the failure and closes the request", () => {
  const state = event(send(emptyConversation, "r1", "hi"), {  type: "error", code: "network", message: "offline"  });
  assert.deepEqual(state.error, { code: "network", message: "offline" });
  assert.equal(state.phase, "idle");
  assert.equal(state.requestId, null);
});

test("events after a stop are ignored: a late delta cannot reopen the stream", () => {
  let state = event(send(emptyConversation, "r1", "hi"), {  type: "delta", text: "Part"  });
  state = reduceConversation(state, { type: "stop" });
  assert.equal(state.phase, "idle");
  assert.equal(state.requestId, null);
  state = event(state, {  type: "delta", text: "More"  });
  state = event(state, {  type: "done"  });
  assert.equal((state.turns[1] as { text: string }).text, "Part");
  assert.equal(state.phase, "idle");
});

test("retry resends the last user turn under a fresh id and clears the error", () => {
  let state = event(send(emptyConversation, "r1", "hi"), {  type: "error", code: "network", message: "offline"  });
  state = reduceConversation(state, { type: "retry", id: "r2" });
  assert.deepEqual(state.turns.map(turn => turn.role), ["user", "user"]);
  assert.deepEqual(state.turns.map(turn => turn.id), ["ur1", "ur2"]);
  assert.equal(state.requestId, "r2");
  assert.equal(state.error, null);
});

test("retry with nothing to repeat is a no-op", () => {
  assert.deepEqual(reduceConversation(emptyConversation, { type: "retry", id: "r1" }), emptyConversation);
});

test("newChat returns to the empty conversation", () => {
  let state = event(send(emptyConversation, "r1", "hi"), {  type: "delta", text: "Answer"  });
  state = reduceConversation(state, { type: "newChat" });
  assert.deepEqual(state, emptyConversation);
});

test("lastUserText finds the most recent user turn", () => {
  let state = send(emptyConversation, "r1", "one");
  assert.equal(lastUserText(state), "one");
  state = event(state, {  type: "delta", text: "a"  });
  state = event(state, {  type: "done"  });
  state = send(state, "r2", "two");
  assert.equal(lastUserText(state), "two");
});

test("hasExchange: an exchange needs a user message and a non-empty answer (S5)", () => {
  assert.equal(hasExchange(emptyConversation.turns), false);
  assert.equal(hasExchange([{ id: "u1", role: "user", text: "hi" }]), false, "a lone user turn is not an exchange");
  assert.equal(hasExchange([{ id: "u1", role: "user", text: "hi" }, { id: "a1", role: "assistant", text: "", segments: [] }]), false, "an empty assistant turn (error, stop) is not an exchange");
  assert.equal(hasExchange([{ id: "u1", role: "user", text: "hi" }, { id: "a1", role: "assistant", text: "hello", segments: ["hello"] }]), true);
});

// --- tool calls → action cards (Ronda 3 R1, spec S1) ---

const toolCall = (id: string, name = "create_task") => ({ type: "tool_call" as const, call: { id, name, arguments: '{"title":"X"}' } });

const pendingCards = (state: ConversationState) => (state.turns.at(-1) as { toolCalls?: Array<{ callId: string; status: string }> }).toolCalls ?? [];

function streamWithCalls(...calls: Array<ChatEvent>): ConversationState {
  let state = event(send(emptyConversation, "r1", "hi"), { type: "delta", text: "Proposal:" });
  for (const chatEvent of calls) state = event(state, chatEvent);
  return event(state, { type: "done" });
}

test("a tool_call opens the assistant turn and renders as a pending card", () => {
  let state = event(send(emptyConversation, "r1", "hi"), toolCall("call_1"));
  assert.equal(state.phase, "streaming");
  state = event(state, { type: "done" });
  assert.equal(state.phase, "idle");
  const turn = state.turns[1];
  assert.equal(turn.role, "assistant");
  assert.deepEqual(pendingCards(state), [{ callId: "call_1", name: "create_task", arguments: '{"title":"X"}', status: "pending" }]);
});

test("a tool_call before any text still opens one answer turn", () => {
  const state = streamWithCalls(toolCall("call_1"));
  assert.equal(state.turns.length, 2);
  assert.equal((state.turns[1] as { text: string }).text, "Proposal:");
});

test("resolving a card updates it in place and never re-opens the stream", () => {
  let state = streamWithCalls(toolCall("call_1"));
  state = reduceConversation(state, { type: "toolCallResolved", callId: "call_1", status: "confirmed", outcome: "Task created." });
  assert.deepEqual(pendingCards(state), [{ callId: "call_1", name: "create_task", arguments: '{"title":"X"}', status: "confirmed", outcome: "Task created." }]);
  assert.equal(state.phase, "idle");
  state = reduceConversation(state, { type: "toolCallResolved", callId: "call_1", status: "failed", outcome: "offline" });
  assert.deepEqual(pendingCards(state), [{ callId: "call_1", name: "create_task", arguments: '{"title":"X"}', status: "failed", outcome: "offline" }]);
});

test("resolving an unknown call id is a no-op", () => {
  const state = streamWithCalls(toolCall("call_1"));
  assert.equal(reduceConversation(state, { type: "toolCallResolved", callId: "ghost", status: "discarded" }), state);
});

test("a repeated call id across turns resolves exactly one card", () => {
  // Two assistant turns whose cards carry the same id (a provider reusing
  // fallback ids): one Confirm resolves only the first card; the second
  // stays pending for its own answer.
  let state = streamWithCalls(toolCall("call_1"));
  state = send(state, "r2", "another");
  state = event(state, { type: "tool_call", call: { id: "call_1", name: "create_task", arguments: '{"title":"Y"}' } });
  state = event(state, { type: "done" });
  state = reduceConversation(state, { type: "toolCallResolved", callId: "call_1", status: "confirmed", outcome: "Task created." });
  const cards = state.turns.flatMap(turn => (turn.role === "assistant" ? turn.toolCalls ?? [] : []));
  assert.equal(cards.length, 2);
  assert.equal(cards[0]?.status, "confirmed");
  assert.equal(cards[1]?.status, "pending");
});

test("at most five cards render; extras are dropped and counted for the note", () => {
  const calls = Array.from({ length: 7 }, (_, i) => toolCall(`call_${i}`));
  const state = streamWithCalls(...calls);
  assert.equal(pendingCards(state).length, 5);
  assert.equal((state.turns[1] as { callsDropped?: number }).callsDropped, 2);
});

test("a call id repeated inside one answer is dropped like an over-cap call", () => {
  // A provider that reuses an id within one answer must not get a second
  // card: it would resolve with the first (one Confirm resolves the first
  // match) and its tool message would claim a write that never happened.
  const state = streamWithCalls(toolCall("call_1"), toolCall("call_1", "delete_task"));
  const cards = state.turns.flatMap(turn => (turn.role === "assistant" ? turn.toolCalls ?? [] : []));
  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.name, "create_task");
  assert.equal((state.turns[1] as { callsDropped?: number }).callsDropped, 1);
});

test("createAnswerCallGate mirrors the reducer's cap and duplicate decisions for reads", () => {
  // The hook consults this before executing a proposed read, because the
  // reducer may not have processed the answer's earlier events yet when the
  // next one arrives (the 6th read must never execute).
  const gate = createAnswerCallGate();
  const accepted = ["c1", "c2", "c3", "c4", "c5"].map(id => gate(id));
  assert.deepEqual(accepted, [true, true, true, true, true]);
  assert.equal(gate("c6"), false, "the 6th proposal is past the cap");
  assert.equal(gate("c1"), false, "a duplicate id never renders a second card");
  assert.equal(gate("c7"), false, "the cap stays closed");
  assert.equal(gate("c1"), false, "duplicates stay rejected after the cap too");
});

test("a card resolved while a later request streams keeps its state", () => {
  // The user acts on an old card while a new reply is streaming: the old
  // turn's card must update, the streaming turn's must not be touched.
  let state = streamWithCalls(toolCall("call_1"));
  state = send(state, "r2", "another");
  state = event(state, { type: "delta", text: "Working" });
  state = reduceConversation(state, { type: "toolCallResolved", callId: "call_1", status: "discarded" });
  assert.deepEqual(pendingCards({ ...state, turns: state.turns.slice(0, 2) }), [{ callId: "call_1", name: "create_task", arguments: '{"title":"X"}', status: "discarded" }]);
});
