import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { authErrorKey } from "./authErrors.ts";

describe("authErrorKey", () => {
  const cases: [unknown, string][] = [
    [{ code: "auth/user-not-found" }, "auth.error.credentials"],
    [{ code: "auth/wrong-password" }, "auth.error.credentials"],
    [{ code: "auth/invalid-credential" }, "auth.error.credentials"],
    [{ code: "auth/email-already-in-use" }, "auth.error.emailInUse"],
    [{ code: "auth/weak-password" }, "auth.error.weakPassword"],
    [{ code: "auth/invalid-email" }, "auth.error.invalidEmail"],
    [{ code: "auth/too-many-requests" }, "auth.error.tooManyRequests"],
    [{ code: "auth/network-request-failed" }, "auth.error.network"],
    [{ code: "auth/user-token-expired" }, "auth.error.sessionExpired"],
  ];
  for (const [input, key] of cases) {
    it(`maps ${(input as { code: string }).code}`, () => assert.equal(authErrorKey(input), key));
  }
  it("falls back for unknown codes, plain errors and non-errors", () => {
    assert.equal(authErrorKey({ code: "auth/something-new" }), "auth.error.default");
    assert.equal(authErrorKey(new Error("Firebase: Error (auth/x).")), "auth.error.default");
    assert.equal(authErrorKey(null), "auth.error.default");
    assert.equal(authErrorKey("boom"), "auth.error.default");
  });
});
