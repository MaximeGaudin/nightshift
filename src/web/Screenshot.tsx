import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isCardScreenshot, screenshotUrl } from "../shared/screenshots.ts";
import { t, useT } from "./i18n/index.ts";

/** Escape closes the lightbox only: stop it before the card dialog's Escape listener (Radix, on the document) sees it. */
export function handleLightboxKey(
  e: Pick<KeyboardEvent, "key" | "preventDefault" | "stopImmediatePropagation">,
  onClose: () => void,
): boolean {
  if (e.key !== "Escape") return false;
  e.preventDefault();
  e.stopImmediatePropagation();
  onClose();
  return true;
}

export function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => void handleLightboxKey(e, onClose);
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  // The lightbox lives on body, outside the card dialog: without this, a press on it counts as an outside click and Radix closes the dialog.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    const stop = (e: Event) => e.stopPropagation();
    el?.addEventListener("pointerdown", stop);
    return () => el?.removeEventListener("pointerdown", stop);
  }, []);
  if (typeof document === "undefined") return null;
  return createPortal(
    // biome-ignore lint/a11y/useKeyWithClickEvents: the click on the backdrop is a mouse shortcut; the keyboard closes the lightbox with Escape (window listener above)
    <div ref={ref} className="lightbox" role="dialog" aria-label={alt} onClick={onClose}>
      <img src={src} alt={alt} />
    </div>,
    document.body,
  );
}

export function CardScreenshot({ project, cardId, alt, file }: { project: string; cardId: string; alt: string; file: string }) {
  const { t } = useT();
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const src = screenshotUrl(project, cardId, file);
  return (
    <figure className="md-figure">
      {failed ? (
        <div className="md-figure-missing">{t("board.screenshot.missing", { alt })}</div>
      ) : (
        <button type="button" className="md-figure-open" onClick={() => setOpen(true)}>
          <img src={src} alt={alt} onError={() => setFailed(true)} />
        </button>
      )}
      <figcaption>{alt}</figcaption>
      {open && !failed && <Lightbox src={src} alt={alt} onClose={() => setOpen(false)} />}
    </figure>
  );
}

/** renderImage for Markdown: card captures become figures, any other image stays text. */
export function renderCardImage(project: string, cardId: string) {
  return (alt: string, dest: string): ReactNode | null =>
    isCardScreenshot(dest, cardId) ? (
      <CardScreenshot project={project} cardId={cardId} alt={alt || t("board.screenshot.default")} file={dest} />
    ) : null;
}
