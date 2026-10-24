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
import { dateKey, timeLabel } from "../ui/time.ts";
import type { Memory } from "./memoryStore.ts";
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
      "Create a task in the user's planner, optionally due on a day and optionally placed on that day's schedule at a start time. The user must confirm before anything is created.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "The task's title, in the user's own words." },
        day: {
          type: "string",
          description: "Optional due day as YYYY-MM-DD (the planner's timezone). Omit for no date.",
        },
        startTime: {
          type: "string",
          description:
            "Optional wall-clock HH:MM (24 h) to place the task on that day's schedule; needs a day. The block runs for the estimate (60 min without one).",
        },
        estimateMinutes: {
          type: "integer",
          description: "Optional estimate (duration) in whole minutes (1–1440).",
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
const LIST_TASKS: ChatToolSpec = {
  type: "function",
  function: {
    name: "list_tasks",
    description:
      "Read tasks from the user's planner without asking. Filter by due-day range and/or a title text; task ids come back so you can reference them in other tools.",
    parameters: {
      type: "object",
      properties: {
        fromDay: { type: "string", description: "Optional first due day, YYYY-MM-DD (inclusive)." },
        toDay: { type: "string", description: "Optional last due day, YYYY-MM-DD (inclusive)." },
        query: { type: "string", description: "Optional case-insensitive text the title must contain." },
        includeCompleted: { type: "boolean", description: "Include completed tasks (default false)." },
      },
      required: [],
    },
  },
};

const GET_TASK: ChatToolSpec = {
  type: "function",
  function: {
    name: "get_task",
    description: "Read one task by id, including its scheduled blocks, without asking.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "The task's id, exactly as it appears in the context or in a tool result." },
      },
      required: ["taskId"],
    },
  },
};

const LIST_HOLIDAYS: ChatToolSpec = {
  type: "function",
  function: {
    name: "list_holidays",
    description: "Read the user's holiday labels (id, date, title, kind, hidden) without asking.",
    parameters: { type: "object", properties: {}, required: [] },
  },
};

const LIST_MEMORIES: ChatToolSpec = {
  type: "function",
  function: {
    name: "list_memories",
    description: "Read the notes you keep about the user (topicKey, title, content) without asking.",
    parameters: { type: "object", properties: {}, required: [] },
  },
};

const UPDATE_TASK: ChatToolSpec = {
  type: "function",
  function: {
    name: "update_task",
    description:
      "Change a task's fields: rename it, set or clear its due day (day: null unschedules it), set or clear its estimate, or place it on a day's schedule at a start time. Omitted fields stay as they are. The user must confirm before anything changes.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "The task's id, exactly as it appears in the context or in a tool result." },
        title: { type: "string", description: "Optional new title." },
        day: {
          type: ["string", "null"],
          description:
            "New due day as YYYY-MM-DD, or null to unschedule (clear the due day and remove its upcoming placements). Omit to leave the day alone.",
        },
        estimateMinutes: {
          type: ["integer", "null"],
          description: "New estimate in whole minutes (1–1440), or null to clear it. Omit to leave it alone.",
        },
        startTime: {
          type: "string",
          description:
            "Optional wall-clock HH:MM (24 h) to place the task at on a day: the given day, or the task's current due day. Replaces that day's existing placement for the task.",
        },
      },
      required: ["taskId"],
    },
  },
};

const COMPLETE_TASK: ChatToolSpec = {
  type: "function",
  function: {
    name: "complete_task",
    description: "Mark a task completed, or reopen a completed one. The user must confirm before anything changes.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "The task's id, exactly as it appears in the context or in a tool result." },
        completed: { type: "boolean", description: "true to complete, false to reopen." },
      },
      required: ["taskId", "completed"],
    },
  },
};

const DELETE_TASK: ChatToolSpec = {
  type: "function",
  function: {
    name: "delete_task",
    description:
      "Permanently delete one task. Say what it was and, when the user seems to mean several tasks, confirm the list with them first. The user must confirm before anything is deleted.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "The task's id, exactly as it appears in the context or in a tool result." },
      },
      required: ["taskId"],
    },
  },
};

const HIDE_HOLIDAY: ChatToolSpec = {
  type: "function",
  function: {
    name: "hide_holiday",
    description:
      "Hide a holiday label from the calendar, or show it again — exactly what the app's Holidays sheet does. The user must confirm before anything changes.",
    parameters: {
      type: "object",
      properties: {
        holidayId: { type: "string", description: "The holiday's id, exactly as it appears in the context or in a list_holidays result." },
        show: { type: "boolean", description: "true shows it again; false (default) hides it." },
      },
      required: ["holidayId"],
    },
  },
};

