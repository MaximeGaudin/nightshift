import { Paperclip, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MAX_PENDING_FILES, MAX_PENDING_TOTAL_BYTES, safeAttachmentName } from "../shared/attachments.ts";
import { MAX_PENDING_IMAGES, pendingFileMarker, pendingIds, pendingMarker, pendingPath, resolvePending } from "../shared/pendingImages.ts";
import type { Card, Column } from "../shared/types.ts";
import { skipOptions, submitAddCard } from "./AddCard.tsx";
import { AppDialog } from "./components/app-dialog.tsx";
import { IconButton } from "./components/icon-button.tsx";
import { Button } from "./components/ui/button.tsx";
import { Checkbox } from "./components/ui/checkbox.tsx";
import { Input } from "./components/ui/input.tsx";
import { Label } from "./components/ui/label.tsx";
import { Textarea } from "./components/ui/textarea.tsx";
import { DependencyPicker } from "./DependencyPicker.tsx";
import { t, useT } from "./i18n/index.ts";
import {
  attachmentRefusal,
  dragHasFiles,
  imageRefusal,
  insertBlock,
  insertImageBlock,
  isCardImage,
  type Selection,
  type TransferLike,
  transferFiles,
} from "./imagePaste.ts";
import { notifyError } from "./notify.ts";
import { SkipColumnsPicker } from "./SkipColumnsPicker.tsx";

/** An image pasted in the dialog, kept on the client until the card is created. */
export type PendingImage = { id: number; file: File; url: string };
/** Another file dropped or pasted in the dialog, kept on the client until the card is created; `name` is its safe name. */
export type PendingFile = { id: number; file: File; name: string };

/** Inserts the markers of the pending images `ids` at `at`, each on its own line; the cursor lands after them. */
export function insertPendingImages(description: string, at: Selection, ids: number[]): { text: string; cursor: number } {
  return insertImageBlock(description, at.start, at.end, ids.map(pendingPath));
}

/** Inserts the markers of pending files and images at `at`, in the given order, each on its own line. */
export function insertPendingMarkers(description: string, at: Selection, markers: string[]): { text: string; cursor: number } {
  return insertBlock(description, at.start, at.end, markers);
}

/** The description without the marker of image or file `id`. */
export function removePendingImage(description: string, id: number): string {
  return resolvePending(description, new Map(pendingIds(description).map((n) => [n, n === id ? null : pendingPath(n)])));
}

/** The pending entries whose marker is still in the description, in marker order: the ones the card is created with. */
export function pendingImagesInText<T extends { id: number }>(description: string, pending: T[]): T[] {
  return pendingIds(description).flatMap((n) => pending.filter((p) => p.id === n));
}

/**
 * What Create sends: the first `MAX_PENDING_IMAGES` images and `MAX_PENDING_FILES` files still in the text, and the
 * text without any other marker (one restored by undo after its entry was removed, or beyond the cap), so no
 * `pending:` reaches the card.
 */
export function pendingToSend(
  description: string,
  pending: PendingImage[],
  files: PendingFile[] = [],
): { description: string; images: Map<number, Blob>; attachments: Map<number, File> } {
  const sent = pendingImagesInText(description, pending).slice(0, MAX_PENDING_IMAGES);
  const sentFiles = pendingImagesInText(description, files).slice(0, MAX_PENDING_FILES);
  const kept = new Set([...sent, ...sentFiles].map((p) => p.id));
  return {
    description: resolvePending(description, new Map(pendingIds(description).map((n) => [n, kept.has(n) ? pendingPath(n) : null]))),
    images: new Map(sent.map((p) => [p.id, p.file])),
    attachments: new Map(sentFiles.map((p) => [p.id, p.file])),
  };
}

/** A file accepted by the dialog: an image (shown as a thumbnail) or another file (shown by its safe name). */
export type AdmittedEntry = { kind: "image"; id: number; file: File } | { kind: "file"; id: number; file: File; name: string };

/**
 * Sorts the files of a paste or drop into the ones the dialog keeps, in order, and one error per refused file: an
 * oversized image or file, more than MAX_PENDING_IMAGES images or MAX_PENDING_FILES files in the text, or a total
 * over MAX_PENDING_TOTAL_BYTES. `shown*` are the entries whose marker is still in the text.
 */
