import assert from "node:assert/strict";
import test from "node:test";
import {
  engramStatusText,
  keyStatusText,
  memoryDate,
  memoryPreview,
  providerHost,
  validateBaseUrlClient,
  validateEngramAddressClient,
  validateEngramProjectClient,
  validateKeyClient,
} from "./aiSettings.ts";

test("providerHost names the saved provider, never a blank status", () => {
  assert.equal(providerHost("https://api.nan.builders/v1"), "api.nan.builders");
  assert.equal(providerHost("http://localhost:1234/v1"), "localhost:1234");
  assert.equal(providerHost("not a url"), "not a url");
});

test("the status line says where the key is saved, or that there is none", () => {
  assert.equal(keyStatusText({ hasKey: true, baseUrl: "https://api.nan.builders/v1" }), "Key saved for api.nan.builders.");
  assert.equal(keyStatusText({ hasKey: false, baseUrl: null }), "No key.");
  assert.equal(keyStatusText(null), "Checking…");
});

test("an empty or whitespace key is refused with the Rust wording", () => {
  assert.equal(validateKeyClient(""), "The API key must not be empty.");
  assert.equal(validateKeyClient("   "), "The API key must not be empty.");
  assert.equal(validateKeyClient("sk-secret"), null);
});

test("the base URL rules mirror validate_base_url: https or loopback http, no userinfo", () => {
  assert.equal(validateBaseUrlClient("https://api.nan.builders/v1"), null);
  assert.equal(validateBaseUrlClient("  https://api.nan.builders/v1  "), null);
  assert.equal(validateBaseUrlClient("http://localhost:1234/v1"), null);
  assert.equal(validateBaseUrlClient("http://127.0.0.1/v1"), null);
  assert.equal(validateBaseUrlClient("http://evil.com/v1"), "The provider address is not allowed.");
  assert.equal(validateBaseUrlClient("ftp://api.nan.builders"), "The provider address is not allowed.");
  assert.equal(validateBaseUrlClient("https://user:pass@api.nan.builders/v1"), "The provider address is not allowed.");
  assert.equal(validateBaseUrlClient(""), "The provider address is not allowed.");
  assert.equal(validateBaseUrlClient("api.nan.builders"), "The provider address is not allowed.");
});

test("memory previews collapse to one line and cap their length", () => {
  assert.equal(memoryPreview("Short note"), "Short note");
  assert.equal(memoryPreview("line one\nline  two"), "line one line two");
  const long = "x".repeat(200);
  const preview = memoryPreview(long);
  assert.equal(preview.length, 96);
  assert.ok(preview.endsWith("…"));
});

test("memory dates format in the app's English UI", () => {
  assert.equal(memoryDate(Date.UTC(2026, 9, 24)), "Oct 24, 2026");
});

test("the Engram status line follows mirroring off, last error, then success (spec S2)", () => {
  assert.equal(
    engramStatusText(false, { ok: true, synced: 3, error: null }),
    "Mirroring is off. Memories stay on this computer only.",
  );
  assert.equal(engramStatusText(true, null), "Not synced yet.");
  assert.equal(
    engramStatusText(true, { ok: false, synced: 0, error: "connection refused" }),
    "Engram unreachable: connection refused",
  );
  assert.equal(
    engramStatusText(true, { ok: false, synced: 0, error: null }),
    "Engram unreachable: unknown error",
  );
  assert.equal(engramStatusText(true, { ok: true, synced: 3, error: null }), "Synced 3 memories.");
  assert.equal(engramStatusText(true, { ok: true, synced: 1, error: null }), "Synced 1 memory.");
});

test("the Engram address rules mirror the Rust validation: loopback only, both schemes, no userinfo", () => {
  const refused = "The Engram address must be a loopback address (localhost, 127.0.0.1 or [::1]).";
  assert.equal(validateEngramAddressClient("http://127.0.0.1:7437"), null);
  assert.equal(validateEngramAddressClient("http://localhost:7437"), null);
  assert.equal(validateEngramAddressClient("http://[::1]:7437"), null);
  assert.equal(validateEngramAddressClient("https://127.0.0.1:7437"), null);
  // A remote host is refused on both schemes.
  assert.equal(validateEngramAddressClient("https://engram.example.com"), refused);
  assert.equal(validateEngramAddressClient("http://evil.com"), refused);
  assert.equal(validateEngramAddressClient("https://user:pass@127.0.0.1:7437"), refused);
  assert.equal(validateEngramAddressClient(""), refused);
  assert.equal(validateEngramAddressClient("not a url"), refused);
});

test("an empty Engram project is refused; a named one passes", () => {
  assert.equal(validateEngramProjectClient(""), "The Engram project must not be empty.");
  assert.equal(validateEngramProjectClient("   "), "The Engram project must not be empty.");
  assert.equal(validateEngramProjectClient("calendar-assistant"), null);
});
