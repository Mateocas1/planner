import { useState } from "react";
import type { User } from "firebase/auth";
import { signOutUser, useSession } from "./data/session.ts";
import { useProfileTimeZone } from "./data/profile.ts";
import { useStore } from "./data/store.ts";
import { AuthForm } from "./ui/AuthForm.tsx";
import { Calendar } from "./ui/Calendar.tsx";
import { Home } from "./ui/Home.tsx";
import { Sidebar } from "./ui/Sidebar.tsx";
import { Tasks } from "./ui/Tasks.tsx";

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
  const { loading, tasks, blocks, series, completions } = useStore(user.uid);
  const profile = useProfileTimeZone(user.uid);

  return (
    <div className="shell">
      <Sidebar
        email={user.email ?? ""}
        view={view}
        onNavigate={onNavigate}
        onSignOut={() => {
          onNavigate("home");
          void signOutUser();
        }}
      />
      <main className={view === "home" ? "surface surface-inset" : "surface"}>
        {/* the view-tied key remounts the surface on every switch, so the
            view-enter / view-fade animation replays (motion, DP1b) */}
        {view === "home" && (
          <Home
            key={view}
            loading={loading}
            tasks={tasks}
            blocks={blocks}
            series={series}
            timeZone={profile.timeZone}
            profileError={profile.error}
          />
        )}
        {view === "tasks" && (
          <Tasks
            key={view}
            loading={loading}
            tasks={tasks}
            series={series}
            completions={completions}
            uid={user.uid}
          />
        )}
        {view === "calendar" && (
          <Calendar
            key={view}
            uid={user.uid}
            loading={loading}
            blocks={blocks}
            tasks={tasks}
            timeZone={profile.timeZone}
            profileError={profile.error}
          />
        )}
      </main>
    </div>
  );
}
