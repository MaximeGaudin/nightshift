import { useEffect, useRef, useState } from "react";
import type { Board, Card, LiveStatus, LogLine } from "../shared/types.ts";
import { api, useServerEvents } from "./api.ts";
import { StatusIcon } from "./icons.tsx";
import { Markdown } from "./markdown.tsx";
import { ErrorBanner, Modal, timeAgo } from "./ui.tsx";

export function CardModal({
  project,
  card,
  board,
  live,
  onClose,
}: {
  project: string;
  card: Card;
  board: Board;
  live?: LiveStatus;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(card.title);
  const [description, setDescription] = useState(card.description);
  const [log, setLog] = useState<LogLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"log" | "history">("log");
  const [answers, setAnswers] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);
  // Description shows rendered markdown by default; an empty one opens straight in the editor.
  const [descMode, setDescMode] = useState<"preview" | "edit">(card.description.trim() ? "preview" : "edit");
  const descRef = useRef<HTMLTextAreaElement>(null);
  const focusDesc = useRef(false);
  // Card content the form started from: edits are detected against it, not against the live card,
  // so agent updates are pulled into an untouched form instead of being mistaken for user edits.
  const [base, setBase] = useState({ title: card.title, description: card.description });
  const dirty = title !== base.title || description !== base.description;
  const column = board.columns.find((c) => c.id === card.columnId);

  useEffect(() => {
    if (dirty) return;
    setTitle(card.title);
    setDescription(card.description);
    setBase({ title: card.title, description: card.description });
  }, [card.title, card.description]);

  useEffect(() => {
    if (descMode !== "edit" || !focusDesc.current) return;
    focusDesc.current = false;
    descRef.current?.focus();
  }, [descMode]);
  const editDescription = () => {
    focusDesc.current = true;
    setDescMode("edit");
  };

  useEffect(() => void api.log(project, card.id).then(setLog).catch(() => {}), [card.id]);
  useServerEvents((e) => {
    if (e.type !== "log" || e.project !== project || e.cardId !== card.id) return;
    // A new run resets the log on the server: mirror that.
    setLog((l) => (e.line.text.startsWith("Starting skill") ? [e.line] : [...l, e.line]));
  });
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log.length, tab]);

  const guard = (p: Promise<unknown>) => p.catch((e) => setError(e.message));
  const save = () =>
    guard(api.updateCard(project, card.id, { title, description }).then(() => setBase({ title, description })));
  const lr = card.lastRun;

  return (
    <Modal
      wide
      title={
        <span>
          Fiche <span className="muted">· {column?.name}</span>
        </span>
      }
      onClose={() => {
        if (dirty) save();
        onClose();
      }}
      footer={
        <>
          <button
            className="danger"
            onClick={() => {
              if (confirm("Supprimer cette fiche ?")) guard(api.deleteCard(project, card.id)).then(onClose);
            }}
          >
            Supprimer
          </button>
          <div className="spacer" />
          {live === "running" && <button onClick={() => guard(api.cancel(project, card.id))}>Arrêter l'agent</button>}
          {column?.type === "skill" && live !== "running" && (
            <button onClick={() => guard(api.retry(project, card.id))}>{lr?.columnId === card.columnId ? "Relancer" : "Lancer"}</button>
          )}
          <button className="primary" disabled={!dirty} onClick={save}>
            Enregistrer
          </button>
        </>
      }
    >
      <ErrorBanner error={error} onClose={() => setError(null)} />
      <div className="card-modal">
        <div className="card-edit">
          <label>
            Titre
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <div className="card-desc">
            <div className="card-desc-head">
              <span id="card-desc-label" className="card-desc-label">
                Description
              </span>
              <div className="tabs" role="tablist" aria-labelledby="card-desc-label">
                <button role="tab" aria-selected={descMode === "preview"} onClick={() => setDescMode("preview")}>
                  Aperçu
                </button>
                <button role="tab" aria-selected={descMode === "edit"} onClick={editDescription}>
                  Modifier
                </button>
              </div>
            </div>
            {descMode === "edit" ? (
              <textarea
                ref={descRef}
                className="card-desc-body"
                aria-label="Description (markdown)"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                spellCheck
              />
            ) : (
              <div
                className="card-desc-body card-desc-preview"
                role="tabpanel"
                tabIndex={0}
                title="Double-cliquer pour modifier"
                onDoubleClick={editDescription}
              >
                {description.trim() ? (
                  <Markdown source={description} />
                ) : (
                  <p className="muted">Aucune description. Double-cliquer pour en écrire une.</p>
                )}
              </div>
            )}
          </div>
          {live === "running" && dirty && (
            <p className="hint warn">Un agent travaille sur cette fiche : son résultat écrasera vos modifications non enregistrées.</p>
          )}
        </div>
        <aside className="card-side">
          {lr?.status === "question" && lr.columnId === card.columnId && !live && (
            <form
              className="question"
              onSubmit={(e) => {
                e.preventDefault();
                if (answers.some((a) => a.trim())) guard(api.answer(project, card.id, answers)).then(() => setAnswers([]));
              }}
            >
              <strong className="question-head">
                <StatusIcon status="question" />
                L'agent a {lr.questions?.length ?? 0} question{(lr.questions?.length ?? 0) > 1 ? "s" : ""}
              </strong>
              <p className="hint small">Une réponse vide laisse l'agent décider.</p>
              {(lr.questions ?? []).map((q, i) => (
                <div key={i} className="qa">
                  <div className="qa-q">
                    <span className="qa-num">{i + 1}.</span>
                    <Markdown source={q} />
                  </div>
                  <textarea
                    aria-label={`Réponse à la question ${i + 1}`}
                    autoFocus={i === 0}
                    value={answers[i] ?? ""}
                    placeholder="Votre réponse… (⌘+Entrée pour tout envoyer)"
                    onChange={(e) => setAnswers((a) => Object.assign([...a], { [i]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
                    }}
                  />
                </div>
              ))}
              <button className="primary" type="submit" disabled={!answers.some((a) => a?.trim())}>
                Répondre et reprendre
              </button>
            </form>
          )}
          {lr && (lr.status !== "question" || live) && (
            <div className={`last-run st-${lr.status}`}>
              <div className="last-run-head">
                <StatusIcon status={lr.status} />
                <strong>Dernier run</strong>
                <span className="muted">
                  · {board.columns.find((c) => c.id === lr.columnId)?.name ?? "?"} · {timeAgo(lr.at)}
                </span>
              </div>
              {lr.summary && <Markdown source={lr.summary} className="last-run-summary" />}
              {lr.error && <pre className="error-text">{lr.error}</pre>}
              <div className="last-run-meta muted small">
                {lr.costUsd !== undefined && <>Coût : ${lr.costUsd.toFixed(3)} · </>}
                {lr.sessionId && (
                  <span title="Reprendre la session dans un terminal">
                    <code>claude -r {lr.sessionId}</code>
                  </span>
                )}
              </div>
            </div>
          )}
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === "log"} onClick={() => setTab("log")}>
              Journal agent {live === "running" && <span className="spinner" aria-hidden />}
            </button>
            <button role="tab" aria-selected={tab === "history"} onClick={() => setTab("history")}>
              Historique
            </button>
          </div>
          <div className="log" ref={logRef}>
            {tab === "log" ? (
              log.length ? (
                log.map((l, i) => (
                  <div key={i} className={`log-line ${l.kind}`}>
                    <time>{new Date(l.at).toLocaleTimeString("fr-FR")}</time>
                    <span>{l.text}</span>
                  </div>
                ))
              ) : (
                <p className="muted">Aucun run pour cette fiche.</p>
              )
            ) : (
              [...card.history].reverse().map((h, i) => (
                <div key={i} className={`log-line ${h.kind}`}>
                  <time>{timeAgo(h.at)}</time>
                  <span>{h.text}</span>
                </div>
              ))
            )}
          </div>
        </aside>
      </div>
    </Modal>
  );
}
