import { useState } from "react";
import type { Card, Column } from "../shared/types.ts";
import { skipOptions, submitAddCard } from "./AddCard.tsx";
import { AppDialog } from "./components/app-dialog.tsx";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { DependencyPicker } from "./DependencyPicker.tsx";
import { useT } from "./i18n/index.ts";
import { SkipColumnsPicker } from "./SkipColumnsPicker.tsx";

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
  onAdd: (title: string, skip: string[], dependsOn: string[]) => void;
  onClose: () => void;
}) {
  const { t } = useT();
  const first = columns[0];
  const [title, setTitle] = useState(initialTitle);
  const [skip, setSkip] = useState<string[]>([]);
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  if (!first) return null;
  const submit = () => {
    if (!title.trim()) return;
    submitAddCard(title, skip, (t, s) => onAdd(t, s, dependsOn));
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
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
        <SkipColumnsPicker columns={skipOptions(columns, first.id)} value={skip} onChange={setSkip} />
        <DependencyPicker cards={cards} columns={columns} value={dependsOn} onChange={setDependsOn} />
      </div>
    </AppDialog>
  );
}
