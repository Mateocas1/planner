import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { requestPasswordReset } from "./auth.ts";

const failWith = (code: string) => async () => {
  throw Object.assign(new Error(`Firebase: Error (${code}).`), { code });
};

describe("requestPasswordReset", () => {
  it("sends to the trimmed address and reports success", async () => {
    const sent: string[] = [];
    const outcome = await requestPasswordReset("  ana@example.com ", async email => void sent.push(email));
    assert.deepEqual(outcome, { ok: true });
    assert.deepEqual(sent, ["ana@example.com"]);
  });

  it("reports the same success when no account uses the address", async () => {
    assert.deepEqual(await requestPasswordReset("nobody@example.com", failWith("auth/user-not-found")), { ok: true });
  });

  it("rejects an empty address without sending", async () => {
    let called = false;
    const outcome = await requestPasswordReset("   ", async () => void (called = true));
    assert.deepEqual(outcome, { ok: false, error: "auth.error.invalidEmail" });
    assert.equal(called, false);
  });

  it("rejects a malformed address without sending", async () => {
    for (const email of ["not-an-email", "a@", "@b.com", "a b@c.com"]) {
      let called = false;
      const outcome = await requestPasswordReset(email, async () => void (called = true));
      assert.deepEqual(outcome, { ok: false, error: "auth.error.invalidEmail" }, email);
      assert.equal(called, false, email);
    }
  });

  it("maps invalid, missing, network and throttling errors", async () => {
    const cases: [string, string][] = [
      ["auth/invalid-email", "auth.error.invalidEmail"],
      ["auth/missing-email", "auth.error.invalidEmail"],
      ["auth/network-request-failed", "auth.error.network"],
      ["auth/too-many-requests", "auth.error.tooManyRequests"],
    ];
    for (const [code, error] of cases) {
      assert.deepEqual(await requestPasswordReset("a@example.com", failWith(code)), { ok: false, error });
    }
  });

  it("falls back to a reset-specific message for anything else", async () => {
    assert.deepEqual(await requestPasswordReset("a@example.com", failWith("auth/internal-error")), {
      ok: false,
      error: "auth.error.resetDefault",
    });
    assert.deepEqual(await requestPasswordReset("a@example.com", async () => { throw "boom"; }), {
      ok: false,
      error: "auth.error.resetDefault",
    });
  });
});
