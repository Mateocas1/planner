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
    { kind: "day", date: "2026-02-30" },
    { kind: "day", date: "2026-13-01" },
    { kind: "day", date: "2026-00-10" },
    { kind: "day", date: "2025-02-29" },
    { kind: "day", date: "1969-12-31" },
    { kind: "day", date: "2101-01-01" },
    { kind: "url", url: "https://evil.example" },
  ]) {
    assert.equal(parseDeepLinkRoute(payload), null, JSON.stringify(payload));
  }
});

test("leap days are real days", () => {
  assert.deepEqual(parseDeepLinkRoute({ kind: "day", date: "2028-02-29" }), { kind: "day", date: "2028-02-29" });
  assert.equal(parseDeepLinkRoute({ kind: "day", date: "2100-02-29" }), null);
});
