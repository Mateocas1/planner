/**
 * The chat's function tools (Ronda 3 R1, spec S1): what the model may
 * propose, the pure validation of its raw JSON arguments, and the plain-words
 * description each action card shows. Nothing here writes anything — the
 * confirmation flow in the panel calls the app's existing data functions only
 * after the user confirms, and every write re-validated by `data/**` throws
 * before reaching Firestore.
 *
 * `move_task` maps onto what the UI's own surfaces do when they move work:
 * a target day is the task's deadline (`setTaskDeadline`), `null` clears it
 * (unschedule), and an optional start time — the app's primitive for placing
 * a task at a time is a work block linked to the task — creates that block
 * for the estimate's duration (60 min without one), next to the deadline.
 */

import { ASSUMED_ESTIMATE_MINUTES } from "../domain/model.ts";
import { formatDateKey } from "../ui/format.ts";
import type { ChatToolCall, ChatToolSpec } from "./types.ts";

/** At most 5 tool calls per answer; extras are dropped with a note (S1). */
export const MAX_TOOL_CALLS_PER_ANSWER = 5;

/** At most this many characters in a proposed task title (S1): the model
 * sometimes echoes a whole page back as the title. */
export const MAX_TOOL_TITLE_CHARS = 200;

const CREATE_TASK: ChatToolSpec = {
  type: "function",
  function: {
    name: "create_task",
    description:
      "Create a task in the user's planner. The user must confirm before anything is created.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "The task's title, in the user's own words." },
        day: {
          type: "string",
          description: "Optional due day as YYYY-MM-DD (the planner's timezone). Omit for no date.",
        },
        estimateMinutes: {
          type: "integer",
          description: "Optional estimate in whole minutes (1–1440).",
        },
      },
      required: ["title"],
    },
  },
};

const MOVE_TASK: ChatToolSpec = {
  type: "function",
  function: {
    name: "move_task",
    description:
      "Move a task to another day, unschedule it, or place it at a start time. The user must confirm before anything changes.",
    parameters: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "The task's id, exactly as it appears in the planner context.",
        },
        day: {
          type: ["string", "null"],
          description:
            "The target day as YYYY-MM-DD, or null to unschedule the task (clear its date).",
        },
        startTime: {
          type: "string",
          description:
            "Optional wall-clock HH:MM (24 h) to also place the task on that day's schedule; needs a day.",
        },
      },
      required: ["taskId", "day"],
    },
  },
};

/** The tools every chat request carries (extraction requests carry none). */
export const CHAT_TOOLS: ChatToolSpec[] = [CREATE_TASK, MOVE_TASK];

/** The planner data validation and descriptions read: the context's tasks. */
export type ChatToolContext = {
  tasks: ReadonlyArray<{ id: string; title: string; deadline?: string; estimateMinutes?: number }>;
  timeZone: string;
  /** The profile zone's today (`YYYY-MM-DD`), for "today" wording. */
  todayKey: string;
};

export type ToolCheck<T> = { ok: true; value: T; description: string } | { ok: false; error: string };

export type NormalizedCreateTask = {
  title: string;
  day?: string;
  estimateMinutes?: number;
};

export type NormalizedMoveTask = {
  taskId: string;
  title: string;
  /** Target day key, or `null` = unschedule. */
  day: string | null;
  /** Minutes since midnight when a start time was given. */
  startMinutes?: number;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;
const ESTIMATE_MAX_MINUTES = 1440;

/** A `YYYY-MM-DD` string that names a real calendar day. */
export function isValidDayKey(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const stamp = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(stamp)) return false;
  return new Date(stamp).toISOString().slice(0, 10) === value;
}

function parseArguments(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { ok: false, error: "The proposal was not a JSON object." };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, error: "The proposal was not valid JSON." };
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Validates a raw `day` argument.
 * `optional` (create_task): absent, null or empty all mean "no date".
 * `requiredOrNull` (move_task): null means unschedule; absence is an error
 * (the schema requires the field so the model states its intent). */
function checkDay(value: unknown, mode: "optional" | "requiredOrNull"): { day?: string; unschedule: boolean } | { error: string } {
  if (value === undefined || value === null || value === "") {
    if (mode === "optional" || value === null) return { unschedule: true };
    return { error: "The proposal needs a day (or null to unschedule)." };
  }
  if (typeof value !== "string" || !isValidDayKey(value.trim())) {
    return { error: `"${String(value)}" is not a valid day (YYYY-MM-DD).` };
  }
  return { day: value.trim(), unschedule: false };
}

/** Validates `estimateMinutes`: absent, null, or a whole minute count in range. */
function checkEstimate(value: unknown): { estimateMinutes?: number } | { error: string } {
  if (value === undefined || value === null) return {};
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > ESTIMATE_MAX_MINUTES) {
    return { error: "The estimate must be a whole minute count between 1 and 1440." };
  }
  return { estimateMinutes: value as number };
}

/** Validates `create_task` arguments (spec S1: empty title, bad date).
 * `todayKey` only feeds the description's "today"/"tomorrow" wording. */
export function checkCreateTask(raw: string, todayKey = ""): ToolCheck<NormalizedCreateTask> {
  const parsed = parseArguments(raw);
  if (!parsed.ok) return parsed;
  const title = optionalString(parsed.value.title);
  if (title === undefined) return { ok: false, error: "The task needs a title." };
  if (title.length > MAX_TOOL_TITLE_CHARS) return { ok: false, error: TITLE_TOO_LONG };
  const day = checkDay(parsed.value.day, "optional");
  if ("error" in day) return { ok: false, error: day.error };
  const estimate = checkEstimate(parsed.value.estimateMinutes);
  if ("error" in estimate) return { ok: false, error: estimate.error };
  const value: NormalizedCreateTask = {
    title,
    ...(day.day === undefined ? {} : { day: day.day }),
    ...estimate,
  };
  return { ok: true, value, description: describeCreateTask(value, todayKey) };
}