const REMEMBER: ChatToolSpec = {
  type: "function",
  function: {
    name: "remember",
    description:
      "Save a durable note about the user into your memory (it rides along in every future chat). For durable facts only — preferences, habits, context — never secrets or anything sensitive. The user must confirm before anything is saved.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title for the note." },
        content: { type: "string", description: "One or two sentences of what to remember." },
        topicKey: {
          type: "string",
          description: "Optional stable key; giving an existing note's key updates that note in place instead of adding a new one.",
        },
      },
      required: ["title", "content"],
    },
  },
};

const FORGET: ChatToolSpec = {
  type: "function",
  function: {
    name: "forget",
    description: "Remove one of your notes about the user, by its topic key. The user must confirm before anything is removed.",
    parameters: {
      type: "object",
      properties: {
        topicKey: { type: "string", description: "The note's topic key, exactly as it appears in the notes block or a list_memories result." },
      },
      required: ["topicKey"],
    },
  },
};

/** The tools every chat request carries (extraction requests carry none).
 * Reads run without confirmation (S4); writes render confirmation cards. */
export const CHAT_TOOLS: ChatToolSpec[] = [
  CREATE_TASK,
  MOVE_TASK,
  UPDATE_TASK,
  COMPLETE_TASK,
  DELETE_TASK,
  HIDE_HOLIDAY,
  REMEMBER,
  FORGET,
  LIST_TASKS,
  GET_TASK,
  LIST_HOLIDAYS,
  LIST_MEMORIES,
];

const READ_TOOL_NAMES: ReadonlySet<string> = new Set(["list_tasks", "get_task", "list_holidays", "list_memories"]);

/** Whether a tool name is a read: reads execute at once, never behind a
 * confirmation card. Unknown names are not reads. */
export function isReadTool(name: string): boolean {
  return READ_TOOL_NAMES.has(name);
}

/** The planner data validation and descriptions read: the context's tasks. */
export type ChatToolContext = {
  tasks: ReadonlyArray<{ id: string; title: string; deadline?: string; estimateMinutes?: number; completed?: boolean }>;
  /** Task-linked work blocks, so reads can report when a task is placed and
   * writes can describe what they replace or remove. Absent in a context
   * built without blocks (the panel's display-only fallback). */
  blocks?: ReadonlyArray<{ id: string; start: string; end: string; taskId?: string }>;
  /** Holiday labels (S4: the model may list and hide them like the Holidays
   * sheet does). */
  holidays?: ReadonlyArray<{ id: string; date: string; title: string; kind: string; hidden?: boolean }>;
  /** The notes the model may forget (topicKey → title), for descriptions. */
  memoryTopics?: ReadonlyArray<{ topicKey: string; title: string }>;
  timeZone: string;
  /** The profile zone's today (`YYYY-MM-DD`), for "today" wording. */
  todayKey: string;
};

export type ToolCheck<T> = { ok: true; value: T; description: string } | { ok: false; error: string };

export type NormalizedCreateTask = {
  title: string;
  day?: string;
  /** Minutes since midnight when a start time was given (needs a day). */
  startMinutes?: number;
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

/** Validates a raw `HH:MM` string into minutes since midnight, or an error.
 * Shared by every tool that can place work at a wall-clock time. */
function checkStartTime(value: unknown): { startMinutes: number } | { error: string } {
  if (typeof value !== "string") return { error: "The start time must be HH:MM." };
  const match = TIME_RE.exec(value.trim());
  const hour = match === null ? -1 : Number(match[1]);
  const minute = match === null ? -1 : Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return { error: `"${value}" is not a valid start time (HH:MM).` };
  }
  return { startMinutes: hour * 60 + minute };
}

/** Validates `create_task` arguments (spec S1: empty title, bad date; S4:
 * start time with midnight room). `todayKey` only feeds the description's
 * "today"/"tomorrow" wording. */
export function checkCreateTask(raw: string, todayKey = ""): ToolCheck<NormalizedCreateTask> {
  const parsed = parseArguments(raw);
  if (!parsed.ok) return parsed;
  const title = optionalString(parsed.value.title);
  if (title === undefined) return { ok: false, error: "The task needs a title." };
  if (title.length > MAX_TOOL_TITLE_CHARS) return { ok: false, error: TITLE_TOO_LONG };
  const day = checkDay(parsed.value.day, "optional");
  if ("error" in day) return { ok: false, error: day.error };
  let startMinutes: number | undefined;
  if (parsed.value.startTime !== undefined && parsed.value.startTime !== null) {
    if (day.day === undefined) return { ok: false, error: "A start time needs a day." };
    const time = checkStartTime(parsed.value.startTime);
    if ("error" in time) return { ok: false, error: time.error };
    startMinutes = time.startMinutes;
  }
  const estimate = checkEstimate(parsed.value.estimateMinutes);
  if ("error" in estimate) return { ok: false, error: estimate.error };
  // The block a start time creates runs for the estimate (the app's assumed
  // 60 minutes without one) and must end before midnight — checked here,
  // before any write, exactly like the estimate bounds.
  if (startMinutes !== undefined) {
    const estimateForRoom = estimate.estimateMinutes ?? ASSUMED_ESTIMATE_MINUTES;
    if (startMinutes + estimateForRoom > 1440) {
      return { ok: false, error: "The start time leaves no room before midnight for this task's duration." };
    }
  }
  const value: NormalizedCreateTask = {
    title,
    ...(day.day === undefined ? {} : { day: day.day }),
    ...(startMinutes === undefined ? {} : { startMinutes }),
    ...estimate,
  };
  return { ok: true, value, description: describeCreateTask(value, todayKey) };
}

