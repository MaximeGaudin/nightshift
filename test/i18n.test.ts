import { afterEach, expect, test } from "bun:test";
import { en } from "../src/web/i18n/en/index.ts";
import { fr } from "../src/web/i18n/fr/index.ts";
import { getLocale, messages, resolveLocale, setLocale, t } from "../src/web/i18n/index.ts";

afterEach(() => setLocale("fr"));

test("i18n-key-parity: en and fr define the same keys", () => {
  const enKeys = new Set(Object.keys(en));
  const frKeys = new Set(Object.keys(fr));
  const missing = [...enKeys].filter((k) => !frKeys.has(k));
  const extra = [...frKeys].filter((k) => !enKeys.has(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});

test("i18n-resolve-locale: auto follows the browser, explicit settings win", () => {
  expect(resolveLocale("auto", "fr-CA")).toBe("fr");
  expect(resolveLocale("auto", "fr")).toBe("fr");
  expect(resolveLocale("auto", "en-US")).toBe("en");
  expect(resolveLocale("auto", "de")).toBe("en");
  expect(resolveLocale("auto", undefined)).toBe("en");
  expect(resolveLocale("en", "fr-FR")).toBe("en");
  expect(resolveLocale("fr", "en-US")).toBe("fr");
});

test("i18n-fallback: fr -> en -> key, placeholders, html lang", () => {
  setLocale("fr");
  expect(t("common.cancel")).toBe("Annuler");
  const saved = messages.fr["common.cancel"];
  delete messages.fr["common.cancel"];
  try {
    expect(t("common.cancel")).toBe("Cancel");
  } finally {
    messages.fr["common.cancel"] = saved;
  }
  expect(t("no.such.key" as never)).toBe("no.such.key");
  expect(t("common.templateSkillsNotCopied", { names: "a, b" })).toBe("Skills modèles non copiés : a, b");
  setLocale("en");
  expect(t("common.templateSkillsNotCopied", { names: "a" })).toBe("Template skills not copied: a");
  expect(t("time.minutesAgo", { count: 5 })).toBe("5 min ago");
});

test("i18n-fallback: setLocale updates document lang when a document exists", () => {
  const g = globalThis as { document?: unknown };
  const prev = g.document;
  const doc = { documentElement: { lang: "" } };
  g.document = doc;
  try {
    setLocale("en");
    expect(doc.documentElement.lang).toBe("en");
    setLocale("fr");
    expect(doc.documentElement.lang).toBe("fr");
    expect(getLocale()).toBe("fr");
  } finally {
    g.document = prev;
  }
});
