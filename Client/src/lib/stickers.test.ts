import { describe, expect, it, vi } from "vitest";

vi.mock("virtual:sticker-manifest", () => ({
  default: { packs: [] },
}));

import { isValidStickerPath } from "./stickers";

describe("isValidStickerPath", () => {
  it("允许合法的本地表情包路径", () => {
    expect(isValidStickerPath("/emojis/default/cat.png")).toBe(true);
    expect(isValidStickerPath("/emojis/pack-1/dog_happy.gif")).toBe(true);
    expect(isValidStickerPath("/emojis/custom/smile.webp")).toBe(true);
  });

  it("拒绝外部 http/https URL 注入", () => {
    expect(isValidStickerPath("https://evil.com/track.png")).toBe(false);
    expect(isValidStickerPath("http://127.0.0.1:8000/bad.jpg")).toBe(false);
    expect(isValidStickerPath("//attacker.com/image.png")).toBe(false);
  });

  it("拒绝路径穿越和非图片扩展名", () => {
    expect(isValidStickerPath("/emojis/../secret.png")).toBe(false);
    expect(isValidStickerPath("/emojis/default/script.js")).toBe(false);
    expect(isValidStickerPath("javascript:alert(1)")).toBe(false);
    expect(isValidStickerPath(null)).toBe(false);
    expect(isValidStickerPath(undefined)).toBe(false);
  });
});
