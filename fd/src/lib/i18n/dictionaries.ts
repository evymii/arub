import { type MessageKey, en } from "./en";
import { mn } from "./mn";

export type Locale = "en" | "mn";

export const LOCALE_STORAGE_KEY = "ar.locale.v1";

export type { MessageKey };

export type Messages = { [K in MessageKey]: string };

export const dictionaries: Record<Locale, Messages> = {
  en: en as Messages,
  mn,
};
