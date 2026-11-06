/**
 * Settings copy that names the operating system (T10b, S6/S7): the Desktop tab
 * and the quick-add row said "Windows" on every platform. Each sentence picks
 * its variant from `copyFamily`, which reads the webview's platform; the
 * functions take the platform as an argument so the selection is testable.
 */

import { copyFamily, desktopPlatform, quickAddUnregisteredCause, type DesktopPlatform } from "../../desktop.ts";
import { t } from "../../i18n/index.ts";

/** The Desktop tab's first section title: "Windows", "Linux" or "This computer". */
export function systemSectionTitle(platform: DesktopPlatform = desktopPlatform()): string {
  return t(`desktop.system.title.${copyFamily(platform)}`);
}

/** The sign-in startup switch's label. */
export function startupLabel(platform: DesktopPlatform = desktopPlatform()): string {
  return t(`desktop.startup.label.${copyFamily(platform)}`);
}

/** The startup switch's error when the OS state could not be read. */
export function startupReadError(platform: DesktopPlatform = desktopPlatform()): string {
  return t(`desktop.error.startupRead.${copyFamily(platform)}`);
}

/** The startup switch's error when the OS refused the change. */
export function startupChangeError(platform: DesktopPlatform = desktopPlatform()): string {
  return t(`desktop.error.startupChange.${copyFamily(platform)}`);
}

/** The Notifications section's note. */
export function notificationsDescription(platform: DesktopPlatform = desktopPlatform()): string {
  return t(`desktop.notifications.description.${copyFamily(platform)}`);
}

/** The quick-add row's note in the Shortcuts tab. */
export function quickAddDescription(platform: DesktopPlatform = desktopPlatform()): string {
  return t(`shortcuts.quickAdd.description.${copyFamily(platform)}`);
}

/** The line under the quick-add chip when the chord is not registered: the
 * compositor's job under Wayland (or a failed Hyprland bind sync), a refusal
 * anywhere else. */
export function quickAddUnregisteredNote(error: string | null): string {
  switch (quickAddUnregisteredCause(error)) {
    case "compositor": return t("recorder.compositor");
    case "bindWrite": return t("recorder.bindWriteFailed");
    case "reload": return t("recorder.reloadFailed");
    default: return t("recorder.unavailable");
  }
}
