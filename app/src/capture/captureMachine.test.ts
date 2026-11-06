import assert from "node:assert/strict";
import test from "node:test";
import type { ChatErrorCode, ChatEvent, ChatRequest, ChatTransport } from "../chat/types.ts";
import { createCaptureController, idleCapture, reduceCapture, type CaptureDeps, type CaptureState } from "./captureMachine.ts";

const now = new Date("2026-11-06T15:00:00Z");
const zone = "America/Argentina/Buenos_Aires";
const PASTE = "Hi Mateo, please send the Q3 budget to Lucía before Friday 14 November. It should take about 45 minutes.";

type Fake = ChatTransport & {
  streams: Array<{ request: ChatRequest; emit: (event: ChatEvent) => void; resolve: () => void; reject: (error: unknown) => void }>;
  cancels: string[];
};

function fakeTransport(): Fake {
  const streams: Fake["streams"] = [];
  const cancels: string[] = [];
  return {
    streams,
    cancels,
    stream(request, onEvent) {
      return new Promise<void>((resolve, reject) => {
        streams.push({ request, emit: onEvent, resolve, reject });
      });
    },
    async cancel(id) {
      cancels.push(id);
    },
    async complete() {
      throw new Error("complete() must not be used: it has a 5 s read timeout");
    },
  };
}

type Timer = { id: number; ms: number; run: () => void };

