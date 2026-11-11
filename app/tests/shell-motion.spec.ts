import { expect, test, type Page } from "@playwright/test";
import { password } from "./browser-helpers.ts";

/**
 * The shell's own motion: the page
 * switch, the phone's tab pill, the account popover and the creation sheet's
 * fallback flight. Every assertion samples the real frames the browser paints,
 * because the reviewed properties (what moves, how far, for how long) are not
 * visible in a single computed style read.
 */

test.setTimeout(60_000);

const newEmail = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;

async function signUp(page: Page, email: string) {
  await page.goto("/");
  await expect(page.getByLabel("Email")).toBeVisible();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();
}

/** One painted frame of the view wrapper. */
type PageFrame = { t: number; opacity: number; transform: string; old: boolean; view: string | null };

/**
 * Clicks a view in the nav and samples the view wrapper on every frame after
 * it. The old view is detected by the section it labels, not by its text, so a
 * renamed heading never silently turns the check off.
 */
function samplePageSwitch(page: Page, destination: "Tasks" | "Today", ms: number) {
  return page.evaluate(
    async ({ destination, ms }) => {
      const frames: PageFrame[] = [];
      const button = [...document.querySelectorAll<HTMLButtonElement>("nav button")].find(node =>
        node.textContent?.includes(destination),
      );
      if (!button) throw new Error(`no nav button for ${destination}`);
      const start = performance.now();
      button.click();
      while (performance.now() - start < ms) {
        await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
        const wrapper = document.querySelector<HTMLElement>(".content > div");
        frames.push({
          t: performance.now() - start,
          opacity: wrapper ? Number(getComputedStyle(wrapper).opacity) : 1,
          transform: wrapper ? getComputedStyle(wrapper).transform : "none",
          old: document.querySelector('section[aria-labelledby="home-heading"]') !== null,
          view: wrapper?.querySelector("section")?.getAttribute("aria-labelledby") ?? null,
        });
      }
      return frames;
    },
    { destination, ms },
  );
}

test("a view change fades the new page in on opacity alone, and the old page is already gone", async ({ page }) => {
  await signUp(page, newEmail("page-fade"));
  await expect(page.locator('section[aria-labelledby="home-heading"]')).toBeVisible();

  const frames = await samplePageSwitch(page, "Tasks", 450);

  /* Nothing translates: the 6 px rise is gone, so the page never moves while
     the user is aiming at it. */
  expect(frames.every(frame => frame.transform === "none")).toBe(true);

  /* It does fade, and it is fully legible inside one 120 ms beat. 250 ms is the
     budget the old two-phase switch (80 ms exit, then a 200 ms fade, held behind
     mode="wait") already blew through. */
  const firstFaded = frames.findIndex(frame => frame.opacity < 1);
  expect(firstFaded).toBeGreaterThanOrEqual(0);
  const settled = frames.findIndex((frame, index) => index > firstFaded && frame.opacity === 1);
  expect(settled).toBeGreaterThan(firstFaded);
  expect(frames[settled].t).toBeLessThanOrEqual(250);

  /* The old view never fades out underneath the new one: it is gone on every
     frame where the incoming page is still coming up. */
  expect(frames.filter(frame => frame.opacity < 1 && frame.old)).toEqual([]);
  expect(frames[frames.length - 1].view).toBe("tasks-heading");
});

test("with reduced motion a view change still lands, still without moving", async ({ page }) => {
  // The preference is set before the app boots, like an OS setting would be.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signUp(page, newEmail("page-fade-reduce"));

  const frames = await samplePageSwitch(page, "Tasks", 450);

  expect(frames.every(frame => frame.transform === "none")).toBe(true);
  expect(frames[frames.length - 1].opacity).toBe(1);
  expect(frames[frames.length - 1].view).toBe("tasks-heading");
});