const TITLE_TOO_LONG = `The title is too long (at most ${MAX_TOOL_TITLE_CHARS} characters).`;

function describeCreateTask(value: NormalizedCreateTask, todayKey: string): string {
  const parts = [`Create task "${value.title}"`];
  if (value.day !== undefined) parts.push(formatDateKey(value.day, todayKey));
  if (value.startMinutes !== undefined) parts.push(hhmm(value.startMinutes));
  if (value.estimateMinutes !== undefined) parts.push(`${value.estimateMinutes} min`);
  return parts.join(" · ");
}

function describeMoveTask(value: NormalizedMoveTask, task: ChatToolContext["tasks"][number], context: ChatToolContext): string {
  const label = (day: string | undefined | null) =>
    day === undefined || day === null ? "No date" : formatDateKey(day, context.todayKey);
  const parts = [`Move "${task.title}"`, `${label(task.deadline)} → ${value.day === null ? "No date" : label(value.day)}`];
  if (value.startMinutes !== undefined) parts.push(hhmm(value.startMinutes));
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

/* ---------- read tools (S4): run without confirmation, validate purely ---------- */

export type NormalizedListTasks = {
  fromDay?: string;
  toDay?: string;
  query?: string;
  includeCompleted: boolean;
};

export type NormalizedGetTask = { taskId: string };

export type NormalizedNoArgs = Record<string, never>;

const QUERY_MAX_CHARS = 120;
const LIST_RESULTS_CAP = 30;
const HOLIDAY_RESULTS_CAP = 40;

/** Validates `list_tasks` arguments: absent/null/empty filters are absent;
 * days must be real day keys in order; the query is a bounded string. */
export function checkListTasks(raw: string, context: ChatToolContext): ToolCheck<NormalizedListTasks> {
  const parsed = parseArguments(raw);
  if (!parsed.ok) return parsed;
  const value: NormalizedListTasks = { includeCompleted: parsed.value.includeCompleted === true };
  if (parsed.value.includeCompleted !== undefined && typeof parsed.value.includeCompleted !== "boolean") {
    return { ok: false, error: "includeCompleted must be true or false." };
  }
  for (const [key, target] of [["fromDay", "fromDay"], ["toDay", "toDay"]] as const) {
    const raw2 = parsed.value[key];
    if (raw2 === undefined || raw2 === null || raw2 === "") continue;
    if (typeof raw2 !== "string" || !isValidDayKey(raw2.trim())) {
      return { ok: false, error: `"${String(raw2)}" is not a valid day (YYYY-MM-DD).` };
    }
    value[target] = raw2.trim();
  }
  if (value.fromDay !== undefined && value.toDay !== undefined && value.fromDay > value.toDay) {
    return { ok: false, error: "fromDay must not be after toDay." };
  }
  const rawQuery = parsed.value.query;
  if (rawQuery !== undefined && rawQuery !== null && rawQuery !== "") {
    if (typeof rawQuery !== "string") return { ok: false, error: "The query must be text." };
    if (rawQuery.trim().length > QUERY_MAX_CHARS) {
      return { ok: false, error: `The query is too long (at most ${QUERY_MAX_CHARS} characters).` };
    }
    value.query = rawQuery.trim();
  }
  return { ok: true, value, description: describeListTasks(value, context) };
}

function describeListTasks(value: NormalizedListTasks, context: ChatToolContext): string {
  const parts = ["Look up tasks"];
  if (value.fromDay !== undefined || value.toDay !== undefined) {
    const from = value.fromDay === undefined ? "the beginning" : formatDateKey(value.fromDay, context.todayKey);
    const to = value.toDay === undefined ? "onwards" : formatDateKey(value.toDay, context.todayKey);
    parts.push(`due ${from} – ${to}`);
  }
  if (value.query !== undefined) parts.push(`matching "${value.query}"`);
  if (value.includeCompleted) parts.push("including completed");
  return parts.join(" · ");
}

/** Validates `get_task`: an id is required, and it must be one the context
 * knows — a read of an unknown id fails before anything runs. */
export function checkGetTask(raw: string, context: ChatToolContext): ToolCheck<NormalizedGetTask> {
  const parsed = parseArguments(raw);
  if (!parsed.ok) return parsed;
  const taskId = optionalString(parsed.value.taskId);
  if (taskId === undefined) return { ok: false, error: "The proposal needs a task id." };
  const task = context.tasks.find(entry => entry.id === taskId);
  if (task === undefined) return { ok: false, error: "That task id is not in your planner." };
  return { ok: true, value: { taskId }, description: `Look up task "${task.title}"` };
}

/** Validates the no-argument reads (`list_holidays`, `list_memories`): extra
 * arguments are tolerated (the schema keeps them out), nothing to reject. */
export function checkNoArgs(raw: string, description: string): ToolCheck<NormalizedNoArgs> {
  const parsed = parseArguments(raw);
  if (!parsed.ok) return parsed;
  return { ok: true, value: {}, description };
}

/** The read results are plain lines the model quotes back. */
export type ReadResult = { summary: string; result: string };

const emptyResult = (noun: string): ReadResult => ({ summary: `No ${noun} found.`, result: `No ${noun} found.` });

function taskLine(
  task: ChatToolContext["tasks"][number],
  blocks: ReadonlyArray<{ start: string; end: string; taskId?: string }>,
  context: ChatToolContext,
): string {
  const parts = [`[${task.id}] "${task.title}"`];
  parts.push(task.deadline === undefined ? "no due date" : `due ${formatDateKey(task.deadline, context.todayKey)}`);
  const linked = blocks.filter(block => block.taskId === task.id);
  if (linked.length > 0) {
    parts.push(
      linked
        .map(block => `${formatDateKey(dateKey(new Date(block.start), context.timeZone), context.todayKey)} ${timeLabel(new Date(block.start), context.timeZone)}–${timeLabel(new Date(block.end), context.timeZone)}`)
        .join(", "),
    );
  }
  if (task.estimateMinutes !== undefined) parts.push(`${task.estimateMinutes} min`);
  if (task.completed === true) parts.push("done");
  return `- ${parts.join(" · ")}`;
}

/** Builds the `list_tasks` result from the live context (pure; unit-tested). */
export function buildListTasksResult(value: NormalizedListTasks, context: ChatToolContext): ReadResult {
  const blocks = context.blocks ?? [];
  const query = value.query === undefined ? undefined : value.query.toLowerCase();
  const matches = context.tasks.filter(task => {
    if (value.includeCompleted !== true && task.completed === true) return false;
    if (query !== undefined && !task.title.toLowerCase().includes(query)) return false;
    if (value.fromDay === undefined && value.toDay === undefined) return true;
    const deadlineInRange =
      task.deadline !== undefined && (value.fromDay === undefined || task.deadline >= value.fromDay) && (value.toDay === undefined || task.deadline <= value.toDay);
    if (deadlineInRange) return true;
    // A task with no matching deadline still matches when one of its blocks
    // starts inside the range (the schedule placement, not just the due day).
    return blocks.some(block => {
      if (block.taskId !== task.id) return false;
      const blockDay = dateKey(new Date(block.start), context.timeZone);
      return (value.fromDay === undefined || blockDay >= value.fromDay) && (value.toDay === undefined || blockDay <= value.toDay);
    });
  });
  if (matches.length === 0) return emptyResult("matching tasks");
  const ordered = [...matches].sort((left, right) => {
    if (left.deadline !== right.deadline) return (left.deadline ?? "9999").localeCompare(right.deadline ?? "9999");
    return left.title.localeCompare(right.title);
  });
  const shown = ordered.slice(0, LIST_RESULTS_CAP);
  const more = ordered.length > shown.length ? `\n(+${ordered.length - shown.length} more)` : "";
  return {
    summary: `${ordered.length} ${ordered.length === 1 ? "task" : "tasks"} found.`,
    result: `${shown.map(task => taskLine(task, blocks, context)).join("\n")}${more}`,
  };
}

/** Builds the `get_task` result: the one task line, plus every block placed
 * for it (past placements included — the full truth about one task). */
export function buildGetTaskResult(taskId: string, context: ChatToolContext): ReadResult {
  const task = context.tasks.find(entry => entry.id === taskId);
  if (task === undefined) return { summary: "Task not found.", result: `Task id=${taskId} is not in the planner.` };
  const blocks = (context.blocks ?? []).filter(block => block.taskId === taskId);
  const line = taskLine(task, blocks, context);
  const extras = blocks.length > 0 ? "" : " · not placed on the schedule";
  return { summary: `"${task.title}"`, result: `${line}${extras}` };
}

/** Builds the `list_holidays` result (hidden ones flagged, never dropped —
 * the model needs their ids to show them again). */
export function buildListHolidaysResult(context: ChatToolContext): ReadResult {
  const holidays = context.holidays ?? [];
  if (holidays.length === 0) return emptyResult("holidays");
  const ordered = [...holidays].sort((left, right) => left.date.localeCompare(right.date) || left.title.localeCompare(right.title));
  const shown = ordered.slice(0, HOLIDAY_RESULTS_CAP);
  const more = ordered.length > shown.length ? `\n(+${ordered.length - shown.length} more)` : "";
  return {
    summary: `${ordered.length} ${ordered.length === 1 ? "holiday" : "holidays"} found.`,
    result: `${shown
      .map(holiday => `- [${holiday.id}] ${formatDateKey(holiday.date, context.todayKey)} · "${holiday.title}" · ${holiday.kind}${holiday.hidden === true ? " · hidden" : ""}`)
      .join("\n")}${more}`,
  };
}

/** Builds the `list_memories` result from the live notes store (pure; the
 * topicKeys are what `forget` removes by). */
export function buildListMemoriesResult(memories: ReadonlyArray<Memory>): ReadResult {
  if (memories.length === 0) return emptyResult("notes");
  const ordered = [...memories].sort((left, right) => right.updatedAt - left.updatedAt);
  const shown = ordered.slice(0, NOTES_RESULTS_CAP);
  const more = ordered.length > shown.length ? `\n(+${ordered.length - shown.length} more)` : "";
  return {
    summary: `${ordered.length} ${ordered.length === 1 ? "note" : "notes"} found.`,
    result: `${shown.map(memory => `- [${memory.topicKey}] ${memory.title} — ${memory.content}`).join("\n")}${more}`,
  };
}

const NOTES_RESULTS_CAP = 20;

/* ---------- write tools (S4): confirmed cards, pure validation ---------- */

export type NormalizedUpdateTask = {
  taskId: string;
  /** The task's title (for validation and descriptions). */
  title: string;
  newTitle?: string;
  day?: string;
  clearDay?: boolean;
  estimateMinutes?: number;
  clearEstimate?: boolean;
  /** Minutes since midnight; needs a resolvable day (`startDay`). */
  startMinutes?: number;
  /** The day the placement lands on: the given `day`, or the task's current
   * due day when the proposal names only a time ("put it at 14"). */
  startDay?: string;
};

/** Validates `update_task`: only real changes survive (a proposal that
 * changes nothing fails); a start time resolves its day from the proposal or
 * the task's current due day; every removal it implies is computed here so
 * the card can describe exactly what will happen. */
export function checkUpdateTask(raw: string, context: ChatToolContext): ToolCheck<NormalizedUpdateTask> {
  const parsed = parseArguments(raw);
  if (!parsed.ok) return parsed;
  const taskId = optionalString(parsed.value.taskId);
  if (taskId === undefined) return { ok: false, error: "The proposal needs a task id." };
  const task = context.tasks.find(entry => entry.id === taskId);
  if (task === undefined) return { ok: false, error: "That task id is not in your planner." };

  const value: NormalizedUpdateTask = { taskId, title: task.title };

  const rawTitle = parsed.value.title;
  if (rawTitle !== undefined && rawTitle !== null) {
    if (typeof rawTitle !== "string") return { ok: false, error: "The title must be text." };
    const title = rawTitle.trim();
    if (title === "") return { ok: false, error: "The title must not be empty." };
    if (title.length > MAX_TOOL_TITLE_CHARS) return { ok: false, error: TITLE_TOO_LONG };
    if (title !== task.title) value.newTitle = title;
  }

  const rawDay = parsed.value.day;
  if (rawDay === null) {
    if (task.deadline !== undefined) value.clearDay = true;
  } else if (rawDay !== undefined && rawDay !== "") {
    if (typeof rawDay !== "string" || !isValidDayKey(rawDay.trim())) {
      return { ok: false, error: `"${String(rawDay)}" is not a valid day (YYYY-MM-DD).` };
    }
    if (rawDay.trim() !== task.deadline) value.day = rawDay.trim();
  }

  const rawEstimate = parsed.value.estimateMinutes;
  if (rawEstimate === null) {
    if (task.estimateMinutes !== undefined) value.clearEstimate = true;
  } else if (rawEstimate !== undefined) {
    const estimate = checkEstimate(rawEstimate);
    if ("error" in estimate) return { ok: false, error: estimate.error };
    if (estimate.estimateMinutes !== task.estimateMinutes) value.estimateMinutes = estimate.estimateMinutes;
  }

  const rawStart = parsed.value.startTime;
  if (rawStart !== undefined && rawStart !== null) {
    if (rawDay === null) return { ok: false, error: "A start time cannot go with clearing the day." };
    const time = checkStartTime(rawStart);
    if ("error" in time) return { ok: false, error: time.error };
    const startDay = value.day ?? task.deadline;
    if (startDay === undefined) {
      return { ok: false, error: "A start time needs a day: pass one, or give the task a due day first." };
    }
    const estimateForRoom = value.estimateMinutes ?? (value.clearEstimate === true ? undefined : task.estimateMinutes) ?? ASSUMED_ESTIMATE_MINUTES;
    if (time.startMinutes + estimateForRoom > 1440) {
      return { ok: false, error: "The start time leaves no room before midnight for this task's duration." };
    }
    value.startMinutes = time.startMinutes;
    value.startDay = startDay;
  }

  if (value.newTitle === undefined && value.day === undefined && value.clearDay !== true && value.estimateMinutes === undefined && value.clearEstimate !== true && value.startMinutes === undefined) {
    return { ok: false, error: "The proposal changes nothing on this task." };
  }
  return { ok: true, value, description: describeUpdateTask(value, context) };
}

/** The task-linked blocks an update or unschedule would remove, computed
 * from the context so the card names them exactly. A placement replaces the
 * task's blocks on the target day; an unschedule (day: null) removes the
 * task's upcoming blocks (today onwards) and leaves past history alone. */
export function affectedBlockIds(
  taskId: string,
  change: { clearDay?: boolean; startDay?: string },
  context: ChatToolContext,
): Array<{ id: string; label: string }> {
  const blocks = context.blocks ?? [];
  if (change.clearDay === true) {
    return blocks
      .filter(block => block.taskId === taskId && dateKey(new Date(block.start), context.timeZone) >= context.todayKey)
      .map(block => ({ id: block.id, label: blockLabel(block, context) }));
  }
  if (change.startDay !== undefined) {
    return blocks
      .filter(block => block.taskId === taskId && dateKey(new Date(block.start), context.timeZone) === change.startDay)
      .map(block => ({ id: block.id, label: blockLabel(block, context) }));
  }
  return [];
}

function blockLabel(block: { start: string; end: string }, context: ChatToolContext): string {
  return `${formatDateKey(dateKey(new Date(block.start), context.timeZone), context.todayKey)} ${timeLabel(new Date(block.start), context.timeZone)}–${timeLabel(new Date(block.end), context.timeZone)}`;
}

function describeUpdateTask(value: NormalizedUpdateTask, context: ChatToolContext): string {
  const parts = [`Update "${value.title}"`];
  if (value.newTitle !== undefined) parts.push(`rename to "${value.newTitle}"`);
  if (value.clearDay === true) parts.push("clear the due day");
  else if (value.day !== undefined) parts.push(`due ${formatDateKey(value.day, context.todayKey)}`);
  if (value.clearEstimate === true) parts.push("clear the estimate");
  else if (value.estimateMinutes !== undefined) parts.push(`${value.estimateMinutes} min`);
  if (value.startMinutes !== undefined && value.startDay !== undefined) {
    const replaced = affectedBlockIds(value.taskId, { startDay: value.startDay }, context);
    const estimateForRoom = value.estimateMinutes ?? ASSUMED_ESTIMATE_MINUTES;
    parts.push(`place ${formatDateKey(value.startDay, context.todayKey)} ${hhmm(value.startMinutes)}–${hhmm(value.startMinutes + estimateForRoom)}${replaced.length > 0 ? ` (replaces ${replaced.map(entry => entry.label).join(", ")})` : ""}`);
  }
  if (value.clearDay === true) {
    const removed = affectedBlockIds(value.taskId, { clearDay: true }, context);
    if (removed.length > 0) parts.push(`removes its upcoming blocks: ${removed.map(entry => entry.label).join(", ")}`);
  }
  return parts.join(" · ");
}

/** Minutes since midnight as wall-clock HH:MM (descriptions only — pure
 * arithmetic, no zone involved). */
function hhmm(minutes: number): string {
  const clamped = Math.max(0, Math.min(24 * 60, minutes));
  return `${String(Math.floor(clamped / 60) % 24).padStart(2, "0")}:${String(clamped % 60).padStart(2, "0")}`;
}

export type NormalizedCompleteTask = { taskId: string; title: string; completed: boolean };

/** Validates `complete_task`: the task must exist and `completed` must be a
 * real boolean. */
export function checkCompleteTask(raw: string, context: ChatToolContext): ToolCheck<NormalizedCompleteTask> {
  const parsed = parseArguments(raw);
  if (!parsed.ok) return parsed;
  const taskId = optionalString(parsed.value.taskId);
  if (taskId === undefined) return { ok: false, error: "The proposal needs a task id." };
  const task = context.tasks.find(entry => entry.id === taskId);
  if (task === undefined) return { ok: false, error: "That task id is not in your planner." };
  if (typeof parsed.value.completed !== "boolean") {
    return { ok: false, error: "The proposal needs completed: true to complete, or false to reopen." };
  }
  const completed = parsed.value.completed;
  return {
    ok: true,
    value: { taskId, title: task.title, completed },
    description: completed ? `Complete "${task.title}"` : `Reopen "${task.title}"`,
  };
}

export type NormalizedDeleteTask = { taskId: string; title: string };

/** Validates `delete_task`: the task must exist, and the card names exactly
 * what will be removed — the task itself, and what stays behind. */
export function checkDeleteTask(raw: string, context: ChatToolContext): ToolCheck<NormalizedDeleteTask> {
  const parsed = parseArguments(raw);
  if (!parsed.ok) return parsed;
  const taskId = optionalString(parsed.value.taskId);
  if (taskId === undefined) return { ok: false, error: "The proposal needs a task id." };
  const task = context.tasks.find(entry => entry.id === taskId);
  if (task === undefined) return { ok: false, error: "That task id is not in your planner." };
  const parts = [`Delete task "${task.title}"`];
  if (task.deadline !== undefined) parts.push(`due ${formatDateKey(task.deadline, context.todayKey)}`);
  if (task.estimateMinutes !== undefined) parts.push(`${task.estimateMinutes} min`);
  const blocks = (context.blocks ?? []).filter(block => block.taskId === taskId);
  if (blocks.length > 0) {
    parts.push(`${blocks.length} ${blocks.length === 1 ? "block stays" : "blocks stay"} on the calendar`);
  }
  return { ok: true, value: { taskId, title: task.title }, description: parts.join(" · ") };
}

export type NormalizedHideHoliday = { holidayId: string; title: string; show: boolean };

export type NormalizedRemember = { title: string; content: string; topicKey?: string };

export type NormalizedForget = { topicKey: string };

const MEMORY_TOPIC_MAX = 120;
const MEMORY_TITLE_MAX = 200;
const MEMORY_CONTENT_MAX = 800;

/** The topic key a `remember` without one gets: a stable slug of the title
 * (same shape the Rust store accepts: at most 120 chars, not empty). */
export function deriveTopicKey(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MEMORY_TOPIC_MAX)
    .replace(/-+$/g, "");
  return slug === "" ? "note" : slug;
}

