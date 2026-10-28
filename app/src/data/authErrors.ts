import type { MessageKey } from "../i18n/index.ts";

/**
 * Firebase auth error code -> the dictionary key of a sentence a person can act
 * on. The SDK message ("Firebase: Error (auth/...)") is never shown.
 */
const byCode: Record<string, MessageKey> = {
  "auth/user-not-found": "auth.error.credentials",
  "auth/wrong-password": "auth.error.credentials",
  "auth/invalid-credential": "auth.error.credentials",
  "auth/email-already-in-use": "auth.error.emailInUse",
  "auth/weak-password": "auth.error.weakPassword",
  "auth/invalid-email": "auth.error.invalidEmail",
  "auth/too-many-requests": "auth.error.tooManyRequests",
  "auth/network-request-failed": "auth.error.network",
  "auth/user-token-expired": "auth.error.sessionExpired",
};

export function authErrorKey(cause: unknown): MessageKey {
  const code = typeof cause === "object" && cause !== null ? (cause as { code?: unknown }).code : undefined;
  return (typeof code === "string" && byCode[code]) || "auth.error.default";
}
