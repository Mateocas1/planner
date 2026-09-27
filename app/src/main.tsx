import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./app.css";

function App() {
  return (
    <main className="placeholder">
      <h1>Personal Planner</h1>
      <p>
        Foundation increment: domain, data layer and emulator configuration are in place.
        The application surfaces (Home, Tasks, Calendar) arrive in the next increment.
      </p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