/** Validates `remember`: bounded title and content (the store's own caps), a
 * bounded topic key when given. Existence checks are the executor's job (it
 * sees the live notes). */
export function checkRemember(raw: string): ToolCheck<NormalizedRemember> {
  const parsed = parseArguments(raw);
  if (!parsed.ok) return parsed;
  const title = optionalString(parsed.value.title);
  if (title === undefined) return { ok: false, error: "The note needs a title." };
  if (title.length > MEMORY_TITLE_MAX) {
    return { ok: false, error: `The note title is too long (at most ${MEMORY_TITLE_MAX} characters).` };
  }
  const content = optionalString(parsed.value.content);
  if (content === undefined) return { ok: false, error: "The note needs content to remember." };
  if (content.length > MEMORY_CONTENT_MAX) {
    return { ok: false, error: `The note content is too long (at most ${MEMORY_CONTENT_MAX} characters).` };
  }
  const rawKey = parsed.value.topicKey;
  if (rawKey !== undefined && rawKey !== null) {
    if (typeof rawKey !== "string" || rawKey.trim() === "") return { ok: false, error: "The topic key must be non-empty text." };
    if (rawKey.trim().length > MEMORY_TOPIC_MAX) {
      return { ok: false, error: `The topic key is too long (at most ${MEMORY_TOPIC_MAX} characters).` };
    }
    const topicKey = rawKey.trim();
    return { ok: true, value: { title, content, topicKey }, description: `Remember "${title}" — ${content}` };
  }
  return { ok: true, value: { title, content }, description: `Remember "${title}" — ${content}` };
}

