import { useState, type FormEvent } from "react";
import { authErrorKey } from "../data/authErrors.ts";
import { createAccount, signIn } from "../data/session.ts";
import { t, useLocale, type MessageKey } from "../i18n/index.ts";

export function AuthForm() {
  useLocale();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(authErrorKey(cause));
    } finally {
      setBusy(false);
    }
  }

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
              <input id="email" className="form-control" type="email" autoComplete="email" aria-invalid={error ? true : undefined} aria-describedby={error ? "auth-error" : undefined} value={email} onChange={event => setEmail(event.target.value)} required />
            </div>
            <div className="form-row stacked">
              <label htmlFor="password">{t("auth.password")}</label>
              <input
                id="password"
                className="form-control"
                type="password"
                autoComplete="current-password"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "auth-error" : undefined}
                value={password}
                onChange={event => setPassword(event.target.value)}
                required
                minLength={6}
              />
            </div>
          </div>
          {error && <p id="auth-error" className="inline-error" role="alert">{t(error)}</p>}
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
