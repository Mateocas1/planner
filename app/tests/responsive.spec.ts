import { expect, test, type Page } from "@playwright/test";
import { seedResponsiveFixture, submitAuthForm } from "./browser-helpers.ts";

/**
 * The responsive pass of odd/research/responsive-audit.md, asserted as the
 * measurements a reader can feel: usable calendar columns on a tablet, a title
 * that stays readable on a 320 px phone, 44 px targets under a thumb, the phone
 * shell in landscape, a grid above the fold, and no page scroll at 200 % text
 * zoom. Every number here is the audit's own threshold, not a tolerance on a
 * broken one.
 */

test.setTimeout(120_000);

/** The zone the fixture seeds, and the zone the browser must agree with. */
const ZONE = "America/Sao_Paulo";
test.use({ timezoneId: ZONE });

function newEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
}

/** Seeds the fixture, then signs a fresh account up through the app's own form. */
async function enter(page: Page, prefix: string) {
  const email = newEmail(prefix);
  await seedResponsiveFixture(email, ZONE);
  // The fixture creates the account over the emulator's REST API, so the form
  // signs that account in rather than signing it up a second time.
  await submitAuthForm(page, email, "sign in");
  return email;
}

function nav(page: Page) {
  return page.getByRole("navigation", { name: "Main" });
}

async function openTasks(page: Page) {
  await nav(page).getByRole("button", { name: "Tasks" }).click();
  await expect(page.locator(".task-title").first()).toBeAttached();
}

async function openCalendar(page: Page) {
  await nav(page).getByRole("button", { name: "Calendar" }).click();
  await expect(page.locator(".calendar-block").first()).toBeVisible();
}

/** The root font-size, which is how a browser's text zoom reaches the page. */
async function textZoom(page: Page, px: number) {
  await page.evaluate(size => {
    document.documentElement.style.fontSize = `${size}px`;
  }, px);
}

type Box = { x: number; y: number; width: number; height: number };

/**
 * The effective hit area of a control: its own box, widened by the `::before`
 * a control may carry, and probed with `elementFromPoint` so a hit area that
 * exists only in CSS is not taken on faith. `misses` counts the four corners of
 * a `min` by `min` square centred on the control that do not land on it.
 */
async function hitArea(page: Page, selector: string, min = 44) {
  return page.evaluate(
    ({ selector: sel, min: size }) => {
      const element = document.querySelector<HTMLElement>(sel);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const half = size / 2 - 0.5;
      const corners: Array<[number, number]> = [
        [cx - half, cy - half],
        [cx + half, cy - half],
        [cx - half, cy + half],
        [cx + half, cy + half],
      ];
      const misses = corners.filter(([x, y]) => {
        const hit = document.elementFromPoint(x, y);
        return !hit || !(hit === element || element.contains(hit));
      }).length;
      return { width: Math.round(rect.width * 10) / 10, height: Math.round(rect.height * 10) / 10, misses };
    },
    { selector, min },
  );
}

async function expectHitArea(page: Page, selector: string, name: string, min = 44) {
  const area = await hitArea(page, selector, min);
  expect(area, `${name} exists`).not.toBeNull();
  expect(area!.misses, `${name} keeps a ${min} px hit area (box ${area!.width}x${area!.height})`).toBe(0);
}

/** Polls a browser measurement until it stops moving, then returns it. */
async function settled<T>(read: () => Promise<T>): Promise<T> {
  let previous = await read();
  await expect
    .poll(async () => {
      const current = await read();
      const same = JSON.stringify(current) === JSON.stringify(previous);
      previous = current;
      return same;
    })
    .toBe(true);
  return previous;
}

/* ============================ F1: the week grid ============================ */

/**
 * A tablet is not a desktop: at 768 px the sidebar leaves 7 columns of 55 px
 * (audit F1), so the week view is unreadable there. Below ~1000 px the calendar
 * switches to the day range instead, and the tray stops taking a column until
 * 1440 px so the wide desktop keeps its full week.
 */
