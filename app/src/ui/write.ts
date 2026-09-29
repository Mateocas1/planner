/**
 * Offline-first write settling. Firestore applies a write to the local cache
 * at once but only resolves its promise when the server acknowledges it, which
 * never happens while offline. A form must not wait for that: it closes as
 * soon as the write is accepted locally. Validation errors still surface in
 * the form, because the data helpers throw before any write and so reject
 * immediately. A rejection that arrives later is reported to the shell, which
 * shows it, instead of being lost with the closed form.
 */
const acceptBeatMs = 150;

export const writeErrorEvent = "planner-write-error";

export async function settle(write: Promise<unknown>): Promise<void> {
  let settled = false;
  const tracked = write.then(
    () => {
      settled = true;
    },
    (cause: unknown) => {
      if (settled) {
        const message = cause instanceof Error ? cause.message : "A change could not be saved.";
        window.dispatchEvent(new CustomEvent(writeErrorEvent, { detail: message }));
        return;
      }
      settled = true;
      throw cause;
    },
  );
  await Promise.race([
    tracked,
    new Promise<void>(resolve =>
      window.setTimeout(() => {
        settled = true;
        resolve();
      }, acceptBeatMs),
    ),
  ]);
}
