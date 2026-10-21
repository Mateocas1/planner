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

/**
 * Tracks one write to the beat of local acceptance. Resolves once the write is
 * accepted locally (or the beat passes, which is what makes an offline close
 * work); rethrows a rejection that beat the accept; reports a rejection that
 * arrives after it to `onLate`, because by then the caller has already closed.
 */
function track(write: Promise<unknown>, onLate: (message: string) => void): Promise<void> {
  let settled = false;
  const tracked = write.then(
    () => {
      settled = true;
    },
    (cause: unknown) => {
      const message = cause instanceof Error ? cause.message : "A change could not be saved.";
      if (settled) {
        onLate(message);
        return;
      }
      settled = true;
      throw cause;
    },
  );
  return Promise.race([
    tracked,
    new Promise<void>(resolve =>
      window.setTimeout(() => {
        settled = true;
        resolve();
      }, acceptBeatMs),
    ),
  ]);
}

export async function settle(write: Promise<unknown>): Promise<void> {
  await track(write, message => window.dispatchEvent(new CustomEvent(writeErrorEvent, { detail: message })));
}

/**
 * The same local acceptance, correlated with the one write it watches: `late`
 * resolves with the server's message when that write is rejected after it was
 * accepted locally, and never settles when the write really lands.
 *
 * Nothing is dispatched to the shell's toast here. A surface that has already
 * announced the write owns the retraction, and shows the one sentence it owes
 * instead of the transport's own message.
 */
export function settleTracked(write: Promise<unknown>): { accepted: Promise<void>; late: Promise<string> } {
  let report: (message: string) => void = () => {};
  const late = new Promise<string>(resolve => {
    report = resolve;
  });
  return { accepted: track(write, message => report(message)), late };
}