function fakeClock() {
  const timers: Timer[] = [];
  let next = 1;
  return {
    timers,
    setTimeout: (run: () => void, ms: number) => {
      const timer = { id: next++, ms, run };
      timers.push(timer);
      return timer.id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (handle: ReturnType<typeof setTimeout> | undefined) => {
      const index = timers.findIndex(timer => timer.id === (handle as unknown as number));
      if (index >= 0) timers.splice(index, 1);
    },
    fire(ms: number) {
      const timer = timers.find(entry => entry.ms === ms);
      assert.ok(timer, `a ${ms} ms timer is pending`);
      timers.splice(timers.indexOf(timer), 1);
      timer.run();
    },
  };
}

function setup(overrides: Partial<CaptureDeps> = {}) {
  const transport = fakeTransport();
  const clock = fakeClock();
  const deps: CaptureDeps = {
    transport,
    hasKey: async () => true,
    isOnline: () => true,
    now: () => now,
    timeZone: () => zone,
    model: () => "test-model",
    timeoutMs: 90_000,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    ...overrides,
  };
  const controller = createCaptureController(deps);
  const states: CaptureState[] = [];
  controller.subscribe(() => states.push(controller.getState()));
  return { transport, clock, controller, states };
}

const settle = () => new Promise<void>(resolve => setImmediate(resolve));

const REPLY = JSON.stringify({
  tasks: [{ title: "Send the Q3 budget to Lucía", dueDay: "2026-11-14", startTime: null, estimateMinutes: 45, quote: "send the Q3 budget to Lucía before Friday" }],
});

function deliver(fake: Fake, reply: string, index = 0) {
  const stream = fake.streams[index];
  for (let at = 0; at < reply.length; at += 7) stream.emit({ type: "delta", text: reply.slice(at, at + 7) });
  stream.emit({ type: "done" });
  stream.resolve();
}

test("assistant events become a proposals state and nothing else", async () => {
  const { transport, controller } = setup();
  controller.start(PASTE);
  await settle();
  assert.equal(controller.getState().phase, "reading");
  assert.equal(transport.streams.length, 1);
  const { request } = transport.streams[0];
  assert.equal(request.model, "test-model");
  assert.equal(request.tools, undefined);
  assert.equal(request.messages.length, 2);
  assert.match(request.messages[1].content, /Today is 2026-11-06 \(Friday\)/);
  assert.ok(request.messages[1].content.includes(PASTE));
  transport.streams[0].emit({ type: "reasoning" });
  deliver(transport, REPLY);
  await settle();
  const state = controller.getState();
  assert.equal(state.phase, "proposals");
  if (state.phase !== "proposals") return;
  assert.equal(state.source, "assistant");
  assert.equal(state.reason, null);
  assert.deepEqual(state.tasks.map(task => [task.title, task.dueDay, task.estimateMinutes]), [["Send the Q3 budget to Lucía", "2026-11-14", 45]]);
  assert.equal(transport.cancels.length, 0);
});

test("it sends only the pasted text and the date: no tools, no planner data", async () => {
  const { transport, controller } = setup();
  controller.start("buy milk");
  await settle();
  const { request } = transport.streams[0];
  assert.equal(Object.hasOwn(request, "tools"), false);
  assert.deepEqual(request.messages.map(message => message.role), ["system", "user"]);
});

test("a model that finds nothing is a legitimate empty answer, not a fallback", async () => {
  const { transport, controller } = setup();
  controller.start("see you at the party!");
  await settle();
  deliver(transport, '{"tasks":[]}');
  await settle();
  const state = controller.getState();
  assert.equal(state.phase === "proposals" && state.source, "assistant");
  assert.equal(state.phase === "proposals" && state.reason, null);
  assert.equal(state.phase === "proposals" && state.tasks.length, 0);
});

test("never auto-creates: the machine ends in proposals and has no write dependency", async () => {
  const { transport, controller } = setup();
  controller.start(PASTE);
  await settle();
  deliver(transport, REPLY);
  await settle();
  assert.equal(controller.getState().phase, "proposals");
  assert.deepEqual(Object.keys(setup().controller).sort(), ["cancel", "getState", "reset", "start", "subscribe"]);
});

const ERROR_REASONS: Array<[ChatErrorCode, string]> = [
  ["unauthorized", "unauthorized"],
  ["rate_limited", "rate_limited"],
  ["network", "network"],
  ["provider", "provider"],
  ["invalid_request", "provider"],
  ["credential_store_unavailable", "credential_store_unavailable"],
  ["no_key", "no_key"],
];

for (const [code, reason] of ERROR_REASONS) {
  test(`stream error ${code} reaches the on-device result with reason ${reason}`, async () => {
    const { transport, controller } = setup();
    controller.start("Subject: Pay the electricity bill\n\nHello,\nit is due on 2026-11-20.");
    await settle();
    transport.streams[0].emit({ type: "error", code, message: "boom" });
    transport.streams[0].resolve();
    await settle();
    const state = controller.getState();
    assert.equal(state.phase, "proposals");
    if (state.phase !== "proposals") return;
    assert.equal(state.source, "device");
    assert.equal(state.reason, reason);
    assert.equal(state.tasks[0]?.title, "Pay the electricity bill");
  });
}

test("a rejected stream promise maps its code, or falls back to provider", async () => {
  const first = setup();
  first.controller.start("Call the bank");
  await settle();
  first.transport.streams[0].reject({ code: "rate_limited", message: "slow down" });
  await settle();
  const firstState = first.controller.getState();
  assert.equal(firstState.phase === "proposals" && firstState.reason, "rate_limited");

  const second = setup();
  second.controller.start("Call the bank");
  await settle();
  second.transport.streams[0].reject(new Error("ipc down"));
  await settle();
  const secondState = second.controller.getState();
  assert.equal(secondState.phase === "proposals" && secondState.reason, "provider");
});

test("a stream that resolves without a terminal event is a provider failure", async () => {
  const { transport, controller } = setup();
  controller.start("Call the bank");
  await settle();
  transport.streams[0].resolve();
  await settle();
  const state = controller.getState();
  assert.equal(state.phase === "proposals" && state.reason, "provider");
});

test("unparseable output falls back to the on-device reading with its own reason", async () => {
  const { transport, controller } = setup();
  controller.start("Call the bank on Monday");
  await settle();
  deliver(transport, "I am sorry, I cannot help with that.");
  await settle();
  const state = controller.getState();
  assert.equal(state.phase === "proposals" && state.source, "device");
  assert.equal(state.phase === "proposals" && state.reason, "unparseable");
  assert.ok(state.phase === "proposals" && state.tasks.length > 0);
});

test("an all-invalid reply is unparseable too", async () => {
  const { transport, controller } = setup();
  controller.start("Call the bank");
  await settle();
  deliver(transport, '{"tasks":[{"title":""},{"nope":1}]}');
  await settle();
  const state = controller.getState();
  assert.equal(state.phase === "proposals" && state.reason, "unparseable");
});

test("no transport (web) reads on the device and never streams", async () => {
  const { controller, states } = setup({ transport: null });
  controller.start("Subject: Renew passport");
  await settle();
  const state = controller.getState();
  assert.equal(state.phase, "proposals");
  if (state.phase !== "proposals") return;
  assert.equal(state.source, "device");
  assert.equal(state.reason, "web");
  assert.equal(state.tasks[0]?.title, "Renew passport");
  assert.ok(states.length >= 1);
});

test("offline never calls stream", async () => {
  const { transport, controller } = setup({ isOnline: () => false });
  controller.start("Subject: Renew passport");
  await settle();
  assert.equal(transport.streams.length, 0);
  const state = controller.getState();
  assert.equal(state.phase === "proposals" && state.reason, "offline");
  assert.equal(state.phase === "proposals" && state.source, "device");
});

test("no key reads on the device and never streams", async () => {
  const { transport, controller } = setup({ hasKey: async () => false });
  controller.start("Subject: Renew passport");
  await settle();
  assert.equal(transport.streams.length, 0);
  const state = controller.getState();
  assert.equal(state.phase === "proposals" && state.reason, "no_key");
});

test("a failing key lookup still tries the stream, which reports the real error", async () => {
  const { transport, controller } = setup({
    hasKey: async () => {
      throw new Error("keyring locked");
    },
  });
  controller.start("Subject: Renew passport");
  await settle();
  assert.equal(transport.streams.length, 1);
});

test("truncation and the cap travel with the proposals", async () => {
  const { transport, controller } = setup();
  controller.start("x".repeat(13_000));
  await settle();
  deliver(transport, REPLY);
  await settle();
  const state = controller.getState();
  assert.equal(state.phase === "proposals" && state.truncated, true);
});

test("cancel calls transport.cancel, returns to idle and ignores late events", async () => {
  const { transport, clock, controller } = setup();
  controller.start(PASTE);
  await settle();
  const id = transport.streams[0].request.id;
  controller.cancel();
  assert.deepEqual(transport.cancels, [id]);
  assert.deepEqual(controller.getState(), idleCapture);
  assert.equal(clock.timers.length, 0, "the timeout is cleared");
  transport.streams[0].emit({ type: "cancelled" });
  deliver(transport, REPLY);
  await settle();
  assert.deepEqual(controller.getState(), idleCapture);
});

test("cancel while idle or finished does nothing", async () => {
  const { transport, controller } = setup();
  controller.cancel();
  assert.equal(transport.cancels.length, 0);
  controller.start(PASTE);
  await settle();
  deliver(transport, REPLY);
  await settle();
  controller.cancel();
  assert.equal(transport.cancels.length, 0);
  assert.equal(controller.getState().phase, "proposals");
});

test("a new start supersedes the running request: the old one is cancelled and its late events are ignored", async () => {
  const { transport, controller } = setup();
  controller.start("first paste");
  await settle();
  controller.start("Subject: second paste");
  await settle();
  assert.equal(transport.streams.length, 2);
  assert.deepEqual(transport.cancels, [transport.streams[0].request.id]);
  assert.notEqual(transport.streams[0].request.id, transport.streams[1].request.id);
  deliver(transport, JSON.stringify({ tasks: [{ title: "Stale task" }] }), 0);
  await settle();
  assert.equal(controller.getState().phase, "reading");
  deliver(transport, JSON.stringify({ tasks: [{ title: "Fresh task" }] }), 1);
  await settle();
  const state = controller.getState();
  assert.equal(state.phase === "proposals" && state.tasks[0]?.title, "Fresh task");
});

test("the 90 s timeout cancels the request and falls back with reason timeout", async () => {
  const { transport, clock, controller } = setup();
  controller.start("Subject: Renew passport");
  await settle();
  clock.fire(90_000);
  await settle();
  assert.deepEqual(transport.cancels, [transport.streams[0].request.id]);
  const state = controller.getState();
  assert.equal(state.phase === "proposals" && state.reason, "timeout");
  assert.equal(state.phase === "proposals" && state.tasks[0]?.title, "Renew passport");
  transport.streams[0].emit({ type: "cancelled" });
  await settle();
  assert.equal(controller.getState(), state);
});

test("finishing clears the timeout", async () => {
  const { transport, clock, controller } = setup();
  controller.start(PASTE);
  await settle();
  assert.equal(clock.timers.length, 1);
  deliver(transport, REPLY);
  await settle();
  assert.equal(clock.timers.length, 0);
});

test("blank input is ignored; reset returns to idle", async () => {
  const { transport, controller } = setup();
  controller.start("   \n ");
  await settle();
  assert.deepEqual(controller.getState(), idleCapture);
  assert.equal(transport.streams.length, 0);
  controller.start("Subject: Renew passport");
  await settle();
  controller.reset();
  assert.deepEqual(controller.getState(), idleCapture);
  assert.equal(transport.cancels.length, 1);
});

test("the reducer drops a result for a request that is not the current one", () => {
  const reading = reduceCapture(idleCapture, { type: "begin", requestId: "a" });
  const stale = reduceCapture(reading, {
    type: "result",
    requestId: "b",
    source: "device",
    reason: "offline",
    tasks: [],
    truncated: false,
    capped: false,
    dropped: 0,
  });
  assert.equal(stale, reading);
});

test("a console spy never sees the pasted text, the model reply or anything at all", async () => {
  const secret = "ZEBRA-7731 confidential: wire 9,000 to account 55-1234 before Friday";
  const calls: unknown[][] = [];
  const methods = ["log", "info", "warn", "error", "debug", "trace"] as const;
  const originals = methods.map(method => console[method]);
  for (const method of methods) console[method] = (...args: unknown[]) => void calls.push(args);
  try {
    const failing = setup();
    failing.controller.start(secret);
    await settle();
    failing.transport.streams[0].emit({ type: "error", code: "provider", message: `echo ${secret}` });
    failing.transport.streams[0].resolve();
    await settle();

    const junk = setup();
    junk.controller.start(secret);
    await settle();
    deliver(junk.transport, `not json ${secret}`);
    await settle();

    const rejected = setup();
    rejected.controller.start(secret);
    await settle();
    rejected.transport.streams[0].reject(new Error(secret));
    await settle();

    const web = setup({ transport: null });
    web.controller.start(secret);
    await settle();

    const ok = setup();
    ok.controller.start(secret);
    await settle();
    deliver(ok.transport, JSON.stringify({ tasks: [{ title: "Wire the money", quote: secret }] }));
    await settle();
  } finally {
    methods.forEach((method, index) => {
      console[method] = originals[index];
    });
  }
  assert.equal(JSON.stringify(calls).includes("ZEBRA"), false);
  assert.deepEqual(calls, []);
});

test("a reply beyond the length cap stops the stream and the device answers as unparseable", async () => {
  const { transport, controller } = setup();
  controller.start(PASTE);
  await settle();
  transport.streams[0].emit({ type: "delta", text: "x".repeat(70_000) });
  await settle();
  const state = controller.getState();
  assert.equal(state.phase, "proposals");
  assert.ok(state.phase === "proposals" && state.source === "device" && state.reason === "unparseable");
  assert.deepEqual(transport.cancels, [transport.streams[0].request.id]);
});

test("a prompt that cannot be built falls back to the device instead of staying in reading", async () => {
  const { controller } = setup({ timeZone: () => "Not/AZone" });
  controller.start(PASTE);
  await settle();
  const state = controller.getState();
  assert.equal(state.phase, "proposals");
  assert.ok(state.phase === "proposals" && state.source === "device" && state.reason === "provider");
});