test("the phone's tab pill travels on a pure translation, inside the snappy spring", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signUp(page, newEmail("tab-pill"));
  const tabbar = page.getByRole("navigation", { name: "Main" });
  await expect(tabbar.getByRole("button", { name: "Tasks" })).toBeVisible();

  const frames = await page.evaluate(async () => {
    const samples: Array<{ t: number; transform: string }> = [];
    const button = [...document.querySelectorAll<HTMLButtonElement>(".tabbar .tab")].find(
      node => node.textContent?.trim() === "Tasks",
    );
    if (!button) throw new Error("no Tasks tab");
    const start = performance.now();
    button.click();
    while (performance.now() - start < 600) {
      await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
      const pill = document.querySelector<HTMLElement>(".tab-pill");
      samples.push({ t: performance.now() - start, transform: pill ? getComputedStyle(pill).transform : "none" });
    }
    return samples;
  });

  // it travels ...
  const moving = frames.filter(frame => frame.transform !== "none");
  expect(moving.length).toBeGreaterThan(0);
  // ... without the vertical squash (scaleY 0.9) that made a 22 px glyph wobble.
  // The horizontal scale a layout animation uses to bridge two tab widths is
  // Motion's own projection, not the removed `animate` overshoot: only the
  // vertical axis is free to be flat, so that is what is pinned here.
  for (const frame of moving) {
    const match = frame.transform.match(/^matrix\(([^)]+)\)$/);
    expect(match).not.toBeNull();
    const [a, b, c, d] = match![1].split(",").map(Number);
    expect([a, b, c, d].every(Number.isFinite)).toBe(true);
    expect(b).toBe(0);
    expect(c).toBe(0);
    expect(d).toBe(1);
  }
  // ... and it settles inside spring.snappy's 250 ms, not the old 400 ms smooth
  // spring, so the phone matches the desktop nav pill
  expect(moving[moving.length - 1].t).toBeLessThanOrEqual(350);
});

test("the account popover fades and scales instead of blurring the glass under it", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signUp(page, newEmail("popover-motion"));

  const frames = await page.evaluate(async () => {
    const samples: Array<{ filter: string; transform: string }> = [];
    const trigger = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      node => node.getAttribute("aria-label") === "Account",
    );
    if (!trigger) throw new Error("no account trigger");
    trigger.click();
    for (let frame = 0; frame < 40; frame += 1) {
      await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
      const popover = document.querySelector<HTMLElement>(".popover");
      if (!popover) continue;
      const style = getComputedStyle(popover);
      samples.push({ filter: style.filter, transform: style.transform });
    }
    return samples;
  });

  expect(frames.length).toBeGreaterThan(4);
  // no filter at any point: a blur on a backdrop-filter surface makes the glass
  // behind it repaint flat, which is exactly the material it sits on
  expect(frames.every(frame => frame.filter === "none")).toBe(true);
  // it still scales up from its trigger, which is the part that carries origin
  expect(frames.some(frame => frame.transform !== "none")).toBe(true);
  await expect(page.locator(".popover")).toBeVisible();
});

/** What the browser reports for the animations a plain `element.animate()` left
 * on an element. Motion's own animations never appear here: they are written by
 * script, frame by frame, and prove nothing about the compositor. */
type Flight = { kind: string; duration: number; properties: string[]; transforms: string[]; filter: string };

/**
 * Reads the sheet's native flight for one end of its fallback path, opening or
 * cancelling from inside the page so the read can never miss the animation.
 */
function readSheetFlight(page: Page, action: "open" | "close") {
  return page.evaluate(async (action: "open" | "close") => {
    const describe = (element: HTMLElement) => {
      const ignored = new Set(["offset", "computedOffset", "easing", "composite"]);
      return element.getAnimations().map(animation => {
        const effect = animation.effect as KeyframeEffect;
        const frames = effect.getKeyframes();
        return {
          kind: animation.constructor.name,
          duration: Number(effect.getTiming().duration ?? 0),
          properties: [...new Set(frames.flatMap(frame => Object.keys(frame).filter(key => !ignored.has(key))))].sort(),
          transforms: frames.map(frame => String((frame as Keyframe).transform ?? "")),
          filter: getComputedStyle(element).filter,
        };
      });
    };
    if (action === "open") {
      const trigger = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        node => node.textContent?.trim() === "New task",
      );
      if (!trigger) throw new Error("no New task trigger");
      trigger.click();
    } else {
      const sheet = document.querySelector<HTMLElement>(".sheet");
      if (!sheet) throw new Error("no sheet to close");
      const cancel = [...sheet.querySelectorAll<HTMLButtonElement>("button")].find(
        node => node.getAttribute("aria-label") === "Cancel",
      );
      if (!cancel) throw new Error("no Cancel control");
      cancel.click();
    }
    for (let frame = 0; frame < 60; frame += 1) {
      await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
      const sheet = document.querySelector<HTMLElement>(".sheet");
      if (!sheet) continue;
      const flights = describe(sheet);
      if (flights.length > 0) return flights;
    }
    return [];
  }, action) as Promise<Flight[]>;
}

