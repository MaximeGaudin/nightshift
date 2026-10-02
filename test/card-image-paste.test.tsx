import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { handleImagePaste, type ImagePasteDeps, insertImageBlock, type PasteEventLike } from "../src/web/imagePaste.ts";

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
function deps(text: string, upload: ImagePasteDeps["upload"]) {
  const state = { text, cursor: -1, errors: [] as string[], busy: 0, maxBusy: 0, uploads: 0 };
  const d: ImagePasteDeps = {
    upload: (image) => {
      state.uploads++;
      return upload(image);
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

test("paste refuses unsupported or oversized images before any request, others still insert", async () => {
  const { d, state } = deps("", async () => ({ path: "/p/ok.png" }));
  await handleImagePaste(paste([fileItem("image/svg+xml"), fileItem("image/png", 8 * 1024 * 1024 + 1), fileItem("image/png")], 0).e, d);
  expect(state.uploads).toBe(1);
  expect(state.errors).toEqual(["Type d'image non pris en charge (PNG, JPEG, GIF ou WebP)", "L'image dépasse 8 Mo"]);
  expect(state.text).toBe("![image](/p/ok.png)");
});

test("card modal wires the paste handler and the uploading hint", () => {
  const src = readFileSync(join(import.meta.dir, "../src/web/CardModal.tsx"), "utf8");
  expect(src).toContain("onPaste={(e) =>");
  expect(src).toContain("api.uploadCardImage(project, card.id, image)");
  expect(src).toContain('t("card.uploadingImage")');
});
