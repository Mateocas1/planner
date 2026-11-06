import { authErrorKey, type AuthErrorKey } from "./authErrors.ts";

/** One `@` with text on both sides and no spaces; Firebase judges the rest. */
const plausibleEmail = /^[^\s@]+@[^\s@]+$/;

export type ResetOutcome = { ok: true } | { ok: false; error: AuthErrorKey };

/** Firebase's reset call; `client.ts` is loaded lazily so Node tests can import this module. */
async function sendResetEmail(email: string) {
  const [{ sendPasswordResetEmail }, { auth }] = await Promise.all([import("firebase/auth"), import("./client.ts")]);
  await sendPasswordResetEmail(auth, email);
}

/**
 * Asks Firebase to email a password-reset link. An unknown address reports the
 * same success as a known one, so the form never reveals which emails have an
 * account.
 */
export async function requestPasswordReset(
  email: string,
  send: (email: string) => Promise<void> = sendResetEmail,
): Promise<ResetOutcome> {
  const address = email.trim();
  if (!plausibleEmail.test(address)) return { ok: false, error: "auth.error.invalidEmail" };
  try {
    await send(address);
    return { ok: true };
  } catch (cause) {
    const code = typeof cause === "object" && cause !== null ? (cause as { code?: unknown }).code : undefined;
    if (code === "auth/user-not-found") return { ok: true };
    if (code === "auth/missing-email") return { ok: false, error: "auth.error.invalidEmail" };
    const error = authErrorKey(cause);
    return { ok: false, error: error === "auth.error.default" ? "auth.error.resetDefault" : error };
  }
}
