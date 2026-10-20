import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { TaskView } from "../data/store.ts";
import { GripIcon } from "./icons.tsx";
import "./drag.css";

/**
 * Carrying a task to the calendar (DESIGN.md: direct manipulation).
 *
 * The Tasks surface and the Calendar are separate views, so the gesture cannot
 * live in either one. One provider owns the carry: a grip starts it, window
 * listeners follow the pointer (the source may unmount mid-gesture, when the
 * calendar replaces the tasks view), a ghost follows the pointer, and the
 * Calendar registers where a drop would land and what committing it means.
 *
 * Pointer events, not HTML5 drag and drop: the latter has no touch support.
 * The grip owns `touch-action: none`, so a touch carry never scrolls the list.
 */

/** Where a carried task would land: a profile-zone day key and a start minute. */
export type DropSlot = { key: string; minutes: number };

type DropTarget = {
  resolve: (x: number, y: number) => DropSlot | null;
  commit: (task: TaskView, slot: DropSlot) => void;
};

type Carrying = { task: TaskView; drop: DropSlot | null };

type DragApi = {
  /** The task being carried, and the slot under the pointer, or null. */
  carrying: Carrying | null;
  begin: (task: TaskView, event: ReactPointerEvent<HTMLElement>) => void;
  setTarget: (target: DropTarget | null) => void;
};

const TaskDragContext = createContext<DragApi | null>(null);

/** How far the pointer must travel before a press becomes a carry. */
const activateDistance = 4;
/** The calendar view a carry switches to when the pointer rests on its nav item. */
const calendarView = "calendar" as const;

type Carry = {
  task: TaskView;
  drop: DropSlot | null;
  x: number;
  y: number;
  active: boolean;
  navigated: boolean;
};

export function TaskDragProvider({
  children,
  onNavigate,
}: {
  children: ReactNode;
  onNavigate: (view: typeof calendarView) => void;
}) {
  const [carrying, setCarrying] = useState<Carrying | null>(null);
  const target = useRef<DropTarget | null>(null);
  const ghost = useRef<HTMLDivElement | null>(null);
  const carry = useRef<Carry | null>(null);

  const setTarget = useCallback((next: DropTarget | null) => {
    target.current = next;
  }, []);

  /** The ghost mounts after the carry activates; a stable ref callback (it does
   * not re-run on re-render) positions it at the pointer and lets the moves
   * write `transform` directly, so no render is spent on tracking. */
  const attachGhost = useCallback((element: HTMLDivElement | null) => {
    ghost.current = element;
    const live = carry.current;
    if (element && live) element.style.transform = `translate3d(${live.x + 14}px, ${live.y + 14}px, 0)`;
  }, []);

  const begin = useCallback(
    (task: TaskView, event: ReactPointerEvent<HTMLElement>) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      if (carry.current) return;

      const live: Carry = { task, drop: null, x: event.clientX, y: event.clientY, active: false, navigated: false };
      carry.current = live;

      const place = (x: number, y: number) => {
        live.x = x;
        live.y = y;
        if (ghost.current) ghost.current.style.transform = `translate3d(${x + 14}px, ${y + 14}px, 0)`;
      };

      const end = (commit: boolean) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("blur", onCancel);
        window.removeEventListener("keydown", onKey);
        const dropped = commit && live.active ? live.drop : null;
        carry.current = null;
        delete document.documentElement.dataset.dragging;
        setCarrying(null);
        if (dropped) target.current?.commit(task, dropped);
      };

      const move = (moveEvent: PointerEvent) => {
        if (!live.active) {
          if (Math.hypot(moveEvent.clientX - live.x, moveEvent.clientY - live.y) < activateDistance) return;
          live.active = true;
          document.documentElement.dataset.dragging = "task";
          setCarrying({ task, drop: null });
        }
        place(moveEvent.clientX, moveEvent.clientY);
        // A drop on the calendar's entry point switches view: the carry keeps
        // going, because the listeners never belonged to the source element.
        const under = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY) as HTMLElement | null;
        if (under?.closest("[data-drop-nav]")) {
          if (!live.navigated) {
            live.navigated = true;
            onNavigate(calendarView);
          }
          if (live.drop) {
            live.drop = null;
            setCarrying(previous => (previous ? { ...previous, drop: null } : previous));
          }
          return;
        }
        const next = target.current?.resolve(moveEvent.clientX, moveEvent.clientY) ?? null;
        const unchanged =
          next === null ? live.drop === null : live.drop !== null && live.drop.key === next.key && live.drop.minutes === next.minutes;
        if (unchanged) return;
        live.drop = next;
        setCarrying(previous => (previous ? { ...previous, drop: next } : previous));
      };

      const onUp = () => end(true);
      const onCancel = () => end(false);
      const onKey = (keyEvent: KeyboardEvent) => {
        if (keyEvent.key !== "Escape") return;
        keyEvent.preventDefault();
        end(false);
      };

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("blur", onCancel);
      window.addEventListener("keydown", onKey);
    },
    [onNavigate],
  );

  const api: DragApi = { carrying, begin, setTarget };

  return (
    <TaskDragContext.Provider value={api}>
      {children}
      {carrying &&
        createPortal(
          <div ref={attachGhost} className="drag-ghost" data-drag-ghost="" aria-hidden="true">
            <span className="drag-ghost-body">{carrying.task.title}</span>
          </div>,
          document.body,
        )}
      {carrying && carrying.drop && (
        <span className="sr-only" role="status">
          {`Drop to plan ${carrying.task.title}.`}
        </span>
      )}
    </TaskDragContext.Provider>
  );
}

/** The carry, for a surface that renders a ghost or a drop preview. */
export function useTaskDrag(): DragApi | null {
  return useContext(TaskDragContext);
}

/**
 * The grip that starts a carry. It is a pointer affordance, not a control: the
 * same outcome is reachable from the keyboard through Plan and New block, so it
 * takes no tab stop and stays out of the accessibility tree.
 */
export function DragGrip({ task }: { task: TaskView }) {
  const drag = useTaskDrag();
  if (!drag) return null;
  return (
    <span
      className="drag-grip"
      aria-hidden="true"
      data-drag-task={task.id}
      onPointerDown={event => drag.begin(task, event)}
    >
      <GripIcon />
    </span>
  );
}

/**
 * Registers the calendar's drop geometry for as long as it is mounted. The
 * latest resolver and commit are read through a ref, so a re-render never has
 * to re-register.
 */
export function useCalendarDropTarget(target: DropTarget): void {
  // `setTarget` is stable across renders (the api object is not), so the
  // registration below survives every drop-slot update without churn.
  const setTarget = useContext(TaskDragContext)?.setTarget;
  const latest = useRef(target);
  useEffect(() => {
    latest.current = target;
  });
  useEffect(() => {
    if (!setTarget) return;
    setTarget({
      resolve: (x, y) => latest.current.resolve(x, y),
      commit: (task, slot) => latest.current.commit(task, slot),
    });
    return () => setTarget(null);
  }, [setTarget]);
}
