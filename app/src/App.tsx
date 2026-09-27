import { useState } from "react";
import type { User } from "firebase/auth";
import { signOutUser, useSession } from "./data/session.ts";
import { useStore } from "./data/store.ts";
import { AuthForm } from "./ui/AuthForm.tsx";
import { Header } from "./ui/Header.tsx";
import { Home } from "./ui/Home.tsx";

export type View = "home" | "tasks" | "calendar";

export default function App() {
  const { loading, user } = useSession();
  const [view, setView] = useState<View>("home");

  if (loading) {
    return (
      <main className="gate" role="status">
        <p>Checking your session…</p>
      </main>
    );
  }
  if (!user) return <AuthForm />;
  return <Shell user={user} view={view} onNavigate={setView} />;
}

function Shell({ user, view, onNavigate }: { user: User; view: View; onNavigate: (view: View) => void }) {
  const { loading, tasks, blocks } = useStore(user.uid);

  return (
    <div className="shell">
      <Header
        email={user.email ?? ""}
        view={view}
        onNavigate={onNavigate}
        onSignOut={() => {
          onNavigate("home");
          void signOutUser();
        }}
      />
      <main className="surface">
        {view === "home" && <Home loading={loading} taskCount={tasks.length} blockCount={blocks.length} />}
        {view === "tasks" && (
          <section aria-labelledby="tasks-heading">
            <h2 id="tasks-heading">Tasks</h2>
            <p>The Tasks surface arrives in increment I2.</p>
          </section>
        )}
        {view === "calendar" && (
          <section aria-labelledby="calendar-heading">
            <h2 id="calendar-heading">Calendar</h2>
            <p>The Calendar surface arrives in increment I3.</p>
          </section>
        )}
      </main>
    </div>
  );
}
