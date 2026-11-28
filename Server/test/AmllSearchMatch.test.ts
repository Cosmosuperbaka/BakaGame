import { describe, expect, test } from "bun:test";
import {
  isAmllSearchItemMatch,
  isSameRecordingTitle,
} from "../src/infrastructure/music/lyrics/AmllSearchMatch";
import { NeteaseMusicProvider } from "../src/infrastructure/music/netease/NeteaseMusicProvider";
import { amllTtmlFixture } from "./netease/Fixtures";

/** 条目形状取自 AMLL 检索接口的真实返回（只保留参与判定的字段）。 */
const item = (
  id: string,
  musicNames: string[],
  artistNames: string[],
  albumNames: string[] = []
) => ({
  id,
  musicNames,
  artistNames,
  albumNames,
});

describe("AMLL 检索条目的曲名判定", () => {
  test.each([
    ["完全相同", "晴天", "晴天", true],
    ["标点与全半角差异", "もってけ！セーラーふく", "もってけ!セーラーふく", true],
    [
      "日文波浪线两种写法",
      "secret base 〜君がくれたもの〜",
      "secret base ～君がくれたもの～",
      true,
    ],
    ["括号里的译名", "ブルーバード (青鸟)", "ブルーバード", true],
    ["括号里的出处说明", "小幸运 (电影《我的少女时代》主题曲)", "小幸运", true],
    ["现场版不能借用录音室版", "晴天 (Live)", "晴天", false],
    ["Remix 不能借用原版", "稻香", "稻香 (Remix摇滚版)", false],
    ["两侧括号段不同", "Song (Part 1)", "Song (Part 2)", false],
    ["带编次标记的括号段不是说明文字", "Song (Part 1)", "Song", false],
    ["带集数的出处说明判不准，宁可错过", "Song (TV动画第2-14集片头曲)", "Song", false],
    ["不同的歌", "七里香", "将军", false],
    ["纯符号曲名无可比内容", "！！！", "！！！", false],
  ])("%s", (_name, left, right, expected) => {
    expect(isSameRecordingTitle(left, right)).toBe(expected);
    expect(isSameRecordingTitle(right, left)).toBe(expected);
  });
});

describe("AMLL 检索条目整体判定", () => {
  test("同专辑的别的歌被检索召回时不采纳（专辑名恰好等于本曲名）", () => {
    const general = item("1", ["General", "将军", "將軍"], ["Jay Chou", "周杰伦"], ["七里香"]);
    expect(isAmllSearchItemMatch(general, "七里香", "周杰伦")).toBe(false);
  });

  test("曲名任一登记写法对得上、歌手繁简互通即采纳", () => {
    const sunny = item("2", ["晴天"], ["周杰伦"], ["叶惠美"]);
    expect(isAmllSearchItemMatch(sunny, "晴天", "周杰倫")).toBe(true);
    const happiness = item("3", ["A Little Happiness", "小幸运"], ["Hebe", "田馥甄"]);
    expect(isAmllSearchItemMatch(happiness, "小幸运", "Hebe Tien / 田馥甄")).toBe(true);
  });

  test("同名但歌手无交集不采纳", () => {
    const cover = item("4", ["晴天"], ["某翻唱歌手"]);
    expect(isAmllSearchItemMatch(cover, "晴天", "周杰伦")).toBe(false);
  });

  test("歌手缺失或是占位文本时只看曲名", () => {
    const sunny = item("5", ["晴天"], ["周杰伦"]);
    expect(isAmllSearchItemMatch(sunny, "晴天", undefined)).toBe(true);
    expect(isAmllSearchItemMatch(sunny, "晴天", "未知歌手")).toBe(true);
    // 合辑的通用署名同样不指向真实歌手。
    expect(isAmllSearchItemMatch(sunny, "晴天", "群星")).toBe(true);
    expect(isAmllSearchItemMatch(sunny, "晴天", "Various Artists")).toBe(true);
    expect(isAmllSearchItemMatch(item("6", ["晴天"], []), "晴天", "周杰伦")).toBe(true);
  });

  test("条目没有登记曲名时无法确认，不采纳", () => {
    expect(isAmllSearchItemMatch({ id: "7" }, "晴天", "周杰伦")).toBe(false);
  });
});

describe("AMLL 按歌名检索经由 provider", () => {
  test("跳过同专辑的别的歌，取曲名歌手都对得上的条目正文", async () => {
    const urls: string[] = [];
    const provider = new NeteaseMusicProvider({
      amllFetcher: async (url) => {
        urls.push(url);
        if (url.includes("search?")) {
          return Response.json({
            status: 200,
            data: {
              items: [
                item("general", ["General", "将军"], ["周杰伦"], ["七里香"]),
                item("jasmine", ["七里香", "Common Jasmine Orange"], ["周杰伦"], ["七里香"]),
              ],
            },
          });
        }
        return Response.json({ status: 200, data: { lyrics: amllTtmlFixture() } });
      },
    });

    expect(await provider.searchAmllTtmlLyrics("七里香", "周杰伦")).toBe(amllTtmlFixture());
    expect(urls.at(-1)).toContain("get?id=jasmine");
    expect(urls.some((url) => url.includes("get?id=general"))).toBe(false);
  });

  test("没有对得上的条目时当作没有，不取任何正文", async () => {
    const urls: string[] = [];
    const provider = new NeteaseMusicProvider({
      amllFetcher: async (url) => {
        urls.push(url);
        return Response.json({
          status: 200,
          data: { items: [item("remix", ["稻香 (Remix摇滚版)"], ["周杰伦"])] },
        });
      },
    });

    expect(await provider.searchAmllTtmlLyrics("稻香", "周杰伦")).toBeUndefined();
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("search?");
  });
});
