/** The app's icon set: one stroke family, drawn on a 24px grid, currentColor. */

type IconProps = { className?: string };

const base = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

export function TodayIcon({ className }: IconProps) {
  return (
    <svg {...base} strokeWidth={1.7} className={className}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
    </svg>
  );
}

export function TasksIcon({ className }: IconProps) {
  return (
    <svg {...base} strokeWidth={1.7} className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.2 12.4 2.6 2.6 5-5.4" />
    </svg>
  );
}

export function CalendarIcon({ className }: IconProps) {
  return (
    <svg {...base} strokeWidth={1.7} className={className}>
      <rect x="3" y="4.5" width="18" height="16.5" rx="3" />
      <path d="M3 9.5h18M8 2.5v4M16 2.5v4" />
    </svg>
  );
}

export function SearchIcon({ className }: IconProps) {
  return (
    <svg {...base} strokeWidth={1.9} className={className}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </svg>
  );
}

export function PlusIcon({ className }: IconProps) {
  return (
    <svg {...base} strokeWidth={2.3} className={className}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function ChevronLeft({ className }: IconProps) {
  return (
    <svg {...base} strokeWidth={2} className={className}>
      <path d="m15 5-7 7 7 7" />
    </svg>
  );
}

export function ChevronRight({ className }: IconProps) {
  return (
    <svg {...base} strokeWidth={2} className={className}>
      <path d="m9 5 7 7-7 7" />
    </svg>
  );
}

export function CloseIcon({ className }: IconProps) {
  return (
    <svg {...base} strokeWidth={2.2} className={className}>
      <path d="M7 7l10 10M17 7 7 17" />
    </svg>
  );
}

export function RepeatIcon({ className }: IconProps) {
  return (
    <svg {...base} strokeWidth={1.8} className={className}>
      <path d="m16.5 3.5 3 3-3 3" />
      <path d="M4.5 11.5v-1a4 4 0 0 1 4-4h11" />
      <path d="m7.5 20.5-3-3 3-3" />
      <path d="M19.5 12.5v1a4 4 0 0 1-4 4h-11" />
    </svg>
  );
}

export function FlagIcon({ className }: IconProps) {
  return (
    <svg {...base} strokeWidth={1.8} className={className}>
      <path d="M5 21V4M5 4.5h11l-2 4 2 4H5" />
    </svg>
  );
}

export function CloudIcon({ className }: IconProps) {
  return (
    <svg {...base} strokeWidth={1.8} className={className}>
      <path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 8.5a4.5 4.5 0 0 1-.5 9.5z" />
      <path d="m9.5 13 2 2 3.5-3.8" />
    </svg>
  );
}

export function CloudOffIcon({ className }: IconProps) {
  return (
    <svg {...base} strokeWidth={1.8} className={className}>
      <path d="M7 18a4.5 4.5 0 0 1-.6-8.96 6 6 0 0 1 2-3.2M11.5 3.6A6 6 0 0 1 18 8.5a4.5 4.5 0 0 1 2.3 8.2M3 3l18 18" />
    </svg>
  );
}

export function PersonIcon({ className }: IconProps) {
  return (
    <svg {...base} strokeWidth={1.7} className={className}>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </svg>
  );
}

/** The drag grip: two columns of dots, the smallest honest "grab me" mark. */
export function GripIcon({ className }: IconProps) {
  return (
    <svg {...base} stroke="none" fill="currentColor" className={className}>
      <circle cx="9.5" cy="6" r="1.15" />
      <circle cx="14.5" cy="6" r="1.15" />
      <circle cx="9.5" cy="12" r="1.15" />
      <circle cx="14.5" cy="12" r="1.15" />
      <circle cx="9.5" cy="18" r="1.15" />
      <circle cx="14.5" cy="18" r="1.15" />
    </svg>
  );
}
