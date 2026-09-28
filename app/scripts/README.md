# UI capture harness

A working instrument for the visual loop, not part of the product or the test suite.

    cd app && node scripts/ui-capture.mjs [round]

It starts the `demo-calendar-app` emulators through the same `firebase.emulator.json` the browser
suite uses, seeds a realistic planner (tasks with deadlines, series, two weeks of blocks), drives
Chromium, and writes every surface at 1440×900 and 390×844 — including the empty states and the open
details panel — to `/tmp/ui-loop/round-N/`. It validates each PNG header and shuts down everything it
started. The phone Calendar capture reaches the following week through the day header's own stepper,
which is the only navigation a phone renders; the desktop capture uses the week controls. Compare
against `/tmp/ref-frames/`; the round-by-round reasoning lives in `/tmp/ui-loop/log.md`.
