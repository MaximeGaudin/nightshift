// Image paste and drop on a plain textarea whose card already exists: upload right away, insert the reference at the cursor.
import { type ClipboardEvent, type DragEvent, type RefObject, useLayoutEffect, useRef, useState } from "react";
import { t } from "./i18n/index.ts";
import { dragHasFiles, handleImageTransfer, type ImagePasteDeps, type Selection } from "./imagePaste.ts";

export type ImagePasteField = {
  onPaste(e: ClipboardEvent<HTMLTextAreaElement>): void;
  onDragOver(e: DragEvent<HTMLTextAreaElement>): void;
  onDrop(e: DragEvent<HTMLTextAreaElement>): void;
  /** Uploads in flight. */
  uploading: number;
};

/**
 * Paste and drop handlers for a textarea holding `text`. Images are uploaded with `upload`, and their
 * `![image](path)` lines replace the selection the textarea had at paste time, applied to the text current when
 * the uploads end. `busy` hears each upload start (+1) and end (-1), for a parent that sums several fields.
 */
export function useImagePaste({
  ref,
  text,
  setText,
  upload,
  onError,
  busy,
}: {
  ref: RefObject<HTMLTextAreaElement | null>;
  text: string;
  setText(update: (text: string) => string): void;
  upload(image: Blob): Promise<{ path: string }>;
  onError(message: string): void;
  busy?(delta: 1 | -1): void;
}): ImagePasteField {
  const [uploading, setUploading] = useState(0);
  const cursor = useRef<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: text is the trigger (the inserted references were rendered); the effect only moves the cursor
  useLayoutEffect(() => {
    const at = cursor.current;
    if (at === null) return;
    cursor.current = null;
    ref.current?.setSelectionRange(at, at);
  }, [text]);
  const deps: ImagePasteDeps = {
    upload,
    apply: (edit) =>
      setText((current) => {
        const next = edit(current);
        cursor.current = next.cursor;
        return next.text;
      }),
    onError,
    busy: (delta) => {
      setUploading((n) => n + delta);
      busy?.(delta);
    },
  };
  const at = (): Selection => {
    const el = ref.current;
    return el ? { start: el.selectionStart, end: el.selectionEnd } : { start: text.length, end: text.length };
  };
  return {
    onPaste: (e) => void handleImageTransfer(e, e.clipboardData, at, deps),
    onDragOver: (e) => {
      if (!dragHasFiles(e.dataTransfer)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    onDrop: (e) => {
      if (!dragHasFiles(e.dataTransfer)) return;
      // A dropped file that is not an image must not be opened by the browser either (it would leave the board).
      e.preventDefault();
      if (!handleImageTransfer(e, e.dataTransfer, at, deps)) onError(t("card.imageUnsupported"));
    },
    uploading,
  };
}
