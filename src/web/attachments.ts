// Files dropped on a card: upload them and reference them in the description.

/** Same limit as the server: refused before reading a big file into memory. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Whether a drag carries files from outside the page (not text, not a dragged card). */
export function dragHasFiles(dt: Pick<DataTransfer, "types"> | null): boolean {
  return !!dt && Array.from(dt.types).includes("Files");
}

/**
 * Inserts the markdown of attached files into a description, each on its own line.
 * At `caret` when given (textarea cursor), otherwise at the end.
 */
export function insertAttachments(text: string, markdowns: string[], caret?: number): string {
  if (markdowns.length === 0) return text;
  const at = caret === undefined ? text.length : Math.max(0, Math.min(caret, text.length));
  const before = text.slice(0, at);
  const after = text.slice(at);
  const lead = before === "" || before.endsWith("\n") ? "" : "\n";
  const tail = after === "" || after.startsWith("\n") ? "" : "\n";
  return `${before}${lead}${markdowns.join("\n")}${tail}${after}`;
}

/** File content as base64 (no data: prefix). */
export async function fileToBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
