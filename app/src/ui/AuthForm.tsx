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
      <h1>Personal Planner</h1>
      <form onSubmit={onSubmit}>
        <label htmlFor="email">Email</label>
        <input id="email" type="email" value={email} onChange={event => setEmail(event.target.value)} required />
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={event => setPassword(event.target.value)}
          required
          minLength={6}
        />
        <div className="actions">
          <button type="button" disabled={busy} onClick={() => void submit(() => createAccount(email, password))}>
            Create account
          </button>
          <button type="submit" disabled={busy}>
            Sign in
          </button>
        </div>
      </form>
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
