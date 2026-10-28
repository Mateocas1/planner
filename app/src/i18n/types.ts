import type { en } from "./en/index.ts";

/** A countable message: `Intl.PluralRules` picks `one` or `other` for `{count}`. */
export type Plural = { readonly one: string; readonly other: string };

/** The `{name}` placeholders of a template, as a union of names. */
type Placeholders<S extends string> = S extends `${string}{${infer P}}${infer R}` ? P | Placeholders<R> : never;

export type Messages = typeof en;
export type MessageKey = keyof Messages;

/** The Spanish dictionary must have exactly the English keys, plural where English is plural. */
export type Dictionary = { [K in MessageKey]: Messages[K] extends Plural ? Plural : string };

export type Params<K extends MessageKey> = Messages[K] extends Plural
  ? { count: number } & {
      [P in Exclude<Placeholders<Messages[K]["one"] | Messages[K]["other"]>, "count">]: string | number;
    }
  : { [P in Placeholders<Extract<Messages[K], string>>]: string | number };

/** `t(key)` for plain messages, `t(key, params)` when the message has placeholders. */
export type Args<K extends MessageKey> = keyof Params<K> extends never ? [] : [params: Params<K>];
