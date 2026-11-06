import assert from "node:assert/strict";
import { test } from "node:test";
import { pasteCaptureText } from "./pasteTarget.ts";

const page = { tagName: "BODY" };
const idle = { dialogOpen: false };

test("a paste on the bare page opens the capture with the pasted text", () => {
  assert.equal(pasteCaptureText({ ...idle, target: page, active: page, text: "Send the Q3 budget to Lucía" }), "Send the Q3 budget to Lucía");
  // Postel: a surrounding blank line is not part of what was pasted.
  assert.equal(pasteCaptureText({ ...idle, target: page, active: page, text: "\n\n  Buy milk  \n" }), "Buy milk");
});

test("a paste on a button or a row is still a page paste", () => {
  const row = { tagName: "BUTTON" };
  assert.equal(pasteCaptureText({ ...idle, target: row, active: row, text: "Call Ana" }), "Call Ana");
});

test("a paste into a field is left to the field", () => {
  const input = { tagName: "INPUT", type: "text" };
  const area = { tagName: "TEXTAREA" };
  assert.equal(pasteCaptureText({ ...idle, target: input, active: input, text: "x" }), null);
  assert.equal(pasteCaptureText({ ...idle, target: area, active: area, text: "x" }), null);
  assert.equal(pasteCaptureText({ ...idle, target: { tagName: "DIV", isContentEditable: true }, active: page, text: "x" }), null);
  // The focused element decides too, whatever the event reports as its target.
  assert.equal(pasteCaptureText({ ...idle, target: page, active: input, text: "x" }), null);
  // A checkbox is not a place to type: the paste is a page paste.
  const check = { tagName: "INPUT", type: "checkbox" };
  assert.equal(pasteCaptureText({ ...idle, target: check, active: check, text: "x" }), "x");
});

test("a paste while a dialog or sheet is open is left alone", () => {
  assert.equal(pasteCaptureText({ dialogOpen: true, target: page, active: page, text: "Call Ana" }), null);
});

test("nothing is opened for an empty paste (an image, a blank clipboard)", () => {
  assert.equal(pasteCaptureText({ ...idle, target: page, active: page, text: "" }), null);
  assert.equal(pasteCaptureText({ ...idle, target: page, active: page, text: " \n\t " }), null);
});