test("F1 the calendar gives a tablet a readable column instead of seven slivers", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await enter(page, "f1-tablet");
  await openCalendar(page);

  const grid = await settled(() =>
    page.evaluate(() => {
      const day = document.querySelector<HTMLElement>(".calendar-day-body");
      const block = document.querySelector<HTMLElement>(".calendar-block");
      const title = block?.querySelector("b") ?? null;
      const chip = document.querySelector<HTMLElement>(".due-chip");
      return {
        days: document.querySelectorAll(".calendar-day-body").length,
        dayWidth: Math.round((day?.getBoundingClientRect().width ?? 0) * 10) / 10,
        blockWidth: Math.round((block?.getBoundingClientRect().width ?? 0) * 10) / 10,
        titleWidth: Math.round((title?.getBoundingClientRect().width ?? 0) * 10) / 10,
        chipWidth: Math.round((chip?.getBoundingClientRect().width ?? 0) * 10) / 10,
      };
    }),
  );

  expect(grid.days, "768 px gets the day range, not a seven-column week").toBe(1);
  expect(grid.dayWidth, "the day column stays readable").toBeGreaterThanOrEqual(300);
  expect(grid.blockWidth, "a block is wide enough for a title").toBeGreaterThanOrEqual(200);
  expect(grid.titleWidth, "a block title is not a two-letter ellipsis").toBeGreaterThanOrEqual(180);
  expect(grid.chipWidth, "a due chip survives").toBeGreaterThanOrEqual(80);
});

test("F1 the wide desktop keeps its full week and its tray", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await enter(page, "f1-desktop");
  await openCalendar(page);

  const grid = await settled(() =>
    page.evaluate(() => {
      const cal = document.querySelector<HTMLElement>(".cal")!.getBoundingClientRect();
      const tray = document.querySelector<HTMLElement>(".tray")?.getBoundingClientRect() ?? null;
      const day = document.querySelector<HTMLElement>(".calendar-day-body")!.getBoundingClientRect();
      return { days: document.querySelectorAll(".calendar-day-body").length, dayWidth: day.width, calRight: cal.right, trayLeft: tray?.left ?? null };
    }),
  );

  expect(grid.days, "1440 px keeps the week").toBe(7);
  expect(grid.dayWidth, "seven comfortable columns").toBeGreaterThanOrEqual(100);
  expect(grid.trayLeft, "the tray is still beside the grid").not.toBeNull();
  expect(grid.trayLeft!, "the tray sits to the right of the grid").toBeGreaterThan(grid.calRight);
});

/* ===================== F2, F8, F10: reading a row ====================== */

/**
 * The title and the meta share one line, and `.row-meta` may not shrink (audit
 * F2): at 320 px a series title is 34 px wide, and at 200 % text zoom the meta
 * takes the whole row and the title disappears. The meta now yields, and below
 * 420 px it is capped at 42 % so the title always wins the room to be read.
 */
test("F2 a 320 px phone keeps a readable task title beside its meta", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await enter(page, "f2-phone");
  await openTasks(page);

  const rows = await settled(() =>
    page.evaluate(() => {
      const list = [...document.querySelectorAll<HTMLElement>(".row-main")].filter(main => main.querySelector(".row-title, .task-title"));
      return list.map(main => {
        const title = main.querySelector<HTMLElement>(".row-title, .task-title")!;
        const meta = main.querySelector<HTMLElement>(".row-meta");
        const row = main.getBoundingClientRect();
        return {
          title: Math.round(title.getBoundingClientRect().width * 10) / 10,
          meta: meta ? Math.round(meta.getBoundingClientRect().width * 10) / 10 : null,
          metaRight: meta ? Math.round(meta.getBoundingClientRect().right * 10) / 10 : null,
          rowRight: Math.round(row.right * 10) / 10,
        };
      });
    }),
  );

  const titles = rows.map(row => row.title);
  const metas = rows.flatMap(row => (row.meta === null ? [] : [row.meta]));
  expect(Math.min(...titles), "the narrowest title is still readable").toBeGreaterThanOrEqual(100);
  expect(Math.max(...metas), "the meta is capped so the title can breathe").toBeLessThanOrEqual(0.42 * 288 + 1);
  for (const row of rows) {
    if (row.metaRight === null) continue;
    expect(row.metaRight, "the meta stays inside its row").toBeLessThanOrEqual(row.rowRight + 0.5);
  }
});

