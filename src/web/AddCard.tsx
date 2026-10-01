import { useRef, useState } from "react";
import { type Column, DONE_COLUMN_ID } from "../shared/types.ts";
import { Icon } from "./icons.tsx";
import { SkipColumnsPicker } from "./SkipColumnsPicker.tsx";

/** Columns a new card can be told to skip: those after the creation column, never Done. */
export function skipOptions(columns: Column[], columnId: string): Column[] {
  const index = columns.findIndex((c) => c.id === columnId);
  if (index < 0) return [];
  return columns.slice(index + 1).filter((c) => c.id !== DONE_COLUMN_ID);
}

/** Submits the add-card form: a blank title submits nothing; the form state is fresh afterwards either way. */
export function submitAddCard(
  title: string,
  skip: string[],
  onAdd: (title: string, skip: string[]) => void,
): { title: string; skip: string[] } {
  if (title.trim()) onAdd(title.trim(), skip);
  return { title: "", skip: [] };
}

export function AddCard({
  skipOptions: skipColumns = [],
  onAdd,
  initialOpen,
  onClose,
  closeOnEmptyBlur,
}: {
  skipOptions?: Column[];
  onAdd: (title: string, skip: string[]) => void;
  initialOpen?: boolean;
  onClose?: () => void;
  closeOnEmptyBlur?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen ?? false);
  const [title, setTitle] = useState("");
  const [skip, setSkip] = useState<string[]>([]);
  const formRef = useRef<HTMLDivElement>(null);
  const close = () => {
    setOpen(false);
    onClose?.();
  };
  if (!open)
    return (
      <button type="button" className="add-card ghost" onClick={() => setOpen(true)}>
        <Icon name="plus" size={12} />
        Ajouter une fiche
      </button>
    );
  const submit = () => {
    const fresh = submitAddCard(title, skip, onAdd);
    setTitle(fresh.title);
    setSkip(fresh.skip);
  };
  return (
    <div className="add-card-form" ref={formRef}>
      <textarea
        // biome-ignore lint/a11y/noAutofocus: the form opens on user request ("add a card"), the title field is what they want to type in
        autoFocus
        value={title}
        onBlur={(e) => {
          if (!closeOnEmptyBlur || title.trim() !== "") return;
          const next = e.relatedTarget as Node | null;
          if (next && formRef.current?.contains(next)) return;
          close();
        }}
        placeholder="Titre de la fiche…"
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
      </div>
      <div className="row">
        <button type="button" className="primary" onClick={submit}>
          Ajouter
        </button>
        <button type="button" onClick={close}>
          Annuler
        </button>
      </div>
    </div>
  );
}
