import { expect, test, type Locator, type Page } from "@playwright/test";
import { submitAuthForm } from "./browser-helpers.ts";

/**
 * CP1 (odd/tasks/centered-panels.md, S2/S3): every detail and creation panel
 * opens as a card centred in what the user can see, not docked to the right
 * edge, and on a phone it is centred in the band the on-screen keyboard leaves.
 *
 * These are geometry assertions on the resting panel, so every read happens
 * after the panel's own flight and its content's blur have finished: measuring
 * mid-entry would read the trigger's rectangle, which is what the panel is
 * laid over on its first frame.
 */

test.setTimeout(120_000);

const newEmail = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;

/**
 * Installs a writable `window.visualViewport` before the app loads, so a test
 * can raise a simulated on-screen keyboard (the same stub tests/mobile.spec.ts
 * uses: Playwright cannot raise a real one, and the real API is read-only).
 */
const fakeVisualViewport = `(() => {
  const viewport = Object.assign(new EventTarget(), {
    width: window.innerWidth,
    height: window.innerHeight,
    offsetTop: 0,
    offsetLeft: 0,
    pageTop: 0,
    pageLeft: 0,
    scale: 1,
  });
  Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true });
  window.__simulateKeyboard = height => {
    viewport.height = height;
    viewport.dispatchEvent(new Event("resize"));
  };
})();`;

type Box = { x: number; y: number; width: number; height: number };

async function signUp(page: Page, email: string) {
  await submitAuthForm(page, email, "sign up");
}

function nav(page: Page) {
  return page.getByRole("navigation", { name: "Main" });
}

async function openTasks(page: Page) {
  await nav(page).getByRole("button", { name: "Tasks" }).click();
  await expect(page.getByRole("button", { name: "New task" })).toBeVisible();
}

/** The band of the layout viewport the user can actually see, in page Y: the
 * layout height minus the part an on-screen keyboard covers. */
async function visibleBand(page: Page): Promise<{ top: number; bottom: number }> {
  const box = await page.evaluate(() => {
    const inset = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--kb-inset")) || 0;
    return { height: window.innerHeight, inset };
  });
  return { top: 0, bottom: box.height - box.inset };
}

/** Waits until the panel's flight and its content's blur have both finished. */
async function settlePanel(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const sheet = document.querySelector<HTMLElement>(".sheet");
        if (!sheet) return "no panel";
        const body = sheet.querySelector<HTMLElement>(".sheet-body");
        const filter = body ? getComputedStyle(body).filter : "none";
        return `${sheet.getAnimations().length}:${body?.getAnimations().length ?? 0}:${filter}`;
      }),
    )
    .toBe("0:0:none");
}

async function boxOf(locator: Locator, name: string): Promise<Box> {
  const box = await locator.boundingBox();
  expect(box, `${name} has a box`).not.toBeNull();
  return box!;
}

/**
 * The panel rests with its box centred in the visible band: horizontally on
 * the viewport's midline, vertically on the band's, and fully inside both.
 */
async function expectCentered(page: Page, panel: Locator, band: { top: number; bottom: number }): Promise<Box> {
  const viewport = page.viewportSize()!;
  const rect = await boxOf(panel, "the panel");
  expect(Math.abs(rect.x + rect.width / 2 - viewport.width / 2), "the panel is centred horizontally").toBeLessThanOrEqual(2);
  expect(
    Math.abs(rect.y + rect.height / 2 - (band.top + band.bottom) / 2),
    "the panel is centred in the visible band",
  ).toBeLessThanOrEqual(2);
  expect(rect.x, "the panel's left edge is on screen").toBeGreaterThanOrEqual(0);
  expect(rect.x + rect.width, "the panel's right edge is on screen").toBeLessThanOrEqual(viewport.width);
  expect(rect.y, "the panel's top edge is on screen").toBeGreaterThanOrEqual(band.top - 0.5);
  expect(rect.y + rect.height, "the panel's bottom edge is above the keyboard").toBeLessThanOrEqual(band.bottom + 0.5);
  return rect;
}