test("F2 at 200 % text zoom the title survives the meta instead of vanishing", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await enter(page, "f2-zoom");
  await openTasks(page);
  await textZoom(page, 32);

  const rows = await settled(() =>
    page.evaluate(() => {
      const list = [...document.querySelectorAll<HTMLElement>(".row-main")].filter(main => main.querySelector(".row-title, .task-title"));
      return {
        titles: list.map(main => Math.round(main.querySelector<HTMLElement>(".row-title, .task-title")!.getBoundingClientRect().width * 10) / 10),
        over: list.filter(main => {
          const meta = main.querySelector<HTMLElement>(".row-meta");
          const group = main.closest("ul.group");
          return meta && group && meta.getBoundingClientRect().right > group.getBoundingClientRect().right + 0.5;
        }).length,
        scroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    }),
  );

  expect(Math.min(...rows.titles), "no title collapses to nothing under text zoom").toBeGreaterThanOrEqual(100);
  expect(rows.over, "no meta spills out of its row").toBe(0);
  expect(rows.scroll, "and the page still does not scroll sideways").toBeLessThanOrEqual(1);
});

test("F10 a truncated title still gives the full text, and F8 labels read at 12 px", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await enter(page, "f10-titles");
  await openTasks(page);

  const untitled = await settled(() =>
    page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".task-title, .row-title")].filter(
        element =>
          element.getBoundingClientRect().width > 0 &&
          element.scrollWidth - element.clientWidth > 2 &&
          !element.getAttribute("title") &&
          !element.closest("[title]"),
      ).length,
    ),
  );
  expect(untitled, "every truncated title exposes its full text").toBe(0);

  await openCalendar(page);
  const labels = await settled(() =>
    page.evaluate(() => {
      const size = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector);
        return element ? Math.round(parseFloat(getComputedStyle(element).fontSize) * 10) / 10 : null;
      };
      const gutter = document.querySelector<HTMLElement>(".gutter")!.getBoundingClientRect();
      const now = document.querySelector<HTMLElement>(".gutter-now")!.getBoundingClientRect();
      const head = getComputedStyle(document.querySelector(".cal-head")!).gridTemplateColumns.split(" ")[0];
      return {
        token: getComputedStyle(document.documentElement).getPropertyValue("--text-tiny").trim(),
        gutter: size(".gutter"),
        dueLabel: size(".cal-due-label"),
        gutterNowRight: Math.round(now.right * 10) / 10,
        gutterRight: Math.round(gutter.right * 10) / 10,
        gutterColumn: parseFloat(head),
      };
    }),
  );

  expect(parseFloat(labels.token) * 16, "the tiny tier is 12 px").toBeGreaterThanOrEqual(12);
  expect(labels.gutter, "the hour labels read at 12 px").toBeGreaterThanOrEqual(12);
  expect(labels.dueLabel, "the Due label reads at 12 px").toBeGreaterThanOrEqual(12);
  expect(labels.gutterColumn, "the gutter is wide enough for its labels").toBeGreaterThanOrEqual(64);
  expect(labels.gutterNowRight, "the now label stays inside the gutter").toBeLessThanOrEqual(labels.gutterRight + 0.5);
});

/* ========================= F3, F9: touch targets ========================= */

