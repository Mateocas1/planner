import type { Dictionary } from "../types.ts";

/** Neutral Spanish: infinitives and impersonal phrasing, no voseo. */
export const tray = {
  "tray.signedOut": "Iniciar sesión para ver A continuación",
  "tray.nothingNext": "A continuación: nada más por hoy",
  "tray.upNext": "A continuación: {title} · {time}",
  "tray.focus": "Enfoque: quedan {minutes} min",
  "tray.workBlock": "Bloque de trabajo",
  "tray.open": "Abrir Planner",
  "tray.quit": "Salir",
  "tray.notice.title": "Planner sigue abierto en la bandeja",
  "tray.notice.body": "Cerrar oculta la ventana: se puede volver a abrir o salir desde el icono de la bandeja.",

  "toast.block.lead": "El trabajo profundo empieza en 2 min",
  "toast.block.snoozedLead": "Empieza ahora",
  "toast.block.startFocus": "Iniciar enfoque",
  "toast.block.snooze": "+5 min",
  "toast.shutdown.title": "Hora de cerrar el día.",
  "toast.shutdown.body": "El ritual de cierre está listo.",
  "toast.shutdown.action": "Cerrar el día",
  "toast.weekly.title": "Hora de cerrar la semana.",
  "toast.weekly.body": "La revisión semanal está lista.",
  "toast.weekly.start": "Empezar revisión",
  "toast.weekly.later": "Más tarde",
  "toast.weekly.skip": "Saltar esta semana",
} satisfies Partial<Dictionary>;
