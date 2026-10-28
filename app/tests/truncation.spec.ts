import { expect, test, type Locator, type Page } from "@playwright/test";
import { seedResponsiveFixture, submitAuthForm } from "./browser-helpers.ts";

/**
 * Ronda 5, R5-01 / R5-11 / R5-21 (odd/research/ui-audit-r5.md): a long title is
 * what yields, never the date beside it, and a short calendar block keeps a
 * one-line title. The fixture is the audit's own: a 70-character overdue title.
 */

test.setTimeout(120_000);

const ZONE = "America/Sao_Paulo";
test.use({ timezoneId: ZONE });

/** The responsive fixture's overdue task: 77 characters, deadline yesterday. */
const LONG_TITLE = "Follow up with the accountant about the Q3 invoices and the withholding form";
/** Its 30-minute block (20:00-20:30) carries the unbreakable-token task title. */
const SHORT_BLOCK_TITLE = "Supercalifragilisticexpialidociousness";

async function enter(page: Page) {
  const email = `trunc-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
  await seedResponsiveFixture(email, ZONE);
  await submitAuthForm(page, email, "sign in");
}

/** The meta text is whole, or the element can still ellipsize it: never a bare clip. */
async function expectDateNotClipped(meta: Locator) {
  await expect(meta).toBeVisible();
  const state = await meta.evaluate(element => {
    const style = getComputedStyle(element);
    return {
      text: element.textContent ?? "",
      overflow: element.scrollWidth - element.clientWidth,
      client: element.clientWidth,
      scroll: element.scrollWidth,
      parent: element.parentElement!.clientWidth,
      ellipsis: style.textOverflow === "ellipsis" && style.display !== "inline-flex",
    };
  });
  expect(state.text).toMatch(/^(due )?\w{3}, \w{3} \d{1,2}$/);
  expect(state.overflow <= 1 || state.ellipsis, JSON.stringify(state)).toBe(true);
  // With a 70-character title the date has room: it must be complete, not just ellipsized.
  expect(state.overflow, JSON.stringify(state)).toBeLessThanOrEqual(1);
}

for (const [name, viewport] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
  test.describe(name, () => {
    test.use({ viewport });

    test(`the overdue date is never clipped mid-glyph on ${name}`, async ({ page }) => {
      await enter(page);
      const home = page.locator(".row", { hasText: LONG_TITLE }).locator(".row-meta.is-overdue");
      await expectDateNotClipped(home);
      await expect(page.locator(".row", { hasText: LONG_TITLE }).locator(".row-title")).toHaveAttribute("title", LONG_TITLE);

      await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Tasks" }).click();
      const tasks = page.locator(".row", { hasText: LONG_TITLE }).locator(".row-meta.task-deadline");
      await expectDateNotClipped(tasks);
    });
  });
}

test.describe("calendar", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("a 30-minute block keeps a one-line title and carries its full text", async ({ page }) => {
    await enter(page);
    await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Calendar" }).click();
    const block = page.locator(".calendar-block", { hasText: SHORT_BLOCK_TITLE });
    await block.scrollIntoViewIfNeeded();
    await expect(block).toHaveClass(/is-short/);
    await expect(block).toHaveAttribute("title", new RegExp(`^${SHORT_BLOCK_TITLE}\\w* \\d{2}:\\d{2}–\\d{2}:\\d{2}$`));
    // The fixture's title is one unbreakable token, which never wraps; swap in a
    // breakable sentence so the CSS, not the data, is what keeps the line single.
    const lines = await block.locator("b").evaluate(element => {
      element.textContent = "Prepare the quarterly roadmap review with design and engineering leads";
      const lineHeight = parseFloat(getComputedStyle(element).lineHeight);
      return element.getBoundingClientRect().height / lineHeight;
    });
    expect(lines).toBeLessThan(1.5);
  });

  test("the subtitle names the zone, keeping the id in a title", async ({ page }) => {
    await enter(page);
    await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Calendar" }).click();
    const note = page.locator(".subtitle span[title]").first();
    await expect(note).toHaveText("Times in Brasilia Standard Time");
    await expect(note).toHaveAttribute("title", ZONE);
  });
});