/** Validates `forget`: a bounded topic key; whether the note exists is
 * checked live at confirm time (the notes can change after the proposal). */
export function checkForget(raw: string, context: ChatToolContext): ToolCheck<NormalizedForget> {
  const parsed = parseArguments(raw);
  if (!parsed.ok) return parsed;
  const topicKey = optionalString(parsed.value.topicKey);
  if (topicKey === undefined) return { ok: false, error: "The proposal needs a topic key." };
  if (topicKey.length > MEMORY_TOPIC_MAX) {
    return { ok: false, error: `The topic key is too long (at most ${MEMORY_TOPIC_MAX} characters).` };
  }
  const known = (context.memoryTopics ?? []).find(entry => entry.topicKey === topicKey);
  const title = known?.title ?? topicKey;
  return { ok: true, value: { topicKey }, description: `Forget the note "${title}"` };
}

/** Validates `hide_holiday`: the holiday must be one the context knows, and
 * the requested visibility must actually change something. */
export function checkHideHoliday(raw: string, context: ChatToolContext): ToolCheck<NormalizedHideHoliday> {
  const parsed = parseArguments(raw);
  if (!parsed.ok) return parsed;
  const holidayId = optionalString(parsed.value.holidayId);
  if (holidayId === undefined) return { ok: false, error: "The proposal needs a holiday id." };
  const holiday = (context.holidays ?? []).find(entry => entry.id === holidayId);
  if (holiday === undefined) return { ok: false, error: "That holiday id is not in your planner." };
  if (parsed.value.show !== undefined && typeof parsed.value.show !== "boolean") {
    return { ok: false, error: "show must be true or false." };
  }
  const show = parsed.value.show === true;
  if (show && holiday.hidden !== true) {
    return { ok: false, error: `"${holiday.title}" is already visible.` };
  }
  if (!show && holiday.hidden === true) {
    return { ok: false, error: `"${holiday.title}" is already hidden.` };
  }
  const when = formatDateKey(holiday.date, context.todayKey);
  return {
    ok: true,
    value: { holidayId, title: holiday.title, show },
    description: show ? `Show holiday "${holiday.title}" · ${when} again` : `Hide holiday "${holiday.title}" · ${when}`,
  };
}

