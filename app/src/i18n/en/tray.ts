/** Desktop shell copy that Rust draws (tray menu, close-to-tray notice, native
 * notifications): the webview translates it and pushes it with `tray_sync`.
 * English is the source of truth: `es/tray.ts` must carry the same keys and placeholders. */
export const tray = {
  "tray.signedOut": "Sign in to see Up next",
  "tray.nothingNext": "Up next: Nothing else today",
  "tray.upNext": "Up next: {title} · {time}",
  "tray.focus": "Focus: {minutes} min left",
  "tray.workBlock": "Work block",
  "tray.open": "Open Planner",
  "tray.quit": "Quit",
  "tray.notice.title": "Planner is still running in the tray",
  "tray.notice.body": "Closing hides the window: reopen it or quit from the tray icon.",

  "toast.block.lead": "Deep work starts in 2 min",
  "toast.block.snoozedLead": "Starting now",
  "toast.block.startFocus": "Start focus",
  "toast.block.snooze": "+5 min",
  "toast.shutdown.title": "Time to close the day.",
  "toast.shutdown.body": "The shutdown ritual is ready.",
  "toast.shutdown.action": "Close the day",
  "toast.weekly.title": "Time to close the week.",
  "toast.weekly.body": "The weekly review is ready.",
  "toast.weekly.start": "Start review",
  "toast.weekly.later": "Later",
  "toast.weekly.skip": "Skip this week",
} as const;
