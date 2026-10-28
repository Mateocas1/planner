import assert from "node:assert/strict";
import test from "node:test";
import { isTypeaheadKey, moveActive, typeahead, TYPEAHEAD_RESET_MS, type TypeaheadState } from "./typeahead.ts";

const fresh: TypeaheadState = { buffer: "", at: 0 };
const labels = ["Never", "Daily", "Weekly", "Monthly"];

test("a letter jumps to the next label that starts with it, from the active one", () => {
  const out = typeahead(labels, 0, "w", fresh, 1000);
  assert.equal(out.index, 2);
  assert.deepEqual(out.state, { buffer: "w", at: 1000 });
});

test("matching is case-insensitive and ignores the key's case", () => {
  assert.equal(typeahead(labels, 0, "D", fresh, 1000).index, 1);
  assert.equal(typeahead(["alpha", "Beta"], 0, "b", fresh, 1000).index, 1);
});

test("the active label counts when it already matches, so a prefix keeps its place", () => {
  const first = typeahead(["Tuesday", "Thursday", "Tuesday2"], 0, "t", fresh, 1000);
  assert.equal(first.index, 1, "a lone letter moves past the active one");
  const second = typeahead(["Tuesday", "Thursday", "Tuesday2"], 1, "h", first.state, 1200);
  assert.equal(second.state.buffer, "th");
  assert.equal(second.index, 1);
});

test("typing quickly builds a prefix", () => {
  const a = typeahead(labels, 0, "m", fresh, 1000);
  const b = typeahead(labels, a.index, "o", a.state, 1100);
  assert.equal(b.state.buffer, "mo");
  assert.equal(b.index, 3);
});

test("the buffer resets after the idle window", () => {
  const a = typeahead(labels, 0, "w", fresh, 1000);
  const b = typeahead(labels, a.index, "d", a.state, 1000 + TYPEAHEAD_RESET_MS + 1);
  assert.equal(b.state.buffer, "d");
  assert.equal(b.index, 1);
});

test("the same letter repeated cycles through the labels sharing it, wrapping", () => {
  const set = ["Task A", "Tea", "Other", "Tuesday"];
  let state = fresh;
  let index = 0;
  const visited: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const out = typeahead(set, index, "t", state, 1000 + i * 50);
    visited.push(out.index);
    index = out.index;
    state = out.state;
  }
  assert.deepEqual(visited, [1, 3, 0, 1]);
});

test("a key with no match keeps the active index but still advances the buffer", () => {
  const out = typeahead(labels, 2, "z", fresh, 1000);
  assert.equal(out.index, 2);
  assert.equal(out.state.buffer, "z");
});

test("a space continues a live prefix and is a plain character in it", () => {
  const set = ["No task", "Not now", "Paint fence"];
  const a = typeahead(set, 0, "n", fresh, 1000);
  const b = typeahead(set, a.index, "o", a.state, 1050);
  const c = typeahead(set, b.index, "t", b.state, 1100);
  const d = typeahead(set, c.index, " ", c.state, 1150);
  const e = typeahead(set, d.index, "n", d.state, 1200);
  assert.equal(d.state.buffer, "not ");
  assert.equal(e.index, 1);
});

test("isTypeaheadKey takes one printable character and nothing with a modifier", () => {
  const key = (k: string, mod: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}) => isTypeaheadKey({ key: k, ...mod });
  assert.equal(key("a"), true);
  assert.equal(key("5"), true);
  assert.equal(key("é"), true);
  assert.equal(key("ArrowDown"), false);
  assert.equal(key("Enter"), false);
  assert.equal(key("a", { ctrlKey: true }), false);
  assert.equal(key("a", { metaKey: true }), false);
  assert.equal(key("a", { altKey: true }), false);
});

test("moveActive clamps at both ends (no wrap) and pages by ten", () => {
  assert.equal(moveActive(0, 5, "ArrowUp"), 0);
  assert.equal(moveActive(4, 5, "ArrowDown"), 4);
  assert.equal(moveActive(1, 5, "ArrowDown"), 2);
  assert.equal(moveActive(3, 5, "Home"), 0);
  assert.equal(moveActive(1, 5, "End"), 4);
  assert.equal(moveActive(2, 40, "PageDown"), 12);
  assert.equal(moveActive(35, 40, "PageDown"), 39);
  assert.equal(moveActive(12, 40, "PageUp"), 2);
  assert.equal(moveActive(3, 40, "PageUp"), 0);
  assert.equal(moveActive(0, 0, "ArrowDown"), -1);
});