/** A control inside the panel and, by implication, inside the visible band. */
async function expectInPanel(control: Locator, panel: Box, name: string) {
  const rect = await boxOf(control, name);
  expect(rect.y, `${name} starts inside the panel`).toBeGreaterThanOrEqual(panel.y - 0.5);
  expect(rect.y + rect.height, `${name} ends inside the panel`).toBeLessThanOrEqual(panel.y + panel.height + 0.5);
}

async function addTask(page: Page, title: string) {
  await openTasks(page);
  await page.getByRole("button", { name: "New task" }).click();
  await page.getByLabel("Task title").fill(title);
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.locator(".task-title", { hasText: title })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "New task" })).toHaveCount(0);
}

const SCREENS = [
  { width: 1440, height: 900, name: "desktop" },
  { width: 768, height: 1024, name: "tablet" },
] as const;

for (const { width, height, name } of SCREENS) {
  test.describe(`${name} ${width}x${height}`, () => {
    test.use({ viewport: { width, height } });

    test("the New task panel is a centred card with its form in view", async ({ page }) => {
      await signUp(page, newEmail(`centre-${name}`));
      await page.getByRole("button", { name: "New task" }).click();
      const panel = page.getByRole("complementary", { name: "New task" });
      await expect(panel).toBeVisible();
      await settlePanel(page);

      const rect = await expectCentered(page, panel, await visibleBand(page));
      // A centred card is readable, not a second sidebar: it keeps a form's
      // width instead of taking the screen.
      expect(rect.width).toBeLessThanOrEqual(520);
      expect(rect.width).toBeGreaterThan(360);

      await expectInPanel(page.getByLabel("Task title"), rect, "the name field");
      await expectInPanel(panel.getByLabel("Deadline"), rect, "the deadline field");
      await expectInPanel(panel.getByRole("button", { name: "Add task" }), rect, "the primary action");
    });

    test("a task's details panel is centred too", async ({ page }) => {
      await signUp(page, newEmail(`centre-details-${name}`));
      await addTask(page, "Buy paint");
      await page.getByRole("button", { name: "Buy paint" }).click();
      const panel = page.getByRole("complementary", { name: "Task details" });
      await expect(panel).toBeVisible();
      await settlePanel(page);

      const rect = await expectCentered(page, panel, await visibleBand(page));
      await expectInPanel(panel.getByLabel("Rename task"), rect, "the name field");
      await expectInPanel(panel.getByLabel("Deadline"), rect, "the deadline field");
      await expectInPanel(panel.getByRole("button", { name: "Delete task" }), rect, "the primary action");
    });
  });
}