/** Validates one proposed call; `ok` carries the plain-words description the
 * card shows. Unsupported tool names fail (never render as a write). Reads
 * validate against the same pure rules the executor re-runs. */
export function validateToolCall(
  call: Pick<ChatToolCall, "name" | "arguments">,
  context: ChatToolContext,
): ToolCheck<
  | NormalizedCreateTask
  | NormalizedMoveTask
  | NormalizedUpdateTask
  | NormalizedCompleteTask
  | NormalizedDeleteTask
  | NormalizedHideHoliday
  | NormalizedRemember
  | NormalizedForget
  | NormalizedListTasks
  | NormalizedGetTask
  | NormalizedNoArgs
> {
  switch (call.name) {
    case "create_task":
      return checkCreateTask(call.arguments, context.todayKey);
    case "move_task":
      return checkMoveTask(call.arguments, context);
    case "update_task":
      return checkUpdateTask(call.arguments, context);
    case "complete_task":
      return checkCompleteTask(call.arguments, context);
    case "delete_task":
      return checkDeleteTask(call.arguments, context);
    case "hide_holiday":
      return checkHideHoliday(call.arguments, context);
    case "remember":
      return checkRemember(call.arguments);
    case "forget":
      return checkForget(call.arguments, context);
    case "list_tasks":
      return checkListTasks(call.arguments, context);
    case "get_task":
      return checkGetTask(call.arguments, context);
    case "list_holidays":
      return checkNoArgs(call.arguments, "Look up holidays");
    case "list_memories":
      return checkNoArgs(call.arguments, "Look up the saved notes");
    default:
      return { ok: false, error: `Unknown action "${call.name}".` };
  }
}

