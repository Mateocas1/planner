import assert from "node:assert/strict";
import test from "node:test";
import { parseDuration, readOnDevice } from "./heuristic.ts";
import { MAX_CAPTURE_CHARS } from "./prompt.ts";
import type { CaptureProposal } from "./schema.ts";

// Friday 2026-11-06 in the planner's zone.
const ctx = { now: new Date("2026-11-06T15:00:00Z"), timeZone: "America/Argentina/Buenos_Aires" };

const minutesOf = (text: string) => parseDuration(text)?.minutes ?? null;

const proposal = (overrides: Partial<CaptureProposal>): CaptureProposal => ({
  title: "",
  dueDay: null,
  startMinutes: null,
  estimateMinutes: null,
  quote: null,
  dateIgnored: false,
  ...overrides,
});

test("durations parse in English and Spanish", () => {
  assert.equal(minutesOf("30m"), 30);
  assert.equal(minutesOf("30 min"), 30);
  assert.equal(minutesOf("45 minutes"), 45);
  assert.equal(minutesOf("90 minutos"), 90);
  assert.equal(minutesOf("1,5 h"), 90);
  assert.equal(minutesOf("1.5h"), 90);
  assert.equal(minutesOf("1h30"), 90);
  assert.equal(minutesOf("1h 30m"), 90);
  assert.equal(minutesOf("2 horas"), 120);
  assert.equal(minutesOf("2 hours"), 120);
  assert.equal(minutesOf("media hora"), 30);
  assert.equal(minutesOf("half an hour"), 30);
  assert.equal(minutesOf("an hour"), 60);
  assert.equal(minutesOf("una hora"), 60);
  assert.equal(minutesOf("una hora y media"), 90);
  assert.equal(minutesOf("an hour and a half"), 90);
  assert.equal(minutesOf("un cuarto de hora"), 15);
  assert.equal(minutesOf("8 hours"), 480);
});

test("durations report the exact span they occupied", () => {
  assert.deepEqual(parseDuration("Write the report 2h today"), { minutes: 120, start: 17, end: 19, text: "2h" });
  assert.deepEqual(parseDuration("30 min or 1 hour"), { minutes: 30, start: 0, end: 6, text: "30 min" });
});

test("zero, units that are not time and out-of-range values do not parse", () => {
  for (const text of ["0 min", "0h", "0,0 h", "3 meses", "3 months", "3meses", "5 m", "16hs", "10 hours", "", "no duration here", "Q3 2026"]) {
    assert.equal(parseDuration(text), null, JSON.stringify(text));
  }
  assert.equal(minutesOf("2h 15 meses"), 120);
  assert.equal(minutesOf("100 min of silence"), 100);
});

test("an English mail becomes one task titled by its subject", () => {
  const text = [
    "From: Lucía Pérez <lucia@example.com>",
    "Subject: Re: Q3 budget",
    "",
    "Hi Ana,",
    "",
    "Could you send me the Q3 budget by Friday 14 Nov? It should take about 45 minutes.",
    "",
    "Thanks,",
    "Lucía",
  ].join("\n");
  assert.deepEqual(readOnDevice(text, ctx), {
    tasks: [
      proposal({
        title: "Q3 budget",
        dueDay: "2026-11-14",
        estimateMinutes: 45,
        quote: "Could you send me the Q3 budget by Friday 14 Nov? It should take about 45 minutes.",
      }),
    ],
    truncated: false,
    capped: false,
  });
});

test("a Spanish mail becomes one task, reading the date and the duration", () => {
  const text = [
    "Asunto: RV: Presupuesto Q3",
    "Hola Lucía,",
    "Necesito que me mandes el presupuesto antes del viernes 14 de noviembre. Calculo media hora.",
    "Gracias",
  ].join("\n");
  const { tasks } = readOnDevice(text, ctx);
  assert.deepEqual(tasks, [
    proposal({
      title: "Presupuesto Q3",
      dueDay: "2026-11-14",
      estimateMinutes: 30,
      quote: "Necesito que me mandes el presupuesto antes del viernes 14 de noviembre. Calculo media hora.",
    }),
  ]);
});

test("without a subject the first sentence after the greeting is the title, kept whole", () => {
  const { tasks } = readOnDevice("Hi Ana,\nPlease review the contract draft tomorrow, 1h30 max. Thanks a lot!\nBest", ctx);
  assert.deepEqual(tasks, [
    proposal({
      title: "Please review the contract draft tomorrow, 1h30 max.",
      dueDay: "2026-11-07",
      estimateMinutes: 90,
      quote: "Please review the contract draft tomorrow, 1h30 max. Thanks a lot!",
    }),
  ]);
});

test("a short single line reads like quick add: date and duration leave the title", () => {
  const { tasks } = readOnDevice("call the bank tomorrow 30m", ctx);
  assert.deepEqual(tasks, [proposal({ title: "call the bank", dueDay: "2026-11-07", estimateMinutes: 30, quote: "call the bank tomorrow 30m" })]);
});

