import assert from "node:assert/strict";
import test from "node:test";
import { syncLine } from "./sync.ts";

test("online with nothing waiting reads as Synced, the neutral state", () => {
  assert.deepEqual(syncLine(true, 0), { tone: "synced", text: "Synced" });
});

test("online with unacknowledged writes counts them in the words of the sync line", () => {
  assert.deepEqual(syncLine(true, 1), { tone: "pending", text: "1 change waiting to sync" });
  assert.deepEqual(syncLine(true, 2), { tone: "pending", text: "2 changes waiting to sync" });
});

test("offline reports the offline state and the writes still waiting", () => {
  assert.deepEqual(syncLine(false, 0), { tone: "offline", text: "Offline · nothing waiting" });
  assert.deepEqual(syncLine(false, 1), { tone: "offline", text: "Offline · 1 change waiting" });
  assert.deepEqual(syncLine(false, 3), { tone: "offline", text: "Offline · 3 changes waiting" });
});

test("no wording claims data is saved or safe, which the product cannot promise", () => {
  for (const online of [true, false]) {
    for (const pending of [0, 1, 4]) {
      assert.doesNotMatch(syncLine(online, pending).text, /saved|safe|secure|backed up/i);
    }
  }
});

test("the sync line reads in Spanish with its own plural rule", async () => {
  const { setDeviceLanguage } = await import("../i18n/index.ts");
  setDeviceLanguage("es");
  try {
    assert.deepEqual(syncLine(true, 0), { tone: "synced", text: "Sincronizado" });
    assert.equal(syncLine(true, 1).text, "1 cambio pendiente de sincronizar");
    assert.equal(syncLine(true, 3).text, "3 cambios pendientes de sincronizar");
    assert.equal(syncLine(false, 0).text, "Sin conexión · nada pendiente");
    assert.equal(syncLine(false, 2).text, "Sin conexión · 2 cambios pendientes");
  } finally {
    setDeviceLanguage(null);
  }
});