/** The plain-words description of a still-pending proposal, or a neutral line
 * when the arguments do not parse (the card never invents a description from
 * unvalidated data). */
export function describeToolCall(
  call: Pick<ChatToolCall, "name" | "arguments"> & { status?: string },
  context: ChatToolContext,
): string {
  const check = validateToolCall(call, context);
  if (check.ok) return check.description;
  // A RESOLVED card whose proposal no longer validates — the write itself
  // changed or removed the data it described (a deleted task, a hidden
  // holiday) — keeps a neutral line instead of claiming the proposal was
  // invalid: the outcome line carries what actually happened.
  if (call.status !== undefined && call.status !== "pending") return "This action was already resolved.";
  return "The assistant proposed an action, but its details are not valid.";
}

/** The `tool` message content each card state sends back to the model, so the
 * OpenAI protocol stays valid (S1: one tool message per call). A resolved
 * write's `result` line — ids and fields — rides to the model so it can
 * reference the task it just changed (S4); the `outcome` stays the card's
 * short user-facing line. A read's result is the data itself. */
export function toolResultContent(card: { status: string; outcome?: string; result?: string }): string {
  const detail = card.result ?? card.outcome;
  switch (card.status) {
    case "read":
      return `The assistant looked this up on its own. Result: ${detail ?? "no data"}`;
    case "confirmed":
      return `The user confirmed and it was applied. ${detail ?? ""}`.trim();
    case "failed":
      return `The user confirmed but it failed: ${detail ?? "unknown error"}`;
    case "discarded":
      return "The user discarded this proposal. Nothing was changed.";
    default:
      return "The user has not answered this proposal yet; treat it as not done.";
  }
}
