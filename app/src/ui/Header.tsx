import type { View } from "../App.tsx";

const views: { id: View; label: string }[] = [
  { id: "home", label: "Home" },
  { id: "tasks", label: "Tasks" },
  { id: "calendar", label: "Calendar" },
];

export function Header({ email, view, onNavigate, onSignOut }: {
  email: string;
  view: View;
  onNavigate: (view: View) => void;
  onSignOut: () => void;
}) {
  return (
    <header className="header">
      <span className="app-name">Personal Planner</span>
      <span className="who">Signed in as {email}</span>
      <nav aria-label="Main">
        {views.map(entry => (
          <button
            key={entry.id}
            type="button"
            aria-current={view === entry.id ? "page" : undefined}
            onClick={() => onNavigate(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </nav>
      <button type="button" onClick={onSignOut}>
        Sign out
      </button>
    </header>
  );
}