const TITLE_TOO_LONG = `The title is too long (at most ${MAX_TOOL_TITLE_CHARS} characters).`;

function describeCreateTask(value: NormalizedCreateTask, todayKey: string): string {
  const parts = [`Create task "${value.title}"`];
  if (value.day !== undefined) parts.push(formatDateKey(value.day, todayKey));
  if (value.estimateMinutes !== undefined) parts.push(`${value.estimateMinutes} min`);
  return parts.join(" · ");
}

function describeMoveTask(value: NormalizedMoveTask, task: ChatToolContext["tasks"][number], context: ChatToolContext): string {
  const label = (day: string | undefined | null) =>
    day === undefined || day === null ? "No date" : formatDateKey(day, context.todayKey);
  const parts = [`Move "${task.title}"`, `${label(task.deadline)} → ${value.day === null ? "No date" : label(value.day)}`];
  if (value.startMinutes !== undefined) {
    const hour = Math.floor(value.startMinutes / 60);
    const minute = value.startMinutes % 60;
    parts.push(`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
  }
  return parts.join(" · ");
}

/** Validates `move_task` arguments against the planner context (S1: unknown
 * id, bad date). An unknown id or a malformed proposal never writes. Every
 * check — including the midnight room check for a start time — runs here,
 * so a rejected proposal fails the card before any data call happens. */
export function checkMoveTask(raw: string, context: ChatToolContext): ToolCheck<NormalizedMoveTask> {
  const parsed = parseArguments(raw);
  if (!parsed.ok) return parsed;
  const taskId = optionalString(parsed.value.taskId);
  if (taskId === undefined) return { ok: false, error: "The proposal needs a task id." };
  const task = context.tasks.find(entry => entry.id === taskId);
  if (task === undefined) return { ok: false, error: "That task id is not in your planner." };
  const hasStartTime = parsed.value.startTime !== undefined && parsed.value.startTime !== null;
  if (hasStartTime && (parsed.value.day === undefined || parsed.value.day === null || parsed.value.day === "")) {
    return { ok: false, error: "A start time needs a target day." };
  }
  const day = checkDay(parsed.value.day, "requiredOrNull");
  if ("error" in day) return { ok: false, error: day.error };
  let startMinutes: number | undefined;
  if (parsed.value.startTime !== undefined && parsed.value.startTime !== null) {
    if (typeof parsed.value.startTime !== "string") return { ok: false, error: "The start time must be HH:MM." };
    const match = TIME_RE.exec(parsed.value.startTime.trim());
    const hour = match === null ? -1 : Number(match[1]);
    const minute = match === null ? -1 : Number(match[2]);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      return { ok: false, error: `"${parsed.value.startTime}" is not a valid start time (HH:MM).` };
    }
    if (day.day === undefined) {
      return { ok: false, error: "A start time needs a target day." };
    }
    startMinutes = hour * 60 + minute;
    // The block this start time creates runs for the task's estimate (the
    // app's assumed 60 minutes without one) and must end before midnight —
    // checked here, before any write, exactly like the estimate bounds.
    const estimate = task.estimateMinutes ?? ASSUMED_ESTIMATE_MINUTES;
    if (startMinutes + estimate > 1440) {
      return { ok: false, error: "The start time leaves no room before midnight for this task's estimate." };
    }
  }
  const value: NormalizedMoveTask = {
    taskId,
    title: task.title,
    ...(day.day === undefined ? { day: null } : { day: day.day }),
    ...(startMinutes === undefined ? {} : { startMinutes }),
  };
  return { ok: true, value, description: describeMoveTask(value, task, context) };
}

/** Validates one proposed call; `ok` carries the plain-words description the
 * card shows. Unsupported tool names fail (never render as a write). */
export function validateToolCall(
  call: Pick<ChatToolCall, "name" | "arguments">,
  context: ChatToolContext,
): ToolCheck<NormalizedCreateTask | NormalizedMoveTask> {
  switch (call.name) {
    case "create_task":
      return checkCreateTask(call.arguments, context.todayKey);
    case "move_task":
      return checkMoveTask(call.arguments, context);
    default:
      return { ok: false, error: `Unknown action "${call.name}".` };
  }
}

/** The plain-words description of a still-pending proposal, or a neutral line
 * when the arguments do not parse (the card never invents a description from
 * unvalidated data). */
export function describeToolCall(call: Pick<ChatToolCall, "name" | "arguments">, context: ChatToolContext): string {
  const check = validateToolCall(call, context);
  return check.ok ? check.description : "The assistant proposed an action, but its details are not valid.";
}

/** The `tool` message content each card state sends back to the model, so the
 * OpenAI protocol stays valid (S1: one tool message per call). */
export function toolResultContent(card: { status: string; outcome?: string }): string {
  switch (card.status) {
    case "confirmed":
      return `The user confirmed and it was applied. ${card.outcome ?? ""}`.trim();
    case "failed":
      return `The user confirmed but it failed: ${card.outcome ?? "unknown error"}`;
    case "discarded":
      return "The user discarded this proposal. Nothing was changed.";
    default:
      return "The user has not answered this proposal yet; treat it as not done.";
  }
}
