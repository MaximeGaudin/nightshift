import { X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MAX_PENDING_IMAGES, pendingIds, pendingPath, resolvePending } from "../shared/pendingImages.ts";
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
import { useT } from "./i18n/index.ts";
import { dragHasFiles, imageRefusal, insertImageBlock, type Selection, type TransferLike, transferImages } from "./imagePaste.ts";
import { notifyError } from "./notify.ts";
import { SkipColumnsPicker } from "./SkipColumnsPicker.tsx";

/** An image pasted in the dialog, kept on the client until the card is created. */
export type PendingImage = { id: number; file: File; url: string };

/** Inserts the markers of the pending images `ids` at `at`, each on its own line; the cursor lands after them. */
export function insertPendingImages(description: string, at: Selection, ids: number[]): { text: string; cursor: number } {
  return insertImageBlock(description, at.start, at.end, ids.map(pendingPath));
}

/** The description without the marker of image `id`. */
export function removePendingImage(description: string, id: number): string {
  return resolvePending(description, new Map(pendingIds(description).map((n) => [n, n === id ? null : pendingPath(n)])));
}

/** The pending images whose marker is still in the description, in marker order: the ones the card is created with. */
export function pendingImagesInText(description: string, pending: PendingImage[]): PendingImage[] {
  return pendingIds(description).flatMap((n) => pending.filter((p) => p.id === n));
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
  onAdd: (title: string, skip: string[], dependsOn: string[], draft: boolean, description: string, images: Map<number, Blob>) => void;
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

  /** Keeps the accepted images of a paste or drop and puts their markers at `at` (null: the end). False when it holds no image. */
  const addImages = (transfer: TransferLike, at: Selection | null): boolean => {
    const files = transferImages(transfer);
    if (files.length === 0) return false;
    let room = MAX_PENDING_IMAGES - shown.length;
    const added: PendingImage[] = [];
    for (const file of files) {
      const refused = imageRefusal(file);
      if (refused) notifyError(refused);
      else if (room <= 0) notifyError(t("board.newCard.tooManyImages", { max: MAX_PENDING_IMAGES }));
      else {
        room -= 1;
        const url = URL.createObjectURL(file);
        urls.current.push(url);
        added.push({ id: nextId.current++, file, url });
      }
    }
    if (added.length === 0) return true;
    setPending((p) => [...p, ...added]);
    // Applied to the current text: two pastes in a row must not overwrite each other.
    setDescription((d) => {
      const next = insertPendingImages(
        d,
        at ?? { start: d.length, end: d.length },
        added.map((a) => a.id),
      );
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
  const submit = () => {
    if (!title.trim()) return;
    const images = new Map<number, Blob>(shown.map((p) => [p.id, p.file]));
    submitAddCard(title, skip, (t, s) => onAdd(t, s, dependsOn, draft, description, images));
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
            // An image pasted in the title goes to the end of the description; the title keeps its text.
            if (addImages(e.clipboardData, null)) e.preventDefault();
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
              if (addImages(e.clipboardData, selection())) e.preventDefault();
            }}
            onDragOver={(e) => {
              if (!dragHasFiles(e.dataTransfer)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
            }}
            onDrop={(e) => {
              if (!dragHasFiles(e.dataTransfer)) return;
              // A dropped file that is not an image must not be opened by the browser either.
              e.preventDefault();
              if (!addImages(e.dataTransfer, selection())) notifyError(t("card.imageUnsupported"));
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
