import { useState } from "react";
import { api } from "./api.ts";

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
  const [text, setText] = useState(initialText);
  const [sending, setSending] = useState(false);
  const blank = !text.trim();
  return (
    <form
      className="feedback"
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
      <strong className="feedback-head">Faire un retour à l'agent</strong>
      <textarea
        aria-label="Retour à l'agent"
        value={text}
        placeholder="Votre retour… (⌘+Entrée pour envoyer)"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
        }}
      />
      <button className="primary" type="submit" disabled={blank || sending}>
        Envoyer le retour
      </button>
    </form>
  );
}
