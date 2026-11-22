import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  dragHasFiles,
  handleImageTransfer,
  type ImagePasteDeps,
  insertImageBlock,
  type TransferLike,
  transferFiles,
  transferImages,
} from "../src/web/imagePaste.ts";

/** The paste event fields the card modal passes on: the clipboard and the textarea's selection. */
type PasteEventLike = {
  clipboardData: { items: NonNullable<NonNullable<TransferLike>["items"]> } | null;
  currentTarget: { selectionStart: number; selectionEnd: number };
  preventDefault(): void;
};
/** What the card modal does on paste in the editor. */
const handleImagePaste = (e: PasteEventLike, d: ImagePasteDeps) =>
  handleImageTransfer(e, e.clipboardData, () => ({ start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd }), d);

const fileItem = (type: string, size = 10) => {
  const file = new File([new Uint8Array(size)], "pasted", { type });
  return { kind: "file", type, getAsFile: () => file };
};
const textItem = { kind: "string", type: "text/plain", getAsFile: () => null };

/** A paste event on a textarea holding `text`, with the selection `start..end`. */
function paste(items: NonNullable<PasteEventLike["clipboardData"]>["items"], start: number, end = start) {
  let prevented = false;
  const e: PasteEventLike = {
    clipboardData: { items },
    currentTarget: { selectionStart: start, selectionEnd: end },
    preventDefault: () => {
      prevented = true;
    },
  };
  return { e, prevented: () => prevented };
}

/** Deps whose `apply` edits `text` in place, recording uploads, errors and the busy counter. */
function deps(text: string, upload: ImagePasteDeps["upload"], attach?: ImagePasteDeps["attach"]) {
  const state = { text, cursor: -1, errors: [] as string[], busy: 0, maxBusy: 0, uploads: 0, attaches: 0 };
  const d: ImagePasteDeps = {
    upload: (image) => {
      state.uploads++;
      return upload(image);
    },
    attach: (file) => {
      state.attaches++;
      return attach ? attach(file) : Promise.reject(new Error("no attach"));
    },
    apply: (edit) => {
      const next = edit(state.text);
      state.text = next.text;
      state.cursor = next.cursor;
    },
    onError: (m) => state.errors.push(m),
    busy: (delta) => {
      state.busy += delta;
      state.maxBusy = Math.max(state.maxBusy, state.busy);
    },
  };
  return { d, state };
}

test("paste image inserts markdown at cursor", async () => {
  const { d, state } = deps("ab", async () => ({ path: "/p/x.png" }));
  const { e, prevented } = paste([fileItem("image/png")], 1);
  await handleImagePaste(e, d);
  expect(prevented()).toBe(true);
  expect(state.text).toBe("a\n![image](/p/x.png)\nb");
  expect(state.cursor).toBe("a\n![image](/p/x.png)\n".length);
  expect(state.busy).toBe(0);
  expect(state.maxBusy).toBe(1);
});

test("paste image replaces the selection and adds no extra blank line", async () => {
  expect(insertImageBlock("a\nSEL\nb", 2, 5, ["/p/x.png"]).text).toBe("a\n![image](/p/x.png)\nb");
  expect(insertImageBlock("", 0, 0, ["/p/x.png"])).toEqual({ text: "![image](/p/x.png)", cursor: 18 });
  // The user typed meanwhile and the text got shorter: the position is clamped.
  expect(insertImageBlock("a", 5, 9, ["/p/x.png"]).text).toBe("a\n![image](/p/x.png)");
});

test("paste two images keeps order", async () => {
  const resolvers: Record<string, () => void> = {};
  const { d, state } = deps(
    "",
    (image) =>
      new Promise((resolve) => {
        const path = image.type === "image/png" ? "/p/1.png" : "/p/2.gif";
        resolvers[path] = () => resolve({ path });
      }),
  );
  const done = handleImagePaste(paste([fileItem("image/png"), textItem, fileItem("image/gif")], 0).e, d);
  expect(state.maxBusy).toBe(2);
  resolvers["/p/2.gif"]();
  await Bun.sleep(0);
  resolvers["/p/1.png"]();
  await done;
  expect(state.text).toBe("![image](/p/1.png)\n![image](/p/2.gif)");
});

test("paste text makes no request", () => {
  const { d, state } = deps("ab", async () => ({ path: "/p/x.png" }));
  const { e, prevented } = paste([textItem], 1);
  expect(handleImagePaste(e, d)).toBeNull();
  expect(prevented()).toBe(false);
  expect(state.uploads).toBe(0);
  expect(handleImagePaste({ ...e, clipboardData: null }, d)).toBeNull();
});

test("paste failure toasts", async () => {
  const { d, state } = deps("ab", async () => {
    throw new Error("Unsupported image type (PNG, JPEG, GIF or WebP)");
  });
  await handleImagePaste(paste([fileItem("image/png")], 1).e, d);
  expect(state.text).toBe("ab");
  expect(state.errors).toEqual(["Unsupported image type (PNG, JPEG, GIF or WebP)"]);
  expect(state.busy).toBe(0);
});

test("paste refuses oversized images before any request, attaches other image types, others still insert", async () => {
  const { d, state } = deps(
    "",
    async () => ({ path: "/p/ok.png" }),
    async () => ({ path: "/a/pasted", name: "pasted" }),
  );
  await handleImagePaste(paste([fileItem("image/svg+xml"), fileItem("image/png", 8 * 1024 * 1024 + 1), fileItem("image/png")], 0).e, d);
  expect(state.uploads).toBe(1);
  expect(state.attaches).toBe(1);
  expect(state.errors).toEqual(["L'image dépasse 8 Mo"]);
  expect(state.text).toBe("[pasted](/a/pasted)\n![image](/p/ok.png)");
});

