import { formatClock, parseClock } from "./clock.ts";

/** The two halves of a `YYYY-MM-DDTHH:mm` wall-clock value; a missing half is "". */
export function splitLocal(value: string): { date: string; time: string } {
  const [date = "", time = ""] = value.split("T");
  return { date, time };
}

/** `YYYY-MM-DDTHH:mm` from a day key and minutes after midnight, or "" without a day. */
export function joinLocal(date: string, minutes: number): string {
  return date === "" ? "" : `${date}T${formatClock(minutes)}`;
}

/**
 * The value with its clock replaced by typed text, or null when the text is not
 * a time of the day. A value with no day yet takes `fallbackDate` (today), so a
 * time typed before a day is picked is not thrown away.
 */
export function setLocalTime(value: string, text: string, fallbackDate = ""): string | null {
  const minutes = parseClock(text);
  if (minutes === null || minutes >= 24 * 60) return null;
  return joinLocal(splitLocal(value).date || fallbackDate, minutes);
}

/** The value with its day replaced; an empty value picks up midnight, "" clears the whole value. */
export function setLocalDate(value: string, date: string): string {
  if (date === "") return "";
  const { time } = splitLocal(value);
  return `${date}T${time === "" ? "00:00" : time}`;
}
