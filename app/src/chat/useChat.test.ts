import assert from "node:assert/strict";
import test from "node:test";
import { buildMessages } from "./useChat.ts";
import type { ChatTurn } from "./conversation.ts";

const user = (text: string): ChatTurn => ({ id: "u1", role: "user", text });
const answer = (text: string): ChatTurn => ({ id: "a1", role: "assistant", text, segments: [text] });

test("buildMessages: a plain conversation is system, user and assistant turns", () => {
  const messages = buildMessages("sys", [user("hi"), answer("hello")]);
  assert.deepEqual(
    messages.map(message => [message.role, message.content]),
    [
      ["system", "sys"],
      ["user", "hi"],
      ["assistant", "hello"],
    ],
  );
  assert.ok(messages.every(message => message.tools === undefined));
});

test("buildMessages: an empty assistant turn (a stop before any text) is not sent", () => {
  const messages = buildMessages("sys", [user("hi"), answer("")]);
  assert.deepEqual(messages.map(message => message.role), ["system", "user"]);
});

test("buildMessages: tool calls ride on the assistant turn, one tool message per call", () => {
  const turn: ChatTurn = {
    id: "a1",
    role: "assistant",
    text: "Proposing:",
    segments: ["Proposing:"],
    toolCalls: [
      { callId: "c1", name: "create_task", arguments: '{"title":"X"}', status: "confirmed", outcome: "Task created." },
      { callId: "c2", name: "move_task", arguments: '{"taskId":"t1","day":null}', status: "discarded" },
    ],
  };
  const messages = buildMessages("sys", [user("hi"), turn]);
  assert.deepEqual(messages.map(message => message.role), ["system", "user", "assistant", "tool", "tool"]);
  assert.deepEqual(messages[2]?.toolCalls, [
    { id: "c1", name: "create_task", arguments: '{"title":"X"}' },
    { id: "c2", name: "move_task", arguments: '{"taskId":"t1","day":null}' },
  ]);
  assert.equal(messages[3]?.toolCallId, "c1");
  assert.match(messages[3]?.content ?? "", /applied/i);
  assert.equal(messages[4]?.toolCallId, "c2");
  assert.match(messages[4]?.content ?? "", /discarded/i);
});

test("buildMessages: a turn with only tool calls (no text) is still sent", () => {
  const turn: ChatTurn = {
    id: "a1",
    role: "assistant",
    text: "",
    segments: [],
    toolCalls: [{ callId: "c1", name: "create_task", arguments: "{}", status: "pending" }],
  };
  const messages = buildMessages("sys", [user("hi"), turn]);
  assert.deepEqual(messages.map(message => message.role), ["system", "user", "assistant", "tool"]);
  assert.equal(messages[2]?.content, "");
});

test("buildMessages: a pending card answers as not yet done, keeping the protocol valid", () => {
  const turn: ChatTurn = {
    id: "a1",
    role: "assistant",
    text: "Proposing:",
    segments: [],
    toolCalls: [{ callId: "c1", name: "create_task", arguments: "{}", status: "pending" }],
  };
  const messages = buildMessages("sys", [user("hi"), turn]);
  assert.match(messages.at(-1)?.content ?? "", /not answered/);
});