test.describe("a thumb on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });

  /**
   * Only `.check` had a 44 px hit area before this pass (audit F3): the close
   * buttons were 30 px, the rows 31 px, the fields 33 px. On a coarse pointer
   * every one of them is at least 44 px in both directions.
   */
  test("F3 every control a thumb reaches is 44 px in both directions", async ({ page }) => {
    await enter(page, "f3-phone");
    await openTasks(page);

    await expectHitArea(page, ".topbar-actions .icon-button.large", "the top bar's search", 44);
    const row = await page.locator(".row-main.task-open").first().boundingBox();
    expect(row!.height, "a task row is a 44 px tall target").toBeGreaterThanOrEqual(44);

    await page.locator(".row-main.task-open").first().click();
    await expect(page.getByRole("complementary", { name: "Task details" })).toBeVisible();
    await expectHitArea(page, ".sheet .icon-button[aria-label='Close']", "the sheet's close", 44);
    const control = await page.locator(".sheet .form-control").first().boundingBox();
    expect(control!.height, "a form control is 44 px tall").toBeGreaterThanOrEqual(44);
    await expectHitArea(page, ".sheet .switch", "the reminder switch", 44);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("complementary", { name: "Task details" })).toHaveCount(0);

    await page.getByRole("button", { name: "New task" }).click();
    const sheet = page.getByRole("complementary", { name: "New task" });
    await expect(sheet).toBeVisible();
    const titleField = await page.locator(".sheet-title").boundingBox();
    expect(titleField!.height, "the sheet's title field is 44 px tall").toBeGreaterThanOrEqual(44);
    await expectHitArea(page, ".sheet .icon-button[aria-label='Close']", "the New task sheet's close", 44);
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);

    await page.keyboard.press("Control+k");
    await expect(page.locator("dialog.palette")).toBeVisible();
    const input = await page.locator(".palette-input").boundingBox();
    expect(input!.height, "the palette's field is 44 px tall").toBeGreaterThanOrEqual(44);
    await expectHitArea(page, "dialog.palette .icon-button", "the palette's close", 44);
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog.palette")).toHaveCount(0);

    await openTasks(page);
    await page.locator(".row.task:not(.series-row) .task-open").first().click();
    await expect(page.getByRole("complementary", { name: "Task details" })).toBeVisible();
    await page.getByRole("button", { name: "Delete task" }).click();
    await expect(page.locator(".undo-toast")).toBeVisible();
    const undo = await page.locator(".undo-toast-action").boundingBox();
    expect(undo!.height, "Undo is a 44 px target").toBeGreaterThanOrEqual(44);
    await expectHitArea(page, ".undo-toast-close", "the toast's dismiss", 44);
  });
});

