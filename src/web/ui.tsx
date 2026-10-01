import { formatRelative } from "./i18n/index.ts";

export function timeAgo(iso: string) {
  return formatRelative(iso);
}
