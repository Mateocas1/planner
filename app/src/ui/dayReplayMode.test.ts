import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  autoPlays,
  readReplayMode,
  readReplaySeen,
  replayModeKey,
  replaySeenKey,
  writeReplayMode,
  writeReplaySeen,
  type ReplayStorage,
} from "./dayReplayMode.ts";

function memory(): ReplayStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

const refusing: ReplayStorage = {
  getItem() {
    throw new Error("denied");
  },
  setItem() {
    throw new Error("denied");
  },
};

describe("day replay mode", () => {
  it("defaults to auto when nothing is stored, the value is unknown or storage is missing", () => {
    const storage = memory();
    assert.equal(readReplayMode(storage), "auto");
    storage.data.set(replayModeKey, "sometimes");
    assert.equal(readReplayMode(storage), "auto");
    assert.equal(readReplayMode(null), "auto");
    assert.equal(readReplayMode(refusing), "auto");
  });

  it("round-trips the three modes under planner-replay-mode", () => {
    const storage = memory();
    for (const mode of ["request", "off", "auto"] as const) {
      writeReplayMode(mode, storage);
      assert.equal(storage.data.get("planner-replay-mode"), mode);
      assert.equal(readReplayMode(storage), mode);
    }
  });

  it("swallows a storage that refuses writes", () => {
    assert.doesNotThrow(() => writeReplayMode("off", refusing));
    assert.doesNotThrow(() => writeReplayMode("off", null));
    assert.doesNotThrow(() => writeReplaySeen("u1", "2026-11-06", refusing));
  });

  it("remembers the last day the replay played, per user", () => {
    const storage = memory();
    assert.equal(readReplaySeen("u1", storage), null);
    writeReplaySeen("u1", "2026-11-06", storage);
    assert.equal(storage.data.get(replaySeenKey("u1")), "2026-11-06");
    assert.equal(readReplaySeen("u1", storage), "2026-11-06");
    assert.equal(readReplaySeen("u2", storage), null);
    assert.equal(readReplaySeen("u1", refusing), null);
  });
});

describe("auto play", () => {
  it("plays once a day, and only in auto mode", () => {
    assert.equal(autoPlays({ mode: "auto", seen: null, day: "2026-11-06" }), true);
    assert.equal(autoPlays({ mode: "auto", seen: "2026-11-05", day: "2026-11-06" }), true);
    assert.equal(autoPlays({ mode: "auto", seen: "2026-11-06", day: "2026-11-06" }), false);
    assert.equal(autoPlays({ mode: "request", seen: null, day: "2026-11-06" }), false);
    assert.equal(autoPlays({ mode: "off", seen: null, day: "2026-11-06" }), false);
  });
});
