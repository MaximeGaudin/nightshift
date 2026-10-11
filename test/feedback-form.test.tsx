import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { canSend, FeedbackForm } from "../src/web/FeedbackForm.tsx";

test("feedback-form-empty", () => {
  const html = renderToStaticMarkup(<FeedbackForm project="p" cardId="c1" onError={() => {}} />);
  expect(html).toContain("Faire un retour à l&#x27;agent");
  expect(html).toMatch(/<button[^>]*\sdisabled=""[^>]*>Envoyer le retour<\/button>/);
});

test("feedback-form-filled-enabled", () => {
  const html = renderToStaticMarkup(<FeedbackForm project="p" cardId="c1" onError={() => {}} initialText="ok" />);
  expect(html).not.toMatch(/<button[^>]*\sdisabled=""/);
});

test("feedback-form-uploading-disables-send", () => {
  expect(canSend("look", false, 1)).toBe(false);
  expect(canSend("look", true, 0)).toBe(false);
  expect(canSend("  ", false, 0)).toBe(false);
  expect(canSend("look", false, 0)).toBe(true);
});
