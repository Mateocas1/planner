import { expect, test, type Locator, type Page } from "@playwright/test";
import { pickDate, seedProfile, submitAuthForm } from "./browser-helpers.ts";

/**
 * DateField (Ronda 5, specs S3/S4): the Deadline control of "+ New task" and its
 * popover, proven in a browser.
 *
 * The planner's clock is fixed after sign-in (Playwright fixes `Date` only, so
 * timers keep running) and the profile zone is seeded, so "today" and every
 * quick-list row are exact whatever day the suite runs on. 2026-10-28 is a
 * Wednesday; 2026-10-30 a Friday; 2026-11-01 a Sunday.
 */

test.setTimeout(90_000);

const zone = "America/New_York";
const wednesday = "2026-10-28T16:00:00Z";
const friday = "2026-10-30T16:00:00Z";
const sunday = "2026-11-01T17:00:00Z";

function newEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
}

/** Signs in with the zone seeded, fixes the clock and opens the New task sheet. */
async function openSheet(page: Page, now = wednesday): Promise<Locator> {
  const email = newEmail("date-field");
  await seedProfile(email, zone);
  await submitAuthForm(page, email, "sign in");
  await page.clock.setFixedTime(new Date(now));
  await page.getByRole("button", { name: "New task" }).first().click();
  const sheet = page.getByRole("complementary", { name: "New task" });
  await expect(sheet.getByLabel("Task title")).toBeFocused();
  await expect.poll(() => sheet.evaluate(element => element.getAnimations().length)).toBe(0);
  return sheet;
}

const dialog = (scope: Page | Locator) => scope.getByRole("dialog", { name: "Choose date" });
const trigger = (sheet: Locator) => sheet.getByLabel("Deadline");

async function openPopover(sheet: Locator) {
  await trigger(sheet).click();
  await expect(dialog(sheet)).toBeVisible();
}

/** The popover and its body have finished every transition (entrance or exit). */
async function settledPopover(sheet: Locator) {
  await expect
    .poll(() =>
      trigger(sheet).evaluate(element => {
        const pop = document.getElementById(element.getAttribute("aria-controls") ?? "")!;
        return pop.getAnimations({ subtree: true }).length;
      }),
    )
    .toBe(0);
}

