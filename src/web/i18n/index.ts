import { useSyncExternalStore } from "react";
import type { LanguageSetting } from "../../shared/types.ts";
import { en } from "./en/index.ts";
import { fr } from "./fr/index.ts";

export type Locale = "en" | "fr";
export type MessageKey = keyof typeof en;
export type MessageParams = Record<string, string | number>;

// Widened so tests (and a future partial locale) may hold fewer keys than en at runtime.
const dictionaries: Record<Locale, Partial<Record<string, string>>> = { en, fr };
export const messages = dictionaries;

const INTL_LOCALE: Record<Locale, string> = { en: "en-US", fr: "fr-FR" };

/** "auto" follows the browser: any French variant gives fr, everything else en. */
export function resolveLocale(setting: LanguageSetting, browserLanguage?: string): Locale {
  if (setting === "en" || setting === "fr") return setting;
  return browserLanguage?.toLowerCase().startsWith("fr") ? "fr" : "en";
}

let current: Locale = resolveLocale("auto", (globalThis as { navigator?: { language?: string } }).navigator?.language);
const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return current;
}

export function setLocale(locale: Locale) {
  const changed = locale !== current;
  current = locale;
  if (typeof document !== "undefined") document.documentElement.lang = locale;
  if (changed) for (const l of listeners) l();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function interpolate(text: string, params?: MessageParams): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

/** Active locale, then en, then the key itself. Reads the live locale, so it also works outside React. */
export function t(key: MessageKey, params?: MessageParams): string {
  const text = dictionaries[current][key] ?? dictionaries.en[key] ?? key;
  return interpolate(text, params);
}

/** Plural form: looks up `${keyBase}_one` / `${keyBase}_other` and injects {count}. */
export function tn(keyBase: string, count: number, params?: MessageParams): string {
  const form = new Intl.PluralRules(INTL_LOCALE[current]).select(count);
  const withCount = { ...params, count };
  const primary = `${keyBase}_${form}`;
  const key = primary in dictionaries[current] || primary in dictionaries.en ? primary : `${keyBase}_other`;
  return t(key as MessageKey, withCount);
}

export function formatTime(date: Date | string | number): string {
  return new Date(date).toLocaleTimeString(INTL_LOCALE[current]);
}

export function formatDate(date: Date | string | number): string {
  return new Date(date).toLocaleDateString(INTL_LOCALE[current]);
}

export function formatRelative(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return t("time.justNow");
  if (s < 3600) return t("time.minutesAgo", { count: Math.floor(s / 60) });
  if (s < 86400) return t("time.hoursAgo", { count: Math.floor(s / 3600) });
  return formatDate(iso);
}

/** Subscribes the component to locale switches; t/tn are the same functions as the module exports. */
export function useT() {
  const locale = useSyncExternalStore(subscribe, getLocale, getLocale);
  return { t, tn, locale };
}