test("an English list splits into one task per item", () => {
  const text = [
    "Things to do:",
    "- Pay the electricity bill tomorrow 15m",
    "- Book dentist on monday",
    "* Reply to María about the offsite (30 min)",
    "3. Buy a gift for Pedro 12/11",
  ].join("\n");
  assert.deepEqual(readOnDevice(text, ctx), {
    tasks: [
      proposal({ title: "Pay the electricity bill", dueDay: "2026-11-07", estimateMinutes: 15, quote: "Pay the electricity bill tomorrow 15m" }),
      proposal({ title: "Book dentist", dueDay: "2026-11-09", quote: "Book dentist on monday" }),
      proposal({ title: "Reply to María about the offsite", estimateMinutes: 30, quote: "Reply to María about the offsite (30 min)" }),
      proposal({ title: "Buy a gift for Pedro", dueDay: "2026-11-12", quote: "Buy a gift for Pedro 12/11" }),
    ],
    truncated: false,
    capped: false,
  });
});

test("a Spanish checklist skips ticked items and reads 1,5 h and mañana", () => {
  const text = ["- [ ] Llamar al banco mañana", "- [x] Pagar la luz", "- [ ] Mandar el informe 1,5 h", "• Comprar pan", "1) Sacar turno el lunes"].join("\n");
  const { tasks } = readOnDevice(text, ctx);
  assert.deepEqual(
    tasks.map(task => [task.title, task.dueDay, task.estimateMinutes]),
    [
      ["Llamar al banco", "2026-11-07", null],
      ["Mandar el informe", null, 90],
      ["Comprar pan", null, null],
      ["Sacar turno", "2026-11-09", null],
    ],
  );
});

test("a single bullet inside prose is not a list", () => {
  const { tasks } = readOnDevice("Reminder for the week\n- bring the laptop\nSee you soon", ctx);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, "Reminder for the week");
});

test("more than eight items are cut to eight and flagged, duplicates merge first", () => {
  const items = Array.from({ length: 12 }, (_, i) => `- Item number ${i}`);
  const result = readOnDevice(items.join("\n"), ctx);
  assert.equal(result.tasks.length, 8);
  assert.equal(result.capped, true);
  assert.equal(result.tasks[7].title, "Item number 7");
  const duplicated = readOnDevice("- Call the bank\n- call  the BANK 20 min\n- Pay rent", ctx);
  assert.deepEqual(duplicated.tasks.map(task => [task.title, task.estimateMinutes]), [["Call the bank", 20], ["Pay rent", null]]);
  assert.equal(duplicated.capped, false);
});

test("an explicit past date is not a date: it stays in the title, unflagged", () => {
  const { tasks } = readOnDevice("- File taxes 01/11/2026\n- Renew the lease", ctx);
  assert.deepEqual(tasks[0], proposal({ title: "File taxes 01/11/2026", quote: "File taxes 01/11/2026" }));
});

test("a URL alone becomes host plus decoded slug, with no query or fragment", () => {
  const url = "https://www.example.com/blog/2026/how-to-plan-a-launch-week.html?utm_source=x#top";
  assert.deepEqual(readOnDevice(`  ${url}\n`, ctx).tasks, [proposal({ title: "example.com — how to plan a launch week", quote: url })]);
  assert.equal(readOnDevice("https://es.wikipedia.org/wiki/Planificaci%C3%B3n", ctx).tasks[0].title, "es.wikipedia.org — Planificación");
  assert.equal(readOnDevice("https://example.com/", ctx).tasks[0].title, "example.com");
  assert.equal(readOnDevice("https://example.com/p/12345", ctx).tasks[0].title, "example.com");
  assert.equal(readOnDevice("https://example.com/%E0%A4%A", ctx).tasks[0].title, "example.com");
});

test("a link that is not http or not alone is plain text", () => {
  assert.equal(readOnDevice("javascript:alert(1)", ctx).tasks[0].title, "javascript:alert(1)");
  assert.equal(readOnDevice("Read this https://example.com/a-b tomorrow", ctx).tasks[0].dueDay, "2026-11-07");
});

test("empty and punctuation-only input yield no tasks", () => {
  for (const text of ["", "   ", "\n\n\t\n", "---\n***\n...", "•", "- \n- "]) {
    assert.deepEqual(readOnDevice(text, ctx), { tasks: [], truncated: false, capped: false }, JSON.stringify(text));
  }
});

test("10k and over-cap inputs are bounded and flagged", () => {
  const tenK = readOnDevice("word ".repeat(2000), ctx);
  assert.equal(tenK.tasks.length, 1);
  assert.equal(tenK.tasks[0].title.length, 120);
  assert.ok(tenK.tasks[0].title.endsWith("…"));
  assert.ok((tenK.tasks[0].quote ?? "").length <= 160);
  assert.equal(tenK.truncated, false);
  const over = readOnDevice("word ".repeat(5000), ctx);
  assert.equal(over.truncated, true);
  assert.ok(MAX_CAPTURE_CHARS < "word ".repeat(5000).length);
});

test("pathological input finishes and never throws", () => {
  const inputs = ["1".repeat(MAX_CAPTURE_CHARS), "1h".repeat(6000), "- ".repeat(6000), "(".repeat(MAX_CAPTURE_CHARS), "a/".repeat(6000), "https://" + "a".repeat(MAX_CAPTURE_CHARS)];
  for (const input of inputs) assert.doesNotThrow(() => readOnDevice(input, ctx));
});

test("output has no control characters and every title fits the chat's limits", () => {
  const { tasks } = readOnDevice("- Pay\u0000 the\u0007 rent‮\n- " + "y".repeat(400), ctx);
  assert.equal(tasks[0].title, "Pay the rent");
  assert.ok(tasks[1].title.length <= 120);
});
