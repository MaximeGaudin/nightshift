import { Plus } from "lucide-react";
import { useRef, useState } from "react";
import { type Column, DONE_COLUMN_ID } from "../shared/types.ts";
import { Button } from "./components/ui/button.tsx";
import { Checkbox } from "./components/ui/checkbox.tsx";
import { Label } from "./components/ui/label.tsx";
import { Textarea } from "./components/ui/textarea.tsx";
import { useT } from "./i18n/index.ts";
import { SkipColumnsPicker } from "./SkipColumnsPicker.tsx";

/** Columns a new card can be told to skip: those after the creation column, never Done. */
export function skipOptions(columns: Column[], columnId: string): Column[] {
  const index = columns.findIndex((c) => c.id === columnId);
  if (index < 0) return [];
  return columns.slice(index + 1).filter((c) => c.id !== DONE_COLUMN_ID);
}

/**
 * Submits the add-card form. A non-blank title creates the card, resets the form state and asks to close it.
 * A blank title submits nothing and keeps the typed state: the form stays open.
 */
export function submitAddCard(
  title: string,
  skip: string[],
  onAdd: (title: string, skip: string[]) => void,
): { title: string; skip: string[]; close: boolean } {
  if (!title.trim()) return { title, skip, close: false };
  onAdd(title.trim(), skip);
  return { title: "", skip: [], close: true };
}

export function AddCard({
  skipOptions: skipColumns = [],
  draftable = false,
  onAdd,
  initialOpen,
  onClose,
  closeOnEmptyBlur,
}: {
  skipOptions?: Column[];
  /** Show the draft checkbox: only Backlog accepts drafts. */
  draftable?: boolean;
  onAdd: (title: string, skip: string[], draft: boolean) => void;
  initialOpen?: boolean;
  onClose?: () => void;
  closeOnEmptyBlur?: boolean;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(initialOpen ?? false);
  const [title, setTitle] = useState("");
  const [skip, setSkip] = useState<string[]>([]);
  const [draft, setDraft] = useState(false);
  const formRef = useRef<HTMLDivElement>(null);
  const close = () => {
    setOpen(false);
    onClose?.();
  };
  if (!open)
    return (
      <Button
        type="button"
        variant="ghost"
        className="add-card mx-0.5 mb-2 justify-start text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(true)}
      >
        <Plus size={12} strokeWidth={1.75} aria-hidden="true" focusable="false" />
        {t("board.addCard")}
      </Button>
    );
  const submit = () => {
    const fresh = submitAddCard(title, skip, (t, s) => onAdd(t, s, draftable && draft));
    setTitle(fresh.title);
    setSkip(fresh.skip);
    if (fresh.close) {
      setDraft(false);
      close();
    }
  };
  return (
    <div className="add-card-form flex flex-col gap-1.5 px-0.5 pb-2" ref={formRef}>
      <Textarea
        autoFocus
        className="min-h-[60px]"
        value={title}
        onBlur={(e) => {
          if (!closeOnEmptyBlur || title.trim() !== "") return;
          const next = e.relatedTarget as Node | null;
          if (next && formRef.current?.contains(next)) return;
          close();
        }}
        placeholder={t("board.addCard.placeholder")}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") close();
        }}
      />
      {/* Keep the focus in the textarea while the picker is used, so opening it does not count as leaving the form. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: mouse-only focus guard, the picker inside stays keyboard accessible */}
      <div onMouseDown={(e) => e.target instanceof HTMLInputElement || e.preventDefault()}>
        <SkipColumnsPicker columns={skipColumns} value={skip} onChange={setSkip} />
        {draftable && (
          <Label className="add-card-draft flex items-center gap-2 text-xs font-normal">
            <Checkbox checked={draft} onCheckedChange={(v) => setDraft(v === true)} />
            {t("board.newCard.draft")}
          </Label>
        )}
      </div>
      <div className="row flex gap-1.5">
        <Button type="button" onClick={submit}>
          {t("board.addCard.submit")}
        </Button>
        <Button type="button" variant="ghost" onClick={close}>
          {t("common.cancel")}
        </Button>
      </div>
    </div>
  );
}
