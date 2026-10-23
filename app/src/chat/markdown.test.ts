import assert from "node:assert/strict";
import test from "node:test";
import { parseInline, parseMarkdown, stableBoundary } from "./markdown.ts";

test("stableBoundary: text with no blank line is all tail", () => {
  assert.equal(stableBoundary("Hello there, strea"), 0);
});

test("stableBoundary: the tail starts after the last blank line", () => {
  assert.equal(stableBoundary("First para.\n\nSecond one is"), "First para.\n\n".length);
  assert.equal(stableBoundary("A\n\nB\n\n- item"), "A\n\nB\n\n".length);
  assert.equal(stableBoundary("Done.\n\n"), "Done.\n\n".length, "a completed trailing block leaves no tail");
});

test("stableBoundary: inside an open fence the whole fence is the tail", () => {
  const text = "Before.\n\n```js\nconst a = 1;";
  assert.equal(stableBoundary(text), "Before.\n\n".length);
});

test("stableBoundary: a closed fence then a fresh paragraph", () => {
  const text = "```js\nconst a = 1;\n```\n\nAfter the code";
  assert.equal(stableBoundary(text), text.lastIndexOf("After"));
});

test("parseInline styles bold, italic, code and links", () => {
  assert.deepEqual(parseInline("**bold** and *it* and `c` and [x](https://a.b)"), [
    { kind: "bold", text: "bold" },
    { kind: "text", text: " and " },
    { kind: "italic", text: "it" },
    { kind: "text", text: " and " },
    { kind: "code", text: "c" },
    { kind: "text", text: " and " },
    { kind: "link", text: "x", href: "https://a.b" },
  ]);
});

test("parseInline leaves a trailing unmatched marker literal (mid-stream safety)", () => {
  assert.deepEqual(parseInline("a *x* **b"), [
    { kind: "text", text: "a " },
    { kind: "italic", text: "x" },
    { kind: "text", text: " **b" },
  ]);
});

test("parseMarkdown: paragraph, lists and code blocks", () => {
  const blocks = parseMarkdown("Para one.\n\n- a\n- b\n\n1. one\n2. two\n\n```python\nprint(1)\n```");
  assert.deepEqual(
    blocks.map(block => block.type),
    ["p", "ul", "ol", "code"],
  );
  assert.deepEqual(blocks[1], { type: "ul", items: [[{ kind: "text", text: "a" }], [{ kind: "text", text: "b" }]] });
  assert.deepEqual(blocks[3], { type: "code", lang: "python", text: "print(1)", open: false });
});

test("parseMarkdown: an unterminated fence is an open code block, never a throw", () => {
  const blocks = parseMarkdown("```js\nconst a = ");
  assert.deepEqual(blocks, [{ type: "code", lang: "js", text: "const a = ", open: true }]);
});

test("parseMarkdown: a partially typed line is a paragraph with literal markers", () => {
  const blocks = parseMarkdown("The **ans");
  assert.deepEqual(blocks, [{ type: "p", inlines: [{ kind: "text", text: "The **ans" }] }]);
});

test("parseMarkdown: a soft line break joins the paragraph", () => {
  const blocks = parseMarkdown("line one\nline two");
  assert.deepEqual(blocks, [{ type: "p", inlines: [{ kind: "text", text: "line one line two" }] }]);
});

test("parseMarkdown on an empty or blank string yields nothing", () => {
  assert.deepEqual(parseMarkdown(""), []);
  assert.deepEqual(parseMarkdown("  \n \n"), []);
});
