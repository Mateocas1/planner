import { t } from "../i18n/index.ts";

/**
 * The sync line's wording as pure logic. It counts writes the server has not
 * acknowledged and reports the offline state. It never says a change is saved
 * or safe: a local write is not a backup, and the product makes no such claim.
 */
export type SyncLine = { tone: "synced" | "pending" | "offline"; text: string };

export function syncLine(online: boolean, pending: number): SyncLine {
  if (!online) {
    return {
      tone: "offline",
      text: pending === 0 ? t("sync.offlineNothing") : t("sync.offlineWaiting", { count: pending }),
    };
  }
  if (pending === 0) return { tone: "synced", text: t("sync.synced") };
  return { tone: "pending", text: t("sync.pending", { count: pending }) };
}
