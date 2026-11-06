import { useState, type FormEvent } from "react";
import { requestPasswordReset } from "../data/auth.ts";
import { authErrorKey, type AuthErrorKey } from "../data/authErrors.ts";
import { createAccount, signIn } from "../data/session.ts";
import { t, useLocale } from "../i18n/index.ts";
import "./AuthForm.css";

export function AuthForm() {
  useLocale();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<AuthErrorKey | null>(null);
  // A reset error is about the email alone; a sign-in error is about both fields.
  const [emailOnlyError, setEmailOnlyError] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    setEmailOnlyError(false);
    setResetSent(false);
    try {
      await action();
    } catch (cause) {
      setError(authErrorKey(cause));
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword() {
    setBusy(true);
    setError(null);
    setResetSent(false);
    const outcome = await requestPasswordReset(email);
    setBusy(false);
    setEmailOnlyError(!outcome.ok);
    if (outcome.ok) setResetSent(true);
    else setError(outcome.error);
  }

  // The reset outcome is about the typed email, so editing it clears that outcome.
  function editEmail(value: string) {
    setEmail(value);
    setResetSent(false);
    if (emailOnlyError) {
      setError(null);
      setEmailOnlyError(false);
    }
  }

  const emailInvalid = error ? true : undefined;
  const passwordInvalid = error && !emailOnlyError ? true : undefined;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submit(() => signIn(email, password));
  };

  return (
    <main className="gate">
      <div className="gate-card card">
        <h1 className="gate-title">{t("auth.title")}</h1>
        <p className="subtitle">{t("auth.tagline")}</p>
        <form onSubmit={onSubmit} className="gate-form">
          <div className="form-group">
            <div className="form-row stacked">
              <label htmlFor="email">{t("auth.email")}</label>
              <input id="email" className="form-control" type="email" autoComplete="email" aria-invalid={emailInvalid} aria-describedby={emailInvalid ? "auth-error" : undefined} value={email} onChange={event => editEmail(event.target.value)} required />
            </div>
            <div className="form-row stacked">
              <label htmlFor="password">{t("auth.password")}</label>
              <input
                id="password"
                className="form-control"
                type="password"
                autoComplete="current-password"
                aria-invalid={passwordInvalid}
                aria-describedby={passwordInvalid ? "auth-error" : undefined}
                value={password}
                onChange={event => setPassword(event.target.value)}
                required
                minLength={6}
              />
            </div>
          </div>
          {/* aria-disabled, not disabled: disabling the focused link would drop keyboard focus. */}
          <button type="button" className="link-button gate-forgot" aria-disabled={busy || undefined} onClick={() => void (busy || resetPassword())}>
            {t("auth.forgotPassword")}
          </button>
          {error && <p id="auth-error" className="inline-error" role="alert">{t(error)}</p>}
          {/* Always mounted so screen readers announce the text when it appears. */}
          <div role="status" className="gate-status">{resetSent && <p className="gate-notice">{t("auth.resetSent")}</p>}</div>
          <div className="gate-actions">
            <button type="submit" className="button-primary" disabled={busy}>
              {t("auth.signIn")}
            </button>
            <button type="button" className="button" disabled={busy} onClick={() => void submit(() => createAccount(email, password))}>
              {t("auth.createAccount")}
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}