test.describe("a thumb on a small phone", () => {
  test.use({ viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

  /** F9: seven columns of 288 px leave 41 px each; the circle is 40 px and the column is the target. */
  test("F9 the week strip's day button is a 40 px circle with a full-height target", async ({ page }) => {
    await enter(page, "f9-strip");
    await openCalendar(page);
    const strip = await page.evaluate(() => {
      const date = document.querySelector<HTMLElement>(".strip-date")!.getBoundingClientRect();
      const day = document.querySelector<HTMLElement>(".strip-day")!.getBoundingClientRect();
      return { date: Math.round(date.width * 10) / 10, dateHeight: Math.round(date.height * 10) / 10, dayWidth: Math.round(day.width * 10) / 10, dayHeight: Math.round(day.height * 10) / 10 };
    });
    expect(strip.date, "the date circle is 40 px").toBeGreaterThanOrEqual(40);
    expect(strip.dateHeight, "the date circle is 40 px tall").toBeGreaterThanOrEqual(40);
    expect(strip.dayHeight, "the column keeps a 44 px tall target").toBeGreaterThanOrEqual(44);
  });
});

test.describe("a thumb on a tablet", () => {
  test.use({ viewport: { width: 1500, height: 1000 }, isMobile: true, hasTouch: true });

  /** The mouse-sized controls a coarse desktop-class screen still shows (audit F3). */
  test("F3 the segmented range, the buttons and the tray's Plan are thumb-sized", async ({ page }) => {
    await enter(page, "f3-tablet");
    await openCalendar(page);

    const segmented = await page.locator(".segmented button").first().boundingBox();
    expect(segmented!.height, "a segmented option is 44 px tall").toBeGreaterThanOrEqual(44);
    const button = await page.locator(".toolbar .button").first().boundingBox();
    expect(button!.height, "a toolbar button is 44 px tall").toBeGreaterThanOrEqual(44);
    const icon = await page.locator(".toolbar .button.icon").first().boundingBox();
    await expectHitArea(page, ".toolbar .button.icon", "the previous-range button", 44);
    expect(icon!.width, "the icon button keeps its 44 px hit area").toBeLessThanOrEqual(60);

    const plan = await page.locator(".tray .button.small").first().boundingBox();
    expect(plan, "the tray offers Plan").not.toBeNull();
    expect(plan!.height, "Plan is 44 px tall").toBeGreaterThanOrEqual(44);

    await nav(page).getByRole("button", { name: "Today" }).click();
    await expect(page.getByRole("button", { name: "Open calendar" })).toBeVisible();
    await expectHitArea(page, ".link-button", "Open calendar", 44);
  });
});

/* ===================== F4, F5, F11: the shell ===================== */

/**
 * A phone in landscape is 844 x 390: wider than the 760 px breakpoint, so it
 * used to get the desktop sidebar -- 244 px of a 390 px tall screen, with the
 * sign-out row scrolling out of a 370 px column -- and 380 px of grid in the
 * 115 px left above the fold (audit F4/F5).
 */
test("F4 a landscape phone gets the phone shell, not a 244 px sidebar", async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await enter(page, "f4-landscape");
  await openCalendar(page);

  const shell = await settled(() =>
    page.evaluate(() => {
      const grid = document.querySelector<HTMLElement>(".cal-scroll")!.getBoundingClientRect();
      return {
        phone: document.querySelector(".shell")!.classList.contains("is-phone"),
        sidebar: document.querySelectorAll(".sidebar").length,
        tabbar: document.querySelectorAll(".tabbar").length,
        fab: document.querySelectorAll(".fab").length,
        gridTop: Math.round(grid.top * 10) / 10,
        gridVisible: Math.round(Math.max(0, Math.min(grid.height, window.innerHeight - grid.top)) * 10) / 10,
        gridBottom: Math.round(grid.bottom * 10) / 10,
        innerHeight: window.innerHeight,
        sideways: document.documentElement.scrollWidth - window.innerWidth,
      };
    }),
  );

  expect(shell.phone, "the shell is the phone shell").toBe(true);
  expect(shell.sidebar, "no sidebar").toBe(0);
  expect(shell.tabbar, "the tab bar is there").toBe(1);
  expect(shell.fab, "the floating button is there").toBe(1);
  expect(shell.gridVisible, "the grid is above the fold").toBeGreaterThanOrEqual(150);
  expect(shell.gridBottom, "the grid does not run past the screen").toBeLessThanOrEqual(shell.innerHeight + 0.5);
  expect(shell.sideways, "nothing scrolls sideways").toBeLessThanOrEqual(1);
});

test("F5 the calendar grid fits above the fold on a phone in portrait", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await enter(page, "f5-fold");
  await openCalendar(page);

  const grid = await settled(() =>
    page.evaluate(() => {
      const box = document.querySelector<HTMLElement>(".cal-scroll")!.getBoundingClientRect();
      return { top: Math.round(box.top * 10) / 10, height: Math.round(box.height * 10) / 10, visible: Math.round(Math.max(0, Math.min(box.height, window.innerHeight - box.top)) * 10) / 10, minHeight: getComputedStyle(document.querySelector(".cal-scroll")!).minHeight };
    }),
  );

  expect(grid.visible / grid.height, "most of the grid is above the fold").toBeGreaterThanOrEqual(0.8);
  expect(grid.visible, "at least 240 px of grid is readable without scrolling").toBeGreaterThanOrEqual(240);
});

test("F11 the tab bar keeps its 10 px gap to the floating button", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await enter(page, "f11-chrome");
  await openCalendar(page);

  const chrome = await settled(() =>
    page.evaluate(() => {
      const bar = document.querySelector<HTMLElement>(".tabbar")!.getBoundingClientRect();
      const fab = document.querySelector<HTMLElement>(".fab")!.getBoundingClientRect();
      return {
        gap: Math.round((fab.left - bar.right) * 10) / 10,
        barRight: Math.round(bar.right * 10) / 10,
        fabRight: Math.round(fab.right * 10) / 10,
        innerWidth: window.innerWidth,
      };
    }),
  );

  expect(chrome.gap, "the bar and the button are 10 px apart").toBeCloseTo(10, 1);
  expect(chrome.barRight, "the bar ends where the floating button begins").toBeLessThanOrEqual(chrome.innerWidth - 76 - 10 + 0.5);
  expect(chrome.fabRight, "the button keeps its 16 px inset").toBeLessThanOrEqual(chrome.innerWidth - 16 + 0.5);
});

