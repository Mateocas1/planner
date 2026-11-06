import assert from "node:assert/strict";
import test from "node:test";
import type { ChatEvent, ChatRequest } from "../chat/types.ts";
import { createCaptureController } from "./captureMachine.ts";
import { captureMockScenario, createCaptureMock } from "./captureMock.ts";
import { buildCapturePrompt } from "./prompt.ts";

const now = new Date("2026-11-06T15:00:00Z");
const zone = "America/Argentina/Buenos_Aires";
const PASTE = "Send the Q3 budget to Lucía before Friday.\nBook the dentist for next week.\nWater the plants.";

function request(text = PASTE): ChatRequest {
  return { id: "capture-test", model: "m", messages: buildCapturePrompt({ text, now, timeZone: zone }).messages };
}

async function run(scenario: Parameters<typeof createCaptureMock>[0], text?: string): Promise<ChatEvent[]> {
  const { transport } = createCaptureMock(scenario, { stepMs: 0 });
  const events: ChatEvent[] = [];
  await transport.stream(request(text), event => events.push(event));
  return events;
}

const reply = (events: ChatEvent[]) => events.flatMap(event => (event.type === "delta" ? [event.text] : [])).join("");

test("captureMockScenario reads the dev query value", () => {
  assert.equal(captureMockScenario(null), null);
  assert.equal(captureMockScenario("ok"), "ok");
  assert.equal(captureMockScenario("nokey"), "nokey");
  assert.equal(captureMockScenario("error"), "error");
  assert.equal(captureMockScenario("ratelimit"), "ratelimit");
  assert.equal(captureMockScenario("junk"), "junk");
  assert.equal(captureMockScenario("hang"), "hang");
  assert.equal(captureMockScenario(""), "ok");
  assert.equal(captureMockScenario("whatever"), "ok");
});

test("ok streams reasoning, JSON deltas of tasks drawn from the pasted lines, then done", async () => {
  const events = await run("ok");
  assert.equal(events[0].type, "reasoning");
  assert.equal(events.at(-1)?.type, "done");
  const parsed = JSON.parse(reply(events)) as { tasks: Array<{ title: string; quote: string }> };
  assert.equal(parsed.tasks.length, 2);
  assert.equal(parsed.tasks[0].title, "Send the Q3 budget to Lucía before Friday.");
  assert.equal(parsed.tasks[0].quote, "Send the Q3 budget to Lucía before Friday.");
});

test("error, ratelimit emit one terminal error with the matching code", async () => {
  const error = await run("error");
  const last = error.at(-1);
  assert.equal(last?.type === "error" && last.code, "provider");
  assert.equal(error.filter(event => event.type === "done").length, 0);
  const limited = await run("ratelimit");
  assert.equal(limited.at(-1)?.type === "error" && (limited.at(-1) as { code: string }).code, "rate_limited");
  assert.equal(limited.filter(event => event.type === "done").length, 0);
});

test("junk streams prose that is not JSON", async () => {
  const events = await run("junk");
  assert.equal(events.at(-1)?.type, "done");
  assert.equal(reply(events).includes("{"), false);
});

test("nokey reports no key through hasKey and never streams", async () => {
  const mock = createCaptureMock("nokey", { stepMs: 0 });
  assert.equal(await mock.hasKey(), false);
  assert.equal(await createCaptureMock("ok", { stepMs: 0 }).hasKey(), true);
});

test("hang waits until cancelled, then emits cancelled", async () => {
  const { transport } = createCaptureMock("hang", { stepMs: 0 });
  const events: ChatEvent[] = [];
  const done = transport.stream(request(), event => events.push(event));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(events.map(event => event.type), ["reasoning"]);
  await transport.cancel("capture-test");
  await done;
  assert.equal(events.at(-1)?.type, "cancelled");
});

test("the mock records the last request for browser tests and complete() is refused", async () => {
  const mock = createCaptureMock("ok", { stepMs: 0 });
  await mock.transport.stream(request(), () => undefined);
  assert.equal(mock.transport.__lastStreamRequest?.id, "capture-test");
  await assert.rejects(mock.transport.complete(request()));
});

test("the controller turns the ok mock into proposals end to end", async () => {
  const mock = createCaptureMock("ok", { stepMs: 0 });
  const controller = createCaptureController({
    transport: mock.transport,
    hasKey: mock.hasKey,
    isOnline: () => true,
    now: () => now,
    timeZone: () => zone,
    model: () => "m",
    timeoutMs: 90_000,
  });
  controller.start(PASTE);
  for (let attempt = 0; attempt < 50 && controller.getState().phase !== "proposals"; attempt++) await new Promise(resolve => setTimeout(resolve, 2));
  const state = controller.getState();
  assert.equal(state.phase, "proposals");
  if (state.phase !== "proposals") return;
  assert.equal(state.source, "assistant");
  assert.equal(state.tasks.length, 2);
  assert.equal(state.tasks[0].dueDay, "2026-11-06");
  assert.equal(state.tasks[0].estimateMinutes, 45);
});
