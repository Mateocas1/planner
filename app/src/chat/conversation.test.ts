import assert from "node:assert/strict";
import test from "node:test";
import type { ChatEvent } from "./types.ts";
import { emptyConversation, hasExchange, lastUserText, reduceConversation, type ConversationState } from "./conversation.ts";

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