/* ================== F6, F7, F12, F13: the last edges ================== */

test("F6 sign-in does not scroll sideways at 200 % text zoom", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByLabel("Email")).toBeVisible();
  await textZoom(page, 32);

  const gate = await settled(() =>
    page.evaluate(() => {
      const card = document.querySelector<HTMLElement>(".gate-card")!.getBoundingClientRect();
      return {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        cardLeft: Math.round(card.left * 10) / 10,
        cardRight: Math.round(card.right * 10) / 10,
      };
    }),
  );

  expect(gate.scrollWidth, "the page fits the viewport at 200 %").toBeLessThanOrEqual(gate.clientWidth + 1);
  expect(gate.cardLeft, "the card is not pushed off the left edge").toBeGreaterThanOrEqual(-0.5);
  expect(gate.cardRight, "and not off the right one").toBeLessThanOrEqual(gate.clientWidth + 0.5);
});

test("F7 a block label clips as whole lines, never mid-glyph, at 200 % zoom", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await enter(page, "f7-block-label");
  await openCalendar(page);
  await textZoom(page, 32);

  const label = await settled(() =>
    page.evaluate(() => {
      const block = [...document.querySelectorAll<HTMLElement>(".calendar-block")].find(
        element => (element.textContent ?? "").includes("Supercalifragilistic"),
      );
      const title = block?.querySelector<HTMLElement>("b") ?? null;
      const time = block?.querySelector<HTMLElement>("span") ?? null;
      const style = title ? getComputedStyle(title) : null;
      const timeStyle = time ? getComputedStyle(time) : null;
      return {
        found: Boolean(block),
        fontSize: style ? parseFloat(style.fontSize) : 0,
        lineHeight: style ? parseFloat(style.lineHeight) : 0,
        whiteSpace: style?.whiteSpace ?? null,
        timeOverflow: timeStyle?.overflow ?? null,
        timeEllipsis: timeStyle?.textOverflow ?? null,
      };
    }),
  );

  expect(label.found, "the 30 minute block is on the grid").toBe(true);
  expect(label.whiteSpace, "the title wraps instead of escaping the block").toBe("normal");
  expect(label.lineHeight / label.fontSize, "its lines are whole, so a clip lands between them").toBeGreaterThanOrEqual(1.1);
  expect(label.timeOverflow, "the time clips inside its own box").toBe("hidden");
  expect(label.timeEllipsis, "and says so with an ellipsis").toBe("ellipsis");
});

test("F12 no block hides under the tab bar once the grid is scrolled to its end", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await enter(page, "f12-scroll");
  await openCalendar(page);

  const overlap = await settled(() =>
    page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>(".cal-scroll")!;
      scroller.scrollTop = scroller.scrollHeight;
      const bar = document.querySelector<HTMLElement>(".tabbar")!.getBoundingClientRect();
      const hidden = [...document.querySelectorAll<HTMLElement>(".calendar-block")].filter(block => {
        const box = block.getBoundingClientRect();
        return box.bottom > bar.top && box.top < bar.bottom;
      }).length;
      return { hidden, scrollTop: scroller.scrollTop };
    }),
  );

  expect(overlap.scrollTop, "the grid really scrolled").toBeGreaterThan(0);
  expect(overlap.hidden, "the last blocks clear the tab bar").toBe(0);
});

test("F13 the account popover's email can be read in full", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const email = await enter(page, "f13-popover");
  await page.locator(".account-menu button").click();
  await expect(page.locator(".popover")).toBeVisible();

  const popover = await page.evaluate(() => {
    const element = document.querySelector<HTMLElement>(".popover-email")!;
    return { title: element.getAttribute("title"), text: element.textContent, truncated: element.scrollWidth - element.clientWidth > 2 };
  });

  expect(popover.truncated, "the address is longer than its box").toBe(true);
  expect(popover.title, "the full address is on the element").toBe(email);
});