test("transfer images fall back to files when items hold none", () => {
  const png = new File([new Uint8Array(4)], "a.png", { type: "image/png" });
  const pdf = new File([new Uint8Array(4)], "a.pdf", { type: "application/pdf" });
  expect(transferImages({ items: [textItem], files: [png, pdf] })).toEqual([png]);
  expect(transferImages({ files: [pdf] })).toEqual([]);
  expect(transferImages(null)).toEqual([]);
});

test("drop inserts images at the given selection", async () => {
  const { d, state } = deps("ab", async () => ({ path: "/p/d.png" }));
  let prevented = false;
  const png = new File([new Uint8Array(4)], "a.png", { type: "image/png" });
  const done = handleImageTransfer({ preventDefault: () => (prevented = true) }, { files: [png] }, () => ({ start: 2, end: 2 }), d);
  await done;
  expect(prevented).toBe(true);
  expect(state.text).toBe("ab\n![image](/p/d.png)");
  expect(dragHasFiles({ types: ["Files"] })).toBe(true);
  expect(dragHasFiles({ types: ["text/plain"] })).toBe(false);
  expect(dragHasFiles(null)).toBe(false);
});

test("card modal wires paste and drop on the description and the uploading hint", () => {
  const src = readFileSync(join(import.meta.dir, "../src/web/CardModal.tsx"), "utf8");
  expect(src).toContain("onPaste={(e) => void handleImageTransfer(e, e.clipboardData, imageTarget, imageDeps)}");
  expect(src).toContain("handleImageTransfer(e, e.dataTransfer, imageTarget, imageDeps)");
  expect(src).toContain("onDragOver={(e) =>");
  expect(src).toContain("api.uploadCardImage(project, card.id, image)");
  expect(src).toContain('t("card.uploadingImage")');
  // A pasted image previewed before Save fails to load; the preview remounts once the card is saved.
  expect(src).toContain("<Markdown key={card.updatedAt} source={description}");
});

test("card-file-drop-ui: images and files land in drop order at the caret", async () => {
  const resolvers: Record<string, () => void> = {};
  const { d, state } = deps(
    "ab",
    () => new Promise((resolve) => (resolvers.png = () => resolve({ path: "/s/a.png" }))),
    (file) => new Promise((resolve) => (resolvers.pdf = () => resolve({ path: `/att/${file.name}`, name: file.name }))),
  );
  const png = new File([new Uint8Array(4)], "a.png", { type: "image/png" });
  const pdf = new File([new Uint8Array(4)], "b.pdf", { type: "application/pdf" });
  let prevented = false;
  const done = handleImageTransfer({ preventDefault: () => (prevented = true) }, { files: [png, pdf] }, () => ({ start: 1, end: 1 }), d);
  expect(prevented).toBe(true);
  expect(state.maxBusy).toBe(2);
  resolvers.pdf();
  await Bun.sleep(0);
  resolvers.png();
  await done;
  expect(state.uploads).toBe(1);
  expect(state.attaches).toBe(1);
  expect(state.text).toBe("a\n![image](/s/a.png)\n[b.pdf](/att/b.pdf)\nb");
  expect(state.busy).toBe(0);
});

test("card-file-drop-ui: an oversized file is refused before any request, a failed one toasts with its name", async () => {
  const { d, state } = deps(
    "",
    async () => ({ path: "/p/x.png" }),
    async () => {
      throw new Error("boom");
    },
  );
  const big = new File([new Uint8Array(20 * 1024 * 1024 + 1)], "big.bin", { type: "application/octet-stream" });
  const log = new File([new Uint8Array(3)], "x.log", { type: "text/plain" });
  await handleImageTransfer({ preventDefault: () => {} }, { files: [big, log] }, () => ({ start: 0, end: 0 }), d);
  expect(state.attaches).toBe(1);
  expect(state.errors).toEqual(["big.bin dépasse 20 Mo", "Impossible de joindre x.log : boom"]);
  expect(state.text).toBe("");
});

test("transfer files keep every file, items first", () => {
  const pdf = new File([new Uint8Array(4)], "a.pdf", { type: "application/pdf" });
  const png = new File([new Uint8Array(4)], "a.png", { type: "image/png" });
  expect(transferFiles({ items: [textItem, { kind: "file", type: "application/pdf", getAsFile: () => pdf }], files: [png] })).toEqual([
    pdf,
  ]);
  expect(transferFiles({ items: [textItem], files: [png, pdf] })).toEqual([png, pdf]);
  expect(transferFiles(null)).toEqual([]);
});

test("feedback-file-drop: the feedback form and answers attach non-image files", () => {
  const feedback = readFileSync(join(import.meta.dir, "../src/web/FeedbackForm.tsx"), "utf8");
  expect(feedback).toContain("attach: (file) => api.uploadCardAttachment(project, cardId, file)");
  const modal = readFileSync(join(import.meta.dir, "../src/web/CardModal.tsx"), "utf8");
  expect(modal).toContain("attach={(file) => api.uploadCardAttachment(project, card.id, file)}");
  expect(modal).toContain("attach: (file) => api.uploadCardAttachment(project, card.id, file)");
  expect(modal).not.toContain("card.imageUnsupported");
});
