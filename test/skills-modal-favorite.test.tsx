import { expect, mock, test } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SkillInfo } from "../src/shared/types.ts";
import { SkillRow } from "../src/web/SkillsModal.tsx";

const skill = (name: string): SkillInfo => ({ name, description: `${name} desc`, scope: "project", path: `/p/${name}` }) as SkillInfo;
const favorites = ["deploy"];

const row = (name: string, onPick = () => {}, onToggleFavorite = () => {}) =>
  SkillRow({
    skill: skill(name),
    selected: false,
    favorite: favorites.includes(name),
    scopeLabel: "Project",
    favoriteLabel: favorites.includes(name) ? "Remove" : "Add",
    onPick,
    onToggleFavorite,
  });

test("skills-modal-favorite: star is pressed only for favorites", () => {
  const html = (n: string) => renderToStaticMarkup(row(n));
  expect(html("deploy")).toContain('aria-pressed="true"');
  expect(html("deploy")).toContain('aria-label="Remove"');
  expect(html("lint")).toContain('aria-pressed="false"');
  expect(html("lint")).toContain('aria-label="Add"');
});

test("skills-modal-favorite: star is a sibling of the select button", () => {
  const html = renderToStaticMarkup(row("deploy"));
  expect(html.match(/<button/g)?.length).toBe(2);
  expect(html.indexOf("</button>")).toBeLessThan(html.lastIndexOf("<button"));
});

test("skills-modal-favorite: click toggles without selecting the row", () => {
  const onPick = mock(() => {});
  const onToggle = mock(() => {});
  const li = row("deploy", onPick, onToggle) as ReactElement<{ children: ReactElement<{ onClick: (e: unknown) => void }>[] }>;
  const star = li.props.children[1];
  const stopPropagation = mock(() => {});
  star.props.onClick({ stopPropagation });
  expect(stopPropagation).toHaveBeenCalledTimes(1);
  expect(onToggle).toHaveBeenCalledTimes(1);
  expect(onPick).not.toHaveBeenCalled();
});
