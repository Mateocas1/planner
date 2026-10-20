import { useEffect, useState } from "react";
import { syncLine } from "../domain/sync.ts";
import { CloudIcon, CloudOffIcon } from "./icons.tsx";
import "./SyncStatus.css";

/** Whether the browser reports a network connection; follows changes. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}

/**
 * The sync status as one quiet line: the writes the server has not yet
 * acknowledged, or the offline state. The wording is static. Only a change of
 * state (synced, pending, offline) fades in over 140ms; a change in the count
 * updates in place, so a burst of acknowledgements does not flicker. The polite
 * live region announces the change without moving focus.
 */
export function SyncStatus({ pending }: { pending: number }) {
  const online = useOnline();
  const line = syncLine(online, pending);
  const Icon = line.tone === "offline" ? CloudOffIcon : CloudIcon;
  return (
    <p className={`sync is-${line.tone}`} role="status" aria-live="polite">
      <Icon />
      <span key={line.tone} className="sync-text">{line.text}</span>
    </p>
  );
}
