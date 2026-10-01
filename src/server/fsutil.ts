import { renameSync, writeFileSync } from "node:fs";

/** Writes `content` to `file` through a temporary file in the same folder and a rename: readers never see a truncated file. */
export function writeFileAtomic(file: string, content: string) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}