test.describe("phone 390x844", () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });

  test("the New task panel is a centred card, near full width", async ({ page }) => {
    await signUp(page, newEmail("centre-phone"));
    await page.getByRole("button", { name: "New task" }).click();
    const panel = page.getByRole("complementary", { name: "New task" });
    await expect(panel).toBeVisible();
    await settlePanel(page);

    const rect = await expectCentered(page, panel, await visibleBand(page));
    // "Centrado también en celular": the card uses the width it has.
    expect(rect.width).toBeGreaterThanOrEqual(360);

    await expectInPanel(page.getByLabel("Task title"), rect, "the name field");
    await expectInPanel(panel.getByLabel("Deadline"), rect, "the deadline field");
    await expectInPanel(panel.getByRole("button", { name: "Add task" }), rect, "the primary action");
  });

  test("with the keyboard up the panel is centred in the visible band and the whole form stays above it", async ({
    page,
  }) => {
    await page.addInitScript(fakeVisualViewport);
    await signUp(page, newEmail("centre-phone-keyboard"));

    // The keyboard opens on the field the sheet focuses, so it is raised before
    // the panel is laid out: the panel must centre itself in what is left.
    await page.evaluate(() => (window as any).__simulateKeyboard(360));
    await page.getByRole("button", { name: "New task" }).click();
    const panel = page.getByRole("complementary", { name: "New task" });
    await expect(panel).toBeVisible();
    await settlePanel(page);

    const band = await visibleBand(page);
    // 844 layout px, 360 visible: the stub moves the visual viewport, and the
    // covered band is published as --kb-inset.
    expect(band.bottom).toBe(360);
    const rect = await expectCentered(page, panel, band);
    // Nothing is covered by the keyboard: the title it focuses, the deadline and
    // the action that submits it are all in the visible band, unscrolled.
    await expectInPanel(page.getByLabel("Task title"), rect, "the name field");
    await expectInPanel(panel.getByLabel("Deadline"), rect, "the deadline field");
    await expectInPanel(panel.getByRole("button", { name: "Add task" }), rect, "the primary action");
  });

  test("a task's details panel is centred on a phone", async ({ page }) => {
    await signUp(page, newEmail("centre-phone-details"));
    await addTask(page, "Call the vet");
    await page.getByRole("button", { name: "Call the vet" }).click();
    const panel = page.getByRole("complementary", { name: "Task details" });
    await expect(panel).toBeVisible();
    await settlePanel(page);

    const rect = await expectCentered(page, panel, await visibleBand(page));
    await expectInPanel(panel.getByLabel("Rename task"), rect, "the name field");
  });
});

/* ---------- the flight out of its trigger, and the blur it arrives with ---------- */

/** One box, in viewport coordinates. */
type Rect = { x: number; y: number; width: number; height: number };

/** What one opening did, read from the browser's own animation and pixels. */
type Entry = {
  /** The control that was pressed, as it was when it was pressed. */
  trigger: Rect;
  /** The draft the calendar renders for a drag-created slot, when there is one. */
  origin: Rect | null;
  /** The panel's laid-out resting box (layout, so a running transform cannot move it). */
  rest: Rect;
  /** Where the entry's first frame lays the panel. */
  laid: Rect;
  /** The entry's last frame, as one transform string. */
  last: string;
  /** The content's computed filter on the first frame the panel was painted on. */
  filter: string;
  /** The panel's own computed filter on that same frame (it must have none). */
  sheetFilter: string;
  /** Every frame's panel box, for the "it really is painted there" check. */
  frames: Array<{ t: number; box: Rect | null }>;
};

/**
 * Presses `click` and, in the same task, reads the entry the app started: the
 * panel's first and last keyframes (the geometry the compositor is given), the
 * box that first keyframe covers, and the content's filter as it is painted.
 *
 * `dx`/`dy` dispatch a synthetic click at an offset inside the target, which is
 * how the calendar's empty-slot gesture is addressed (its handler reads
 * clientY, not a button press).
 */
