/**
 * The sync line's wording as pure logic. It counts writes the server has not
 * acknowledged and reports the offline state. It never says a change is saved
 * or safe: a local write is not a backup, and the product makes no such claim.
 */
export type SyncLine = { tone: "synced" | "pending" | "offline"; text: string };

export function syncLine(online: boolean, pending: number): SyncLine {
  const changes = pending === 1 ? "1 change" : `${pending} changes`;
  if (!online) {
    return {
      tone: "offline",
      text: pending === 0 ? "Offline · nothing waiting" : `Offline · ${changes} waiting`,
    };
  }
  if (pending === 0) return { tone: "synced", text: "Synced" };
  return { tone: "pending", text: `${changes} waiting to sync` };
}
