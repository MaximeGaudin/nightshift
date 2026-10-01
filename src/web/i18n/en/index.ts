import { board } from "./board.ts";
import { card } from "./card.ts";
import { columns } from "./columns.ts";
import { common } from "./common.ts";
import { palette } from "./palette.ts";
import { settings } from "./settings.ts";
import { shortcuts } from "./shortcuts.ts";
import { skills } from "./skills.ts";

export const en = {
  ...common,
  ...board,
  ...card,
  ...settings,
  ...skills,
  ...columns,
  ...palette,
  ...shortcuts,
};