function readEntry(page: Page, click: string, offset?: { dx: number; dy: number }): Promise<Entry> {
  return page.evaluate(
    async ({ click, offset }) => {
      const target = document.querySelector<HTMLElement>(click);
      if (!target) throw new Error(`no trigger for ${click}`);
      const trigger = target.getBoundingClientRect().toJSON() as Rect;
      let origin: Rect | null = null;
      if (offset) {
        target.dispatchEvent(
          new MouseEvent("click", { bubbles: true, clientX: trigger.x + offset.dx, clientY: trigger.y + offset.dy }),
        );
      } else {
        target.click();
      }
      const frames: Array<{ t: number; box: Rect | null }> = [];
      const start = performance.now();
      for (let frame = 0; frame < 90; frame += 1) {
        await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
        // The draft the slot gesture renders is the panel's origin, and it is
        // gone once the panel is dismissed: read it while it is on screen.
        const draft = document.querySelector<HTMLElement>(".calendar-draft");
        if (draft) origin = draft.getBoundingClientRect().toJSON() as Rect;
        const sheet = document.querySelector<HTMLElement>(".sheet");
        if (!sheet) continue;
        frames.push({ t: performance.now() - start, box: sheet.getBoundingClientRect().toJSON() as Rect });
        const animations = sheet.getAnimations();
        if (animations.length === 0) continue;
        const keyframes = (animations[0].effect as KeyframeEffect).getKeyframes();
        const first = String((keyframes[0] as Keyframe).transform ?? "");
        const last = String((keyframes[keyframes.length - 1] as Keyframe).transform ?? "");
        // translate(x, y) scale(sx, sy), the panel's one rest-relative transform
        const parsed = first.match(
          /^translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+), ([\d.]+)\)$/,
        );
        if (!parsed) throw new Error(`unexpected entry transform: ${first}`);
        const [x, y, scaleX, scaleY] = parsed.slice(1).map(Number);
        const rest = {
          x: sheet.offsetLeft,
          y: sheet.offsetTop,
          width: sheet.offsetWidth,
          height: sheet.offsetHeight,
        };
        const body = sheet.querySelector<HTMLElement>(".sheet-body");
        return {
          trigger,
          origin,
          rest,
          laid: { x: rest.x + x, y: rest.y + y, width: rest.width * scaleX, height: rest.height * scaleY },
          last,
          filter: body ? getComputedStyle(body).filter : "none",
          sheetFilter: getComputedStyle(sheet).filter,
          frames,
        };
      }
      throw new Error("the panel never started its entry");
    },
    { click, offset },
  );
}

/** The blur radius a computed `filter` carries, or 0 when it has none. */
function blurRadius(filter: string): number {
  const match = filter.match(/blur\(([\d.]+)px\)/);
  return match ? Number(match[1]) : 0;
}

/** An entered panel is laid over its trigger on the first frame and centred at rest. */
async function expectFlight(entry: Entry, from: Rect, name: string) {
  const at = JSON.stringify({ trigger: from, laid: entry.laid, rest: entry.rest });
  // The first frame is the trigger's own box: one transform, no second geometry.
  expect(Math.abs(entry.laid.x - from.x), `${name}: the first frame starts at the trigger ${at}`).toBeLessThanOrEqual(1);
  expect(Math.abs(entry.laid.y - from.y), `${name}: the first frame starts at the trigger ${at}`).toBeLessThanOrEqual(1);
  expect(Math.abs(entry.laid.width - from.width), `${name}: the first frame is the trigger's width ${at}`).toBeLessThanOrEqual(1);
  expect(Math.abs(entry.laid.height - from.height), `${name}: the first frame is the trigger's height ${at}`).toBeLessThanOrEqual(1);
  // ... and it lands on the resting panel, so the last frame is the identity.
  expect(entry.last, `${name}: the flight lands on the panel`).toBe("translate(0px, 0px) scale(1, 1)");
  // The first frames really are painted there: within 60 ms the panel is still
  // closer to the trigger's size than to the resting card's.
  const early = entry.frames.filter(frame => frame.t < 60 && frame.box !== null);
  expect(early.length, `${name}: the entry is painted`).toBeGreaterThan(0);
  const area = (rect: Rect) => rect.width * rect.height;
  const restArea = entry.rest.width * entry.rest.height;
  expect(area(early[0].box!), `${name}: painted near the trigger, not at rest`).toBeLessThan(restArea / 2);
  return entry;
}