export function admitPending(
  files: File[],
  shownImages: { file: Blob }[],
  shownFiles: { file: Blob }[],
  newId: () => number,
): { admitted: AdmittedEntry[]; errors: string[] } {
  let imageRoom = MAX_PENDING_IMAGES - shownImages.length;
  let fileRoom = MAX_PENDING_FILES - shownFiles.length;
  let total = [...shownImages, ...shownFiles].reduce((sum, p) => sum + p.file.size, 0);
  const admitted: AdmittedEntry[] = [];
  const errors: string[] = [];
  for (const file of files) {
    const image = isCardImage(file);
    const refused = image ? imageRefusal(file) : attachmentRefusal(file);
    if (refused) errors.push(refused);
    else if (image && imageRoom <= 0) errors.push(t("board.newCard.tooManyImages", { max: MAX_PENDING_IMAGES }));
    else if (!image && fileRoom <= 0) errors.push(t("board.newCard.tooManyFiles", { max: MAX_PENDING_FILES }));
    else if (total + file.size > MAX_PENDING_TOTAL_BYTES) errors.push(t("board.newCard.tooLarge", { name: file.name }));
    else {
      total += file.size;
      if (image) {
        imageRoom -= 1;
        admitted.push({ kind: "image", id: newId(), file });
      } else {
        fileRoom -= 1;
        admitted.push({ kind: "file", id: newId(), file, name: safeAttachmentName(file.name) });
      }
    }
  }
  return { admitted, errors };
}

