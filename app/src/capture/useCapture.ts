/**
 * The capture inbox's hook: a thin wrapper that wires the pure
 * `createCaptureController` to the app. Desktop uses the Tauri chat transport,
 * the stored key's status and the saved model; the web build has no transport,
 * so the on-device reading answers; dev `?captureMock=<scenario>` swaps in the
 * mock for browser tests. All the behavior lives in `captureMachine.ts`.
 */

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { getChatModel } from "../chat/config.ts";
import { getKeyStatus } from "../chat/keyStore.ts";
import { createTauriChatTransport } from "../chat/tauriTransport.ts";
import type { ChatTransport } from "../chat/types.ts";
import { isTauri } from "../desktop.ts";
import { CAPTURE_TIMEOUT_MS, createCaptureController, type CaptureController, type CaptureDeps, type CaptureState } from "./captureMachine.ts";
import { captureMockScenario, createCaptureMock } from "./captureMock.ts";

export type UseCaptureOptions = {
  /** The profile zone, so "today" is the planner's day. */
  timeZone: string;
};

export type Capture = {
  state: CaptureState;
  /** Reads a paste; never writes a task. */
  read: (text: string) => void;
  cancel: () => void;
  reset: () => void;
};

/** The transport and key lookup for this build: the dev mock, the desktop
 * shell, or none (web). */
function resolveSource(): Pick<CaptureDeps, "transport" | "hasKey"> {
  const dev = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV === true;
  const scenario = dev ? captureMockScenario(new URLSearchParams(window.location.search).get("captureMock")) : null;
  if (scenario !== null) return createCaptureMock(scenario);
  if (isTauri()) {
    const transport: ChatTransport = createTauriChatTransport();
    return { transport, hasKey: async () => (await getKeyStatus()).hasKey };
  }
  return { transport: null, hasKey: async () => false };
}

export function useCapture({ timeZone }: UseCaptureOptions): Capture {
  const zoneRef = useRef(timeZone);
  zoneRef.current = timeZone;

  const controller = useMemo<CaptureController>(
    () =>
      createCaptureController({
        ...resolveSource(),
        isOnline: () => navigator.onLine,
        now: () => new Date(),
        timeZone: () => zoneRef.current,
        model: getChatModel,
        timeoutMs: CAPTURE_TIMEOUT_MS,
      }),
    [],
  );

  // A sheet that unmounts mid-read stops the call.
  useEffect(() => () => controller.reset(), [controller]);

  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  return useMemo(() => ({ state, read: controller.start, cancel: controller.cancel, reset: controller.reset }), [state, controller]);
}