test.describe("flight from the trigger (fine pointer)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the New task panel grows out of the button and lands centred", async ({ page }) => {
    await signUp(page, newEmail("flight-new-task"));
    const entry = await readEntry(page, ".topbar .button-accent");
    await settlePanel(page);
    await expectFlight(entry, entry.trigger, "New task");
    await expectCentered(page, page.getByRole("complementary", { name: "New task" }), await visibleBand(page));
  });

  test("a calendar block's details grow out of the block and land centred", async ({ page }) => {
    await signUp(page, newEmail("flight-block"));
    await nav(page).getByRole("button", { name: "Calendar" }).click();
    await expect(page.getByRole("button", { name: "New block" })).toBeVisible();
    const day = await page.evaluate(() => {
      const pad = (value: number) => String(value).padStart(2, "0");
      const now = new Date();
      return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    });
    await page.getByRole("button", { name: "New block" }).click();
    await page.getByLabel("Start", { exact: true }).fill(`${day}T10:00`);
    await page.getByLabel("End", { exact: true }).fill(`${day}T11:00`);
    await page.getByRole("button", { name: "Add block" }).click();
    // The creation sheet is still leaving; its panel is a `.sheet` too, and a
    // read taken now would describe that dismissal instead of this entry.
    await expect(page.getByRole("complementary", { name: "New block" })).toHaveCount(0);
    const block = page.locator(".calendar-block").first();
    await expect(block).toBeVisible();

    const entry = await readEntry(page, ".calendar-block");
    await settlePanel(page);
    await expectFlight(entry, entry.trigger, "Block details");
    await expectCentered(page, page.getByRole("complementary", { name: "Block details" }), await visibleBand(page));
  });

  test("a drag-created slot grows the New block panel out of its draft", async ({ page }) => {
    await signUp(page, newEmail("flight-slot"));
    await nav(page).getByRole("button", { name: "Calendar" }).click();
    await expect(page.getByRole("button", { name: "New block" })).toBeVisible();
    // 09:00 is 468 px into a column of 52 px hours; the grid scrolls inside its card.
    await page.locator(".cal-scroll").evaluate(element => {
      element.scrollTop = 8 * 52;
    });
    const day = await page.evaluate(() => {
      const pad = (value: number) => String(value).padStart(2, "0");
      const now = new Date();
      return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    });

    const entry = await readEntry(page, `[data-date="${day}"] .calendar-day-body`, { dx: 24, dy: 468 });
    await settlePanel(page);
    expect(entry.origin, "the draft the panel grows out of is on screen").not.toBeNull();
    await expectFlight(entry, entry.origin!, "New block");
    await expectCentered(page, page.getByRole("complementary", { name: "New block" }), await visibleBand(page));
  });

  test("the content of a panel arrives blurred and rests crisp, on the sheet that never blurs itself", async ({
    page,
  }) => {
    await signUp(page, newEmail("blur-in"));
    const entry = await readEntry(page, ".topbar .button-accent");
    // 8 px on a fine pointer: the card is close to the eye, so the focus pull is
    // short. A frame or two into the 260 ms ramp it is already less than 8.
    expect(entry.filter, "the content starts blurred").toContain("blur(");
    expect(blurRadius(entry.filter)).toBeGreaterThan(2);
    expect(blurRadius(entry.filter), "fine pointer: 8 px at most").toBeLessThanOrEqual(8);
    // The glass itself is never filtered: a blur on a backdrop-filter surface
    // makes the material behind it repaint flat.
    expect(entry.sheetFilter).toBe("none");

    const panel = page.getByRole("complementary", { name: "New task" });
    await settlePanel(page);
    const atRest = await panel.evaluate(element => {
      const body = element.querySelector<HTMLElement>(".sheet-body")!;
      return { filter: getComputedStyle(body).filter, inline: (body as HTMLElement).style.filter };
    });
    // Cleared, not left at blur(0): a filtered body stays on its own layer and
    // softens the field the panel just put the caret in.
    expect(atRest.filter).toBe("none");
    expect(atRest.inline).toBe("");
    expect(await panel.evaluate(element => getComputedStyle(element).filter)).toBe("none");
  });
});

