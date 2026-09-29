import { useState, type FormEvent } from "react";
import { createAccount, signIn } from "../data/session.ts";

export function AuthForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign-in failed. Try again.");
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
        <h1 className="gate-title">Personal Planner</h1>
        <p className="subtitle">Tasks, deadlines and the time you set aside for them. Works offline.</p>
        <form onSubmit={onSubmit} className="gate-form">
          <div className="form-group">
            <div className="form-row stacked">
              <label htmlFor="email">Email</label>
              <input id="email" className="form-control" type="email" autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} required />
            </div>
            <div className="form-row stacked">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                className="form-control"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={event => setPassword(event.target.value)}
                required
                minLength={6}
              />
            </div>
          </div>
          {error && <p className="inline-error" role="alert">{error}</p>}
          <div className="gate-actions">
            <button type="submit" className="button-primary" disabled={busy}>
              Sign in
            </button>
            <button type="button" className="button" disabled={busy} onClick={() => void submit(() => createAccount(email, password))}>
              Create account
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}
