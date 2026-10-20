import { describe, expect, it, vi } from "vitest";

vi.mock("virtual:sticker-manifest", () => ({
  default: {
    packs: [
      {
        name: "夜愿华章",
        dir: "nightwish",
        preview: "/emojis/nightwish/audience_clap.gif",
        animated: true,
        items: [
          {
            key: "audience_clap",
            label: "鼓掌",
            path: "/emojis/nightwish/audience_clap.gif",
            animated: true,
          },
          {
            key: "ghost_laugh",
            label: "冷笑",
            path: "/emojis/nightwish/ghost_laugh.png",
            animated: false,
          },
        ],
      },
    ],
  },
}));

import { isValidStickerPath, loadStickerLabels, loadStickerPacks } from "./Stickers";

describe("isValidStickerPath", () => {
  it("允许合法的本地表情包路径", () => {
    expect(isValidStickerPath("/emojis/default/cat.png")).toBe(true);
    expect(isValidStickerPath("/stickers/3b86f74e1fb1e33b0c58743f.gif")).toBe(true);
    expect(isValidStickerPath("/stickers/custom_smile.webp")).toBe(true);
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

describe("loadStickerLabels", () => {
  it("从同一份清单建出「资源路径 → 表情名」索引", async () => {
    const labels = await loadStickerLabels();

    expect(labels.get("/emojis/nightwish/audience_clap.gif")).toBe("鼓掌");
    expect(labels.get("/emojis/nightwish/ghost_laugh.png")).toBe("冷笑");
    expect(labels.get("/emojis/nightwish/not-in-manifest.png")).toBeUndefined();
    expect(labels.size).toBe((await loadStickerPacks())[0].items.length);
  });

  it("索引只建一次并常驻，重复调用不重新解析清单", async () => {
    expect(await loadStickerLabels()).toBe(await loadStickerLabels());
  });
});