test.describe("flight from the trigger (phone)", () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });

  test("the FAB grows into the New task panel and lands centred", async ({ page }) => {
    await signUp(page, newEmail("flight-fab"));
    const entry = await readEntry(page, ".fab");
    await settlePanel(page);
    await expectFlight(entry, entry.trigger, "FAB");
    await expectCentered(page, page.getByRole("complementary", { name: "New task" }), await visibleBand(page));
  });

  test("the content's blur is softer on a coarse pointer", async ({ page }) => {
    await signUp(page, newEmail("blur-coarse"));
    const entry = await readEntry(page, ".fab");
    expect(blurRadius(entry.filter), "the content starts blurred").toBeGreaterThan(1);
    // 4 px on the user's Moto G42: the same focus pull at half the radius.
    expect(blurRadius(entry.filter), "coarse pointer: 4 px at most").toBeLessThanOrEqual(4);
    expect(entry.sheetFilter).toBe("none");
  });
});

test.describe("task row into the centred panel", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("the row morphs into the centred panel, whose snapshot arrives blurred", async ({ page }) => {
    await signUp(page, newEmail("row-morph-centred"));
    await addTask(page, "Morph task");

    const morph = await page.evaluate(async () => {
      const row = [...document.querySelectorAll<HTMLButtonElement>(".task-open")].find(node =>
        node.textContent?.includes("Morph task"),
      );
      if (!row) throw new Error("no row");
      row.click();
      const frames: Array<{ t: number; box: DOMRect | null }> = [];
      // The browser's own animation of the frozen snapshots, read while the
      // transition runs (the pseudo animations are gone once it finishes).
      let pseudos: Array<{ pseudo: string; filters: string[] }> = [];
      const start = performance.now();
      for (let frame = 0; frame < 40; frame += 1) {
        await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
        const sheet = document.querySelector<HTMLElement>(".sheet");
        frames.push({ t: performance.now() - start, box: sheet ? sheet.getBoundingClientRect() : null });
        if (pseudos.length > 0) continue;
        pseudos = (document.getAnimations() as Animation[])
          .filter(animation => String((animation.effect as KeyframeEffect).pseudoElement ?? "").includes("task-morph"))
          .map(animation => ({
            pseudo: String((animation.effect as KeyframeEffect).pseudoElement),
            filters: (animation.effect as KeyframeEffect)
              .getKeyframes()
              .map(keyframe => String((keyframe as Keyframe).filter ?? "")),
          }));
      }
      return { frames, pseudos };
    });

    const panel = page.getByRole("complementary", { name: "Task details" });
    await expect(panel).toBeVisible();
    await expect(panel.getByLabel("Rename task")).toBeVisible();

    // The live panel never flies: the row's snapshot is the new side, so the
    // panel is already at rest on its first painted frame and only the browser's
    // snapshots travel. A FLIP here would be a second owner of the entrance.
    const painted = morph.frames.filter(frame => frame.box !== null);
    expect(painted.length).toBeGreaterThan(0);
    const first = painted[0].box!;
    const last = painted[painted.length - 1].box!;
    expect(Math.abs(first.width - last.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(first.x - last.x)).toBeLessThanOrEqual(1);

    // The arriving snapshot is blurred and sharpens: the content of the centred
    // card comes into focus as the row's box finishes growing into it.
    // One pseudo carries two animations (the fade and the focus pull), so every
    // entry that names the arriving side is read, not just the first.
    const incoming = morph.pseudos.filter(entry => entry.pseudo.includes("::view-transition-new(task-morph)"));
    expect(incoming.length, "the new snapshot is animated").toBeGreaterThan(0);
    const blurred = incoming.flatMap(entry => entry.filters).map(blurRadius).filter(radius => radius > 0);
    expect(blurred.length, "the new snapshot starts blurred").toBeGreaterThan(0);
    expect(Math.max(...blurred)).toBeLessThanOrEqual(8);
  });
});

