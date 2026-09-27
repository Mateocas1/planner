import type { ReactElement } from "react";
import type { View } from "../App.tsx";

type NavEntry = { id: View; label: string; icon: ReactElement };

function HomeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M2.5 6.75 8 2.25l5.5 4.5v5.75a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" strokeLinejoin="round" />
    </svg>
  );
}

function TasksIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <rect x="2" y="2" width="12" height="12" rx="3" />
      <path d="m5.5 8.25 1.75 1.75 3.25-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <rect x="2" y="3" width="12" height="11" rx="2" />
      <path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" strokeLinecap="round" />
    </svg>
  );
}

const views: NavEntry[] = [
  { id: "home", label: "Home", icon: <HomeIcon /> },
  { id: "tasks", label: "Tasks", icon: <TasksIcon /> },
  { id: "calendar", label: "Calendar", icon: <CalendarIcon /> },
];

/** The left sidebar shell: application name, view navigation with icons and
 * a raised pill on the active item, and the identity plus sign-out control.
 * The accessible names (nav "Main", per-view buttons, identity text) are the
 * contract the browser tests rely on. */
export function Sidebar({ email, view, onNavigate, onSignOut }: {
  email: string;
  view: View;
  onNavigate: (view: View) => void;
  onSignOut: () => void;
}) {
  return (
    <aside className="sidebar">
      <div className="side-head">
        <span className="app-name">Personal Planner</span>
      </div>
      <p className="side-label">Planner</p>
      <nav aria-label="Main" className="side-nav">
        {views.map(entry => (
          <button
            key={entry.id}
            type="button"
            className={view === entry.id ? "nav-item active" : "nav-item"}
            aria-current={view === entry.id ? "page" : undefined}
            onClick={() => onNavigate(entry.id)}
          >
            {entry.icon}
            <span>{entry.label}</span>
          </button>
        ))}
      </nav>
      <div className="side-foot">
        <span className="who">Signed in as {email}</span>
        <button type="button" className="signout" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </aside>
  );
}
