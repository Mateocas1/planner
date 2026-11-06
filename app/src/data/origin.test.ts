import { test } from "node:test";
import assert from "node:assert/strict";
import { usesEmulators } from "./origin.ts";

test("the Vite dev and test servers on localhost / 127.0.0.1 use the emulators", () => {
  assert.equal(usesEmulators({ protocol: "http:", hostname: "localhost" }), true);
  assert.equal(usesEmulators({ protocol: "http:", hostname: "127.0.0.1" }), true);
  assert.equal(usesEmulators({ protocol: "https:", hostname: "localhost" }), true);
});

test("the packaged desktop shell uses production on every platform", () => {
  // Linux (WebKitGTK) serves the embedded assets from tauri://localhost.
  assert.equal(usesEmulators({ protocol: "tauri:", hostname: "localhost" }), false);
  // Windows (WebView2) serves them from http://tauri.localhost.
  assert.equal(usesEmulators({ protocol: "http:", hostname: "tauri.localhost" }), false);
});

test("the hosted web app uses production", () => {
  assert.equal(usesEmulators({ protocol: "https:", hostname: "cumbia-4ca6e.web.app" }), false);
});