test.describe("reduced motion", () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });

  test("the panel fades in place: no flight, no blur, opacity only", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await signUp(page, newEmail("reduced-panel"));

    const read = await page.evaluate(async () => {
      const fab = document.querySelector<HTMLElement>(".fab")!;
      fab.click();
      const frames: Array<{ t: number; box: DOMRect | null; filter: string }> = [];
      // The animation list is read while it runs: a finished Motion animation is
      // no longer on the element, and its properties are what this pins.
      const animations: string[][] = [];
      const start = performance.now();
      while (performance.now() - start < 400) {
        await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
        const sheet = document.querySelector<HTMLElement>(".sheet");
        const body = sheet?.querySelector<HTMLElement>(".sheet-body");
        frames.push({
          t: performance.now() - start,
          box: sheet ? sheet.getBoundingClientRect() : null,
          filter: body ? getComputedStyle(body).filter : "none",
        });
        for (const animation of sheet?.getAnimations() ?? []) {
          const properties = Object.keys(((animation.effect as KeyframeEffect).getKeyframes()[0] ?? {}) as Keyframe)
            .filter(key => !["offset", "computedOffset", "easing", "composite"].includes(key))
            .sort();
          if (!animations.some(entry => entry.join() === properties.join())) animations.push(properties);
        }
      }
      return { frames, animations };
    });

    const painted = read.frames.filter(frame => frame.box !== null);
    expect(painted.length).toBeGreaterThan(4);
    // No movement at all: the panel is laid out at rest from its first frame.
    const settled = painted[painted.length - 1].box!;
    for (const frame of painted) {
      expect(Math.abs(frame.box!.x - settled.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(frame.box!.width - settled.width)).toBeLessThanOrEqual(1);
    }
    // No blur either: reduced motion keeps the fade and drops the focus pull.
    expect(painted.every(frame => frame.filter === "none")).toBe(true);
    // And what is left is one opacity animation, never a transform.
    expect(read.animations.length).toBeGreaterThan(0);
    for (const properties of read.animations) expect(properties).toEqual(["opacity"]);
  });
});

test.describe("interruption and dismissal", () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });

  test("closing and reopening fast leaves a usable, centred panel", async ({ page }) => {
    await signUp(page, newEmail("rapid-reopen"));
    // The list view is where the created task lands (the FAB itself is the only
    // creation control a phone has).
    await nav(page).getByRole("button", { name: "Tasks" }).click();
    const fab = page.getByRole("button", { name: "New task" });
    const panel = page.getByRole("complementary", { name: "New task" });

    await fab.click();
    await expect(panel).toBeVisible();
    // Mid-flight: the panel is still travelling when it is dismissed...
    await page.waitForTimeout(90);
    await page.keyboard.press("Escape");
    // ...and the FAB is pressed again before that dismissal has finished.
    await fab.click();
    await expect(panel).toBeVisible();
    await settlePanel(page);

    await expectCentered(page, panel, await visibleBand(page));
    // Usable, not just visible: the field takes typing and the sheet submits.
    const title = panel.getByLabel("Task title");
    await expect(title).toBeFocused();
    await title.fill("Reopen works");
    await panel.getByRole("button", { name: "Add task" }).click();
    await expect(page.locator(".task-title", { hasText: "Reopen works" })).toBeVisible();
    await expect(panel).toHaveCount(0);
  });

  test("Escape and a scrim click both close the centred panel and hand the caret back", async ({ page }) => {
    await signUp(page, newEmail("dismiss-centred"));
    const fab = page.getByRole("button", { name: "New task" });
    const panel = page.getByRole("complementary", { name: "New task" });

    await fab.click();
    await expect(panel).toBeVisible();
    await settlePanel(page);
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(fab).toBeFocused();

    await fab.click();
    await expect(panel).toBeVisible();
    await settlePanel(page);
    // The scrim is everything the card does not cover: a point in the corner.
    await page.locator(".scrim").click({ position: { x: 4, y: 4 } });
    await expect(panel).toHaveCount(0);
    await expect(fab).toBeFocused();
  });
});