test("the trigger reads the date in words, never a format mask", async ({ page }) => {
  const sheet = await openSheet(page);
  const deadline = trigger(sheet);

  await expect(deadline).toHaveAttribute("role", "combobox");
  await expect(deadline).toHaveText("No date");
  await expect(deadline).toHaveAttribute("data-value", "");
  await expect(sheet).not.toContainText("mm/dd/yyyy");

  await pickDate(sheet, "Deadline", "2026-10-29");
  await expect(deadline).toHaveText("Tomorrow");
  await expect(deadline).toHaveAttribute("data-value", "2026-10-29");

  await pickDate(sheet, "Deadline", "2026-10-30");
  await expect(deadline).toHaveText("Fri, Oct 30");
  await expect(deadline).toHaveAttribute("data-value", "2026-10-30");

  // The value is the accent colour, the empty state is quiet.
  const colors = await deadline.evaluate(element => {
    const probe = document.createElement("span");
    probe.style.color = "var(--accent)";
    element.append(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    return { text: getComputedStyle(element).color, accent };
  });
  expect(colors.text).toBe(colors.accent);

  await pickDate(sheet, "Deadline", "");
  await expect(deadline).toHaveText("No date");
});

test("the quick list resolves each row from the profile's today", async ({ page }) => {
  const sheet = await openSheet(page);
  await openPopover(sheet);
  const pop = dialog(sheet);

  // Wednesday: all four named days, with the weekday each one lands on; no clear row yet.
  await expect(pop.getByRole("button", { name: "Today Wed" })).toBeVisible();
  await expect(pop.getByRole("button", { name: "Tomorrow Thu" })).toBeVisible();
  await expect(pop.getByRole("button", { name: "This weekend Sat" })).toBeVisible();
  await expect(pop.getByRole("button", { name: "Next week Mon" })).toBeVisible();
  await expect(pop.getByRole("button", { name: "No date" })).toHaveCount(0);

  await pop.getByRole("button", { name: "Next week Mon" }).click();
  await expect(trigger(sheet)).toHaveAttribute("data-value", "2026-11-02");

  await openPopover(sheet);
  await expect(pop.getByRole("button", { name: "Next week Mon" })).toHaveAttribute("aria-pressed", "true");
  await pop.getByRole("button", { name: "This weekend Sat" }).click();
  await expect(trigger(sheet)).toHaveAttribute("data-value", "2026-10-31");

  await openPopover(sheet);
  await pop.getByRole("button", { name: "Today Wed" }).click();
  await expect(trigger(sheet)).toHaveAttribute("data-value", "2026-10-28");
  await expect(trigger(sheet)).toHaveText("Today");

  await openPopover(sheet);
  await pop.getByRole("button", { name: "No date" }).click();
  await expect(trigger(sheet)).toHaveAttribute("data-value", "");
});

test("This weekend drops out on Friday, where Next week is still the coming Monday", async ({ page }) => {
  const sheet = await openSheet(page, friday);
  await openPopover(sheet);
  await expect(dialog(sheet).getByRole("button", { name: "Today Fri" })).toBeVisible();
  await expect(dialog(sheet).getByRole("button", { name: /^This weekend/ })).toHaveCount(0);
  await dialog(sheet).getByRole("button", { name: "Next week Mon" }).click();
  await expect(trigger(sheet)).toHaveAttribute("data-value", "2026-11-02");
});

test("This weekend is also absent on Sunday", async ({ page }) => {
  const sheet = await openSheet(page, sunday);
  await openPopover(sheet);
  await expect(dialog(sheet).getByRole("button", { name: "Today Sun" })).toBeVisible();
  await expect(dialog(sheet).getByRole("button", { name: /^This weekend/ })).toHaveCount(0);
  await dialog(sheet).getByRole("button", { name: "Next week Mon" }).click();
  await expect(trigger(sheet)).toHaveAttribute("data-value", "2026-11-02");
});

test("the week starts on Monday", async ({ page }) => {
  const sheet = await openSheet(page);
  await openPopover(sheet);
  await expect(dialog(sheet).getByRole("columnheader")).toHaveText(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
  // October 2026 begins on a Thursday: the first cell is the Monday before it.
  await expect(dialog(sheet).locator("[data-date]").first()).toHaveAttribute("data-date", "2026-09-28");
});

test("the keyboard opens the popover and walks the grid", async ({ page }) => {
  const sheet = await openSheet(page);
  const pop = dialog(sheet);
  const focusedDate = () => page.evaluate(() => document.activeElement?.getAttribute("data-date") ?? null);

  await trigger(sheet).focus();
  await page.keyboard.press("ArrowDown");
  await expect(pop).toBeVisible();
  // Focus lands on today's cell (no value yet) and the grid has one tab stop.
  await expect.poll(focusedDate).toBe("2026-10-28");
  await expect(pop.locator('[data-date][tabindex="0"]')).toHaveCount(1);

  await page.keyboard.press("ArrowRight");
  await expect.poll(focusedDate).toBe("2026-10-29");
  await page.keyboard.press("ArrowDown");
  await expect.poll(focusedDate).toBe("2026-11-05"); // crossing the month follows focus
  await expect(pop.locator("[data-month]")).toHaveAttribute("data-month", "2026-11");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowUp");
  await expect.poll(focusedDate).toBe("2026-10-28");
  await page.keyboard.press("Home");
  await expect.poll(focusedDate).toBe("2026-10-26");
  await page.keyboard.press("End");
  await expect.poll(focusedDate).toBe("2026-11-01");
  await page.keyboard.press("PageUp");
  await expect.poll(focusedDate).toBe("2026-10-01");
  await page.keyboard.press("Shift+PageDown");
  await expect.poll(focusedDate).toBe("2027-10-01");
  await page.keyboard.press("PageDown");
  await expect.poll(focusedDate).toBe("2027-11-01");
  await page.keyboard.press("Enter");

  await expect(pop).toBeHidden();
  await expect(trigger(sheet)).toHaveAttribute("data-value", "2027-11-01");
  await expect(trigger(sheet)).toBeFocused();
});

test("Escape closes only the popover and gives focus back; a second Escape closes the sheet", async ({ page }) => {
  const sheet = await openSheet(page);
  await openPopover(sheet);

  await page.keyboard.press("Escape");
  await expect(dialog(sheet)).toBeHidden();
  await expect(sheet).toBeVisible();
  await expect(trigger(sheet)).toBeFocused();
  await expect(trigger(sheet)).toHaveAttribute("aria-expanded", "false");

  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
});

test("an outside click closes only the popover, and Tab out closes it without stealing focus", async ({ page }) => {
  const sheet = await openSheet(page);

  await openPopover(sheet);
  await sheet.getByLabel("Task title").click();
  await expect(dialog(sheet)).toBeHidden();
  await expect(sheet).toBeVisible();
  await expect(sheet.getByLabel("Task title")).toBeFocused();

  await openPopover(sheet);
  await page.keyboard.press("Tab"); // the grid's single tab stop is next to leave
  await expect(dialog(sheet)).toBeHidden();
  await expect(sheet).toBeVisible();
  await expect(trigger(sheet)).not.toBeFocused();
});

test("choosing a day closes the popover and returns focus to the trigger", async ({ page }) => {
  const sheet = await openSheet(page);
  await pickDate(sheet, "Deadline", "2026-12-24");
  await expect(trigger(sheet)).toBeFocused();
  await expect(trigger(sheet)).toHaveText("Thu, Dec 24");

  // A pointer choice of an out-of-month day keeps working too (October's grid shows 2 Nov).
  await trigger(sheet).click();
  await dialog(sheet).locator('[data-date="2026-12-31"]').click();
  await expect(trigger(sheet)).toBeFocused();
  await expect(trigger(sheet)).toHaveAttribute("data-value", "2026-12-31");
});

test("opening materializes: blur, scale and fade in; leaving is opacity and a small scale", async ({ page }) => {
  const sheet = await openSheet(page);
  const probe = (target: Locator) =>
    target.evaluate(element => {
      const pop = document.getElementById(element.getAttribute("aria-controls") ?? "")!;
      const body = pop.querySelector(".pop-body")!;
      const describe = (el: Element) =>
        el.getAnimations().map(animation => {
          const frames = (animation.effect as KeyframeEffect).getKeyframes();
          const last = frames[frames.length - 1];
          return {
            property: (animation as CSSTransition).transitionProperty,
            from: frames[0] as Record<string, unknown>,
            to: last as Record<string, unknown>,
          };
        });
      return { pop: describe(pop), body: describe(body) };
    });

  // Read in the same task as the press, before any frame: the transitions have just started.
  const entering = await trigger(sheet).evaluate(async element => {
    (element as HTMLElement).click();
    await new Promise(resolve => setTimeout(resolve, 0));
    return null;
  });
  expect(entering).toBeNull();
  const open = await probe(trigger(sheet));
  const bodyFilter = open.body.find(entry => entry.property === "filter");
  expect(bodyFilter, "the content comes into focus").toBeTruthy();
  expect(String(bodyFilter!.from.filter)).toContain("blur(8px)");
  expect(String(bodyFilter!.to.filter)).toMatch(/none|blur\(0px\)/);
  expect(open.body.some(entry => entry.property === "opacity")).toBe(true);
  const popTransform = open.pop.find(entry => entry.property === "transform");
  expect(popTransform, "the surface grows from the trigger").toBeTruthy();
  expect(String(popTransform!.from.transform)).toMatch(/0\.96/);
  expect(open.pop.some(entry => entry.property === "opacity")).toBe(true);

  await settledPopover(sheet);
  const settled = await trigger(sheet).evaluate(element => {
    const pop = document.getElementById(element.getAttribute("aria-controls") ?? "")!;
    const body = pop.querySelector(".pop-body")!;
    return { opacity: getComputedStyle(pop).opacity, scale: new DOMMatrix(getComputedStyle(pop).transform).a, filter: getComputedStyle(body).filter };
  });
  expect(settled).toEqual({ opacity: "1", scale: 1, filter: "none" });

  // The exit: opacity and a quiet .98 scale, no blur.
  await page.keyboard.press("Escape");
  const leaving = await probe(trigger(sheet));
  const exitTransform = leaving.pop.find(entry => entry.property === "transform");
  expect(exitTransform).toBeTruthy();
  expect(String(exitTransform!.to.transform)).toMatch(/0\.98/);
  expect(leaving.pop.some(entry => entry.property === "opacity")).toBe(true);
  expect(leaving.body.some(entry => entry.property === "filter")).toBe(false);
});

test.describe("with reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("the entrance is opacity only", async ({ page }) => {
    const sheet = await openSheet(page);
    await trigger(sheet).evaluate(async element => {
      (element as HTMLElement).click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    const properties = await trigger(sheet).evaluate(element => {
      const pop = document.getElementById(element.getAttribute("aria-controls") ?? "")!;
      return pop
        .getAnimations({ subtree: true })
        .map(animation => (animation as CSSTransition).transitionProperty)
        .filter(property => ["opacity", "transform", "scale", "filter"].includes(property));
    });
    // Gentler, not zero: the fade stays, the scale and the blur are gone.
    expect(properties.length).toBeGreaterThan(0);
    for (const property of properties) expect(property).toBe("opacity");
    await expect(dialog(sheet)).toBeVisible();
  });
});

/** The popover sits inside the viewport and is what a pointer would hit at its centre. */
async function expectPlaced(page: Page, sheet: Locator) {
  await settledPopover(sheet);
  const pop = dialog(sheet);
  const box = (await pop.boundingBox())!;
  const view = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(view.width);
  expect(box.y + box.height).toBeLessThanOrEqual(view.height);
  const topmost = await pop.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return hit !== null && element.contains(hit);
  });
  expect(topmost, "nothing paints over the popover").toBe(true);
  return box;
}

test("the popover stays inside a 1366x768 window, below the field", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const sheet = await openSheet(page);
  await openPopover(sheet);
  const box = await expectPlaced(page, sheet);
  expect(box.width).toBeCloseTo(304, 0);
  // The grid and the quick list are all reachable: the last grid row is inside the popover.
  const last = (await dialog(sheet).locator("[data-date]").last().boundingBox())!;
  expect(last.y + last.height).toBeLessThanOrEqual(box.y + box.height);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("the popover fits 390x844, the trigger text stays 16px and the days are touch sized", async ({ page }) => {
    const sheet = await openSheet(page);
    expect(await page.evaluate(() => parseFloat(getComputedStyle(document.getElementById("task-deadline")!).fontSize))).toBeGreaterThanOrEqual(16);
    await openPopover(sheet);
    const box = await expectPlaced(page, sheet);
    expect(box.width).toBeCloseTo(332, 0);
    expect(box.width).toBeLessThanOrEqual(390 - 24);
    const day = (await dialog(sheet).locator('[data-date="2026-10-28"]').boundingBox())!;
    expect(day.width).toBeGreaterThanOrEqual(40);
    expect(day.height).toBeGreaterThanOrEqual(40);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
