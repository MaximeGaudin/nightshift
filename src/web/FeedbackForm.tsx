import { useState } from "react";
import { api } from "./api.ts";
import { Button } from "./components/ui/button.tsx";
import { Textarea } from "./components/ui/textarea.tsx";
import { useT } from "./i18n/index.ts";

export function FeedbackForm({
  project,
  cardId,
  onError,
  initialText = "",
}: {
  project: string;
  cardId: string;
  onError: (message: string) => void;
  initialText?: string;
}) {
  const { t } = useT();
  const [text, setText] = useState(initialText);
  const [sending, setSending] = useState(false);
  const blank = !text.trim();
  return (
    <form
      className="feedback flex shrink-0 flex-col gap-2 rounded-md border bg-card p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (blank || sending) return;
        setSending(true);
        api
          .sendFeedback(project, cardId, text)
          .then(() => setText(""))
          .catch((err) => onError(err instanceof Error ? err.message : String(err)))
          .finally(() => setSending(false));
      }}
    >
      <strong className="feedback-head text-[13px] font-semibold">{t("card.feedback.title")}</strong>
      <Textarea
        className="min-h-14"
        aria-label={t("card.feedback.label")}
        value={text}
        placeholder={t("card.feedback.placeholder")}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
        }}
      />
      <Button className="self-end" type="submit" disabled={blank || sending}>
        {t("card.feedback.send")}
      </Button>
    </form>
  );
}