/** Create a card in the first column (Backlog), same rules as the inline add-card form. */
export function NewCardDialog({
  columns,
  cards = [],
  initialTitle = "",
  onAdd,
  onClose,
}: {
  columns: Column[];
  /** Cards the new one can depend on. */
  cards?: Card[];
  initialTitle?: string;
  onAdd: (
    title: string,
    skip: string[],
    dependsOn: string[],
    draft: boolean,
    description: string,
    images: Map<number, Blob>,
    attachments: Map<number, File>,
  ) => void;
  onClose: () => void;
}) {
  const { t } = useT();
  const first = columns[0];
  const [title, setTitle] = useState(initialTitle);
  const [skip, setSkip] = useState<string[]>([]);
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const [draft, setDraft] = useState(false);
  const [description, setDescription] = useState("");
  const [pending, setPending] = useState<PendingImage[]>([]);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const nextId = useRef(1);
  const descRef = useRef<HTMLTextAreaElement>(null);
  const cursor = useRef<number | null>(null);
  // Object URLs of the thumbnails live as long as the dialog.
  const urls = useRef<string[]>([]);
  useEffect(
    () => () => {
      for (const u of urls.current) URL.revokeObjectURL(u);
    },
    [],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: description is the trigger (the markers were rendered); the effect only moves the cursor
  useLayoutEffect(() => {
    const at = cursor.current;
    if (at === null) return;
    cursor.current = null;
    descRef.current?.setSelectionRange(at, at);
  }, [description]);
  if (!first) return null;
  const shown = pendingImagesInText(description, pending);
  const shownFiles = pendingImagesInText(description, pendingFiles);

  /**
   * Keeps the accepted images and files of a paste or drop and puts their markers at `at` (null: the end), in order.
   * False when it holds no file.
   */
  const addFiles = (transfer: TransferLike, at: Selection | null): boolean => {
    const files = transferFiles(transfer);
    if (files.length === 0) return false;
    const { admitted, errors } = admitPending(files, shown, shownFiles, () => nextId.current++);
    for (const message of errors) notifyError(message);
    if (admitted.length === 0) return true;
    const addedImages: PendingImage[] = [];
    const addedFiles: PendingFile[] = [];
    for (const entry of admitted) {
      if (entry.kind === "image") {
        const url = URL.createObjectURL(entry.file);
        urls.current.push(url);
        addedImages.push({ id: entry.id, file: entry.file, url });
      } else addedFiles.push({ id: entry.id, file: entry.file, name: entry.name });
    }
    if (addedImages.length > 0) setPending((p) => [...p, ...addedImages]);
    if (addedFiles.length > 0) setPendingFiles((p) => [...p, ...addedFiles]);
    const markers = admitted.map((e) => (e.kind === "image" ? pendingMarker(e.id) : pendingFileMarker(e.id, e.name)));
    // Applied to the current text: two pastes in a row must not overwrite each other.
    setDescription((d) => {
      const next = insertPendingMarkers(d, at ?? { start: d.length, end: d.length }, markers);
      cursor.current = next.cursor;
      return next.text;
    });
    return true;
  };
  const selection = (): Selection => {
    const el = descRef.current;
    return el ? { start: el.selectionStart, end: el.selectionEnd } : { start: description.length, end: description.length };
  };
  const removeImage = (image: PendingImage) => {
    setDescription((d) => removePendingImage(d, image.id));
    setPending((p) => p.filter((x) => x.id !== image.id));
    URL.revokeObjectURL(image.url);
    urls.current = urls.current.filter((u) => u !== image.url);
  };
  const removeFile = (file: PendingFile) => {
    setDescription((d) => removePendingImage(d, file.id));
    setPendingFiles((p) => p.filter((x) => x.id !== file.id));
  };
  const submit = () => {
    if (!title.trim()) return;
    const out = pendingToSend(description, pending, pendingFiles);
    submitAddCard(title, skip, (t, s) => onAdd(t, s, dependsOn, draft, out.description, out.images, out.attachments));
    onClose();
  };
  return (
    <AppDialog
      size="md"
      title={t("board.newCard.title")}
      description={t("board.newCard.description", { name: first.name })}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={!title.trim()} onClick={submit}>
            {t("board.newCard.create")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Input
          autoFocus
          value={title}
          placeholder={t("board.newCard.placeholder")}
          aria-label={t("board.newCard.aria")}
          onChange={(e) => setTitle(e.target.value)}
          onPaste={(e) => {
            // A file pasted in the title goes to the end of the description; the title keeps its text.
            if (addFiles(e.clipboardData, null)) e.preventDefault();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="new-card-desc flex flex-col gap-1.5">
          <Label htmlFor="new-card-description" className="self-start text-xs">
            {t("board.newCard.descriptionLabel")}
          </Label>
          <Textarea
            id="new-card-description"
            ref={descRef}
            className="min-h-24 font-mono leading-relaxed"
            value={description}
            placeholder={t("board.newCard.descriptionPlaceholder")}
            onChange={(e) => setDescription(e.target.value)}
            onPaste={(e) => {
              if (addFiles(e.clipboardData, selection())) e.preventDefault();
            }}
            onDragOver={(e) => {
              if (!dragHasFiles(e.dataTransfer)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
            }}
            onDrop={(e) => {
              if (!dragHasFiles(e.dataTransfer)) return;
              // A dropped file must never be opened by the browser, even when none can be read.
              e.preventDefault();
              addFiles(e.dataTransfer, selection());
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
              }
            }}
          />
          {shown.length > 0 && (
            <ul className="new-card-images m-0 flex list-none flex-wrap gap-2 p-0">
              {shown.map((image) => (
                <li key={image.id} className="relative">
                  <img src={image.url} alt="" className="block h-16 w-16 rounded-md border object-cover" />
                  <IconButton
                    label={t("board.newCard.removeImage")}
                    className="absolute -top-2 -right-2 size-5 rounded-full border bg-card"
                    onClick={() => removeImage(image)}
                  >
                    <X size={12} aria-hidden="true" focusable="false" />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
          {shownFiles.length > 0 && (
            <ul className="new-card-files m-0 flex list-none flex-wrap gap-2 p-0">
              {shownFiles.map((file) => (
                <li key={file.id} className="flex items-center gap-1 rounded-md border bg-card py-0.5 pr-0.5 pl-2 font-mono text-xs">
                  <Paperclip size={12} aria-hidden="true" focusable="false" />
                  <span className="max-w-48 truncate">{file.name}</span>
                  <IconButton
                    label={t("board.newCard.removeFile", { name: file.name })}
                    className="size-5"
                    onClick={() => removeFile(file)}
                  >
                    <X size={12} aria-hidden="true" focusable="false" />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
        </div>
        <SkipColumnsPicker columns={skipOptions(columns, first.id)} value={skip} onChange={setSkip} />
        <DependencyPicker cards={cards} columns={columns} value={dependsOn} onChange={setDependsOn} />
        <Label className="new-card-draft flex items-center gap-2 text-xs font-normal">
          <Checkbox checked={draft} onCheckedChange={(v) => setDraft(v === true)} />
          {t("board.newCard.draft")}
        </Label>
      </div>
    </AppDialog>
  );
}
