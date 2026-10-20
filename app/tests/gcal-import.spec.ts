import { expect, test } from "@playwright/test";
import { createRemoteAccount, submitAuthForm } from "./browser-helpers.ts";

/**
 * A block that came from Google Calendar shows the event's title where a plain
 * block shows "Work block" (value roadmap §1, import 4a).
 *
 * This is the only end-to-end proof that the new optional fields survive the
 * whole read path -- seeded document, store, grid -- because the title cannot
 * be produced from the UI: nothing in the app creates a titled block yet (the
 * import surface is 4b). Seeding uses the emulators' REST endpoints directly,
 * the way browser-helpers does, so the document is a real server read and not
 * a client cache.
 */

const AUTH_EMULATOR = "http://127.0.0.1:9199/identitytoolkit.googleapis.com/v1/projects/demo-calendar-app";
const FIRESTORE_REST = "http://127.0.0.1:8187/v1/projects/demo-calendar-app/databases/(default)/documents";

test.setTimeout(90_000);

function newEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
}

async function remoteUid(email: string): Promise<string> {
  const response = await fetch(`${AUTH_EMULATOR}/accounts:lookup?key=local-only`, {
    method: "POST",
    headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({ email: [email] }),
  });
  if (!response.ok) throw new Error(`emulator accounts:lookup failed: ${response.status} ${await response.text()}`);
  const body = (await response.json()) as { users?: Array<{ localId?: string }> };
  const uid = body.users?.[0]?.localId;
  if (!uid) throw new Error(`no Auth emulator account found for ${email}`);
  return uid;
}

/** Seeds the profile zone and one titled block, and returns that block's id. */
async function seedTitledBlock(email: string, timeZone: string, start: string, end: string, title: string): Promise<string> {
  await createRemoteAccount(email);
  const uid = await remoteUid(email);
  const profile = await fetch(`${FIRESTORE_REST}/users/${uid}/profile/main`, {
    method: "PATCH",
    headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { timeZone: { stringValue: timeZone } } }),
  });
  if (!profile.ok) throw new Error(`emulator profile set failed: ${profile.status} ${await profile.text()}`);
  const block = await fetch(`${FIRESTORE_REST}/users/${uid}/blocks`, {
    method: "POST",
    headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({
      fields: {
        start: { stringValue: start },
        end: { stringValue: end },
        title: { stringValue: title },
        source: {
          mapValue: {
            fields: {
              provider: { stringValue: "gcal" },
              calendarId: { stringValue: "primary" },
              eventId: { stringValue: "evt-title-test" },
              updated: { stringValue: "2026-10-18T10:00:00.000Z" },
            },
          },
        },
      },
    }),
  });
  if (!block.ok) throw new Error(`emulator block add failed: ${block.status} ${await block.text()}`);
  const created = (await block.json()) as { name: string };
  return created.name.split("/").pop()!;
}

test("an imported block shows its event title instead of Work block", async ({ page }) => {
  const email = newEmail("gcal-title");
  const today = new Date().toISOString().slice(0, 10);
  const blockId = await seedTitledBlock(email, "UTC", `${today}T09:00:00+00:00`, `${today}T10:00:00+00:00`, "Design review");

  await submitAuthForm(page, email, "sign in");
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Calendar" }).click();

  const block = page.locator(`[data-block="${blockId}"]`);
  await expect(block).toBeVisible();
  await expect(block).toContainText("Design review");
  // The accessible name is what a screen reader announces for the block.
  await expect(block).toHaveAccessibleName(/Design review/);
  await expect(block).not.toContainText("Work block");
});
