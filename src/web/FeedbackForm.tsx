import { useRef, useState } from "react";
import { api } from "./api.ts";
import { Button } from "./components/ui/button.tsx";
import { Textarea } from "./components/ui/textarea.tsx";
import { useT } from "./i18n/index.ts";
import { useImagePaste } from "./useImagePaste.ts";

/** Feedback can be sent once it has text, while no send and no image upload is running. */
export function canSend(text: string, sending: boolean, uploading: number): boolean {
  return text.trim() !== "" && !sending && uploading === 0;
}

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
  const ref = useRef<HTMLTextAreaElement>(null);
  const images = useImagePaste({ ref, text, setText, upload: (image) => api.uploadCardImage(project, cardId, image), onError });
  const ready = canSend(text, sending, images.uploading);
  return (
    <form
      className="feedback flex shrink-0 flex-col gap-2 rounded-md border bg-card p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
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
        ref={ref}
        className="min-h-14"
        aria-label={t("card.feedback.label")}
        value={text}
        placeholder={t("card.feedback.placeholder")}
        onChange={(e) => setText(e.target.value)}
        onPaste={images.onPaste}
        onDragOver={images.onDragOver}
        onDrop={images.onDrop}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
        }}
      />
      {images.uploading > 0 && (
        <span className="feedback-uploading text-xs text-muted-foreground" role="status">
          {t("card.uploadingImage")}
        </span>
      )}
      <Button className="self-end" type="submit" disabled={!ready}>
        {t("card.feedback.send")}
      </Button>
    </form>
  );
}
