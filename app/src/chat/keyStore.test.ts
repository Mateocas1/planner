import assert from "node:assert/strict";
import test from "node:test";
import { setDeviceLanguage } from "../i18n/index.ts";
import { DEFAULT_CHAT_BASE_URL, keyStoreError } from "./keyStore.ts";

test("the default provider address is the NaN OpenAI-compatible endpoint", () => {
  assert.equal(DEFAULT_CHAT_BASE_URL, "https://api.nan.builders/v1");
});

// `getKeyStatus`/`setKey`/`clearKey` are thin `invoke` wrappers: their
// argument names (`key`, `baseUrl`) are the IPC contract with
// `src-tauri/src/chat/mod.rs` and are pinned by the Rust side's serde
// camelCase shapes (`ChatKeyStatus { hasKey, baseUrl }`), not by a runnable
// unit test here.

test("a missing or locked keyring maps to the localized system-keyring hint", () => {
  const raw = { code: "credential_store_unavailable", message: "the stored key could not be read: dbus" };
  try {
    setDeviceLanguage("en");
    assert.match(keyStoreError(raw).message, /system keyring/);
    assert.match(keyStoreError(raw).message, /GNOME Keyring or KWallet/);
    setDeviceLanguage("es");
    assert.match(keyStoreError(raw).message, /llavero del sistema/);
  } finally {
    setDeviceLanguage(null);
  }
});

test("other key-command rejections keep Rust's wording", () => {
  assert.equal(keyStoreError({ code: "invalid_request", message: "The provider address is not allowed." }).message, "The provider address is not allowed.");
  assert.equal(keyStoreError("plain failure").message, "plain failure");
});
