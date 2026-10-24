import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CHAT_BASE_URL } from "./keyStore.ts";

test("the default provider address is the NaN OpenAI-compatible endpoint", () => {
  assert.equal(DEFAULT_CHAT_BASE_URL, "https://api.nan.builders/v1");
});

// `getKeyStatus`/`setKey`/`clearKey` are thin `invoke` wrappers: their
// argument names (`key`, `baseUrl`) are the IPC contract with
// `src-tauri/src/chat/mod.rs` and are pinned by the Rust side's serde
// camelCase shapes (`ChatKeyStatus { hasKey, baseUrl }`), not by a runnable
// unit test here.
