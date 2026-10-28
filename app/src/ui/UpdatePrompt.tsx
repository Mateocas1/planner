import { t } from "../i18n/index.ts";
import { activateUpdate, useUpdateReady } from "../pwa-update.ts";
import "./UpdatePrompt.css";

/**
 * "Update available": the one place a waiting service worker is surfaced
 * (value roadmap §2 row 1). It is a corner card, not a dialog -- it never takes
 * focus, never blocks the page, and stays until the user acts.
 *
 * The only action is Reload, deliberately: the waiting worker cannot announce
 * itself twice in one session, so a dismiss would hide the only signal that a
 * new build exists. Either the user reloads, or the update lands on the next
 * natural page load anyway.
 */
export function UpdatePrompt() {
  const ready = useUpdateReady();
  if (!ready) return null;
  return (
    <div className="update-prompt glass glass-float" role="status">
      <div className="update-prompt-text">
        <p className="update-prompt-title">{t("update.title")}</p>
        <p className="update-prompt-body">{t("update.body")}</p>
      </div>
      <button type="button" className="button button-accent" onClick={activateUpdate}>{t("update.reload")}</button>
    </div>
  );
}