test("the creation sheet's flight is one composited transform without blur, and leaves no layer", async ({ page }) => {
  await signUp(page, newEmail("sheet-flight"));

  const entry = await readSheetFlight(page, "open");
  const sheet = page.getByRole("complementary", { name: "New task" });
  await expect(sheet).toBeVisible();

  // One native animation, on transform and opacity only. Both frames carry the
  // whole geometry as a single string: no x/y/scaleX/scaleY shorthand, and no
  // filter, because a blur here turns the sheet's own glass into a flat repaint.
  expect(entry).toHaveLength(1);
  expect(entry[0].kind).toBe("Animation");
  expect(entry[0].properties).toEqual(["opacity", "transform"]);
  expect(entry[0].duration).toBe(400);
  expect(entry[0].transforms).toHaveLength(2);
  for (const transform of entry[0].transforms) {
    expect(transform).toMatch(/^translate\(-?[\d.]+px, -?[\d.]+px\) scale\([\d.]+, [\d.]+\)$/);
  }
  expect(entry[0].transforms[1]).toBe("translate(0px, 0px) scale(1, 1)");
  expect(entry[0].filter).toBe("none");

  // The flight is not filled, so the panel lands with no inline transform: no
  // lingering composited layer over the text the sheet just focused.
  await expect
    .poll(async () => sheet.evaluate(element => element.getAnimations().length))
    .toBe(0);
  expect(await sheet.evaluate(element => (element as HTMLElement).style.transform)).toBe("");
  expect(await sheet.evaluate(element => getComputedStyle(element).filter)).toBe("none");

  // The dismissal is the same mechanics, one keyframe long and 180 ms: WAAPI
  // reads the start from what the sheet is showing, so an interrupted entry
  // never snaps back to rest first.
  const exit = await readSheetFlight(page, "close");
  expect(exit).toHaveLength(1);
  expect(exit[0].kind).toBe("Animation");
  expect(exit[0].properties).toEqual(["opacity", "transform"]);
  expect(exit[0].duration).toBe(180);
  expect(exit[0].transforms).toHaveLength(1);
  expect(exit[0].transforms[0]).toMatch(/^translate\(-?[\d.]+px, -?[\d.]+px\) scale\([\d.]+, [\d.]+\)$/);
  expect(exit[0].filter).toBe("none");

  await expect(sheet).toHaveCount(0);
});

test("with reduced motion the creation sheet still fades in, without a flight", async ({ page }) => {
  // Before boot: Motion reads the preference once per mount, so an OS setting
  // that was already in force is the deterministic path to test.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signUp(page, newEmail("sheet-flight-reduce"));

  const flights = await readSheetFlight(page, "open");
  const sheet = page.getByRole("complementary", { name: "New task" });
  await expect(sheet).toBeVisible();

  // Reduced motion keeps a gentler entrance (an opacity fade, no movement) and
  // never starts the FLIP: one opacity-only animation, no transform, no filter.
  expect(flights).toHaveLength(1);
  expect(flights[0].properties, JSON.stringify(flights)).toEqual(["opacity"]);
  expect(flights[0].transforms.every(transform => transform === "")).toBe(true);
  expect(flights[0].filter).toBe("none");
  await expect
    .poll(async () => sheet.evaluate(element => Number(getComputedStyle(element).opacity)))
    .toBe(1);
  expect(await sheet.evaluate(element => getComputedStyle(element).filter)).toBe("none");
});
