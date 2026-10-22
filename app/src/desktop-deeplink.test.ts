import assert from "node:assert/strict";
import test from "node:test";
import { parseDeepLinkRoute } from "./desktop-deeplink.ts";

test("only the two known route shapes are accepted", () => {
  assert.deepEqual(parseDeepLinkRoute({ kind: "today" }), { kind: "today" });
  assert.deepEqual(parseDeepLinkRoute({ kind: "day", date: "2026-10-22" }), { kind: "day", date: "2026-10-22" });
});

test("anything else is dropped", () => {
  for (const payload of [
    null,
    undefined,
    "today",
    42,
    {},
    { kind: "settings" },
    { kind: "day" },
    { kind: "day", date: 20261022 },
    { kind: "day", date: "2026-10-22T00:00" },
    { kind: "day", date: "javascript:alert(1)" },
    { kind: "url", url: "https://evil.example" },
  ]) {
    assert.equal(parseDeepLinkRoute(payload), null, JSON.stringify(payload));
  }
});
