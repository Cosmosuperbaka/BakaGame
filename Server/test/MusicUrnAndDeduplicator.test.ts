import { describe, expect, test } from "bun:test";
import {
  parseSongUrn,
  buildSongUrn,
  isSongUrn,
  type MusicPlatform,
} from "../src/infrastructure/MusicUrn";
import { toSimplified } from "../src/infrastructure/ChineseConverter";
import {
  normalizeComparableText,
  extractCanonicalTitle,
  extractArtistTokens,
  artistsOverlap,
  durationMatches,
  isSameSongWork,
  isDerivationSong,
  calculateRelevanceScore,
  aggregateAndDeduplicateSongs,
} from "../src/infrastructure/MusicDeduplicator";

describe("MusicUrn", () => {
  test("准确解析合法 URN (严格遵循网易与QQ前缀，零向下兼容)", () => {
    expect(parseSongUrn("netease:1899705498")).toEqual({
      platform: "netease",
      rawId: "1899705498",
    });

    expect(parseSongUrn("qq:0017K7gL4WYnw2")).toEqual({
      platform: "qq",
      rawId: "0017K7gL4WYnw2",
    });
  });

  test("对裸数字或无前缀ID严格抛出异常 (不保留任何兼容逻辑)", () => {
    expect(() => parseSongUrn("1899705498")).toThrow();
    expect(() => parseSongUrn("0017K7gL4WYnw2")).toThrow();
    expect(() => parseSongUrn("kugou:123")).toThrow();
    expect(() => parseSongUrn("")).toThrow();
  });

  test("格式化 URN", () => {
    expect(buildSongUrn("netease", "12345")).toBe("netease:12345");
    expect(buildSongUrn("qq", "001K0AjL2huSxx")).toBe("qq:001K0AjL2huSxx");
  });

  test("isSongUrn 校验", () => {
    expect(isSongUrn("netease:123")).toBe(true);
    expect(isSongUrn("qq:0017K7gL4WYnw2")).toBe(true);
    expect(isSongUrn("12345")).toBe(false);
    expect(isSongUrn("spotify:123")).toBe(false);
  });
});

describe("ChineseConverter", () => {
  test("繁体转简体", () => {
    expect(toSimplified("說好的幸福呢")).toBe("说好的幸福呢");
    expect(toSimplified("晴天")).toBe("晴天");
    expect(toSimplified("後來")).toBe("后来");
  });

  test("日文汉字与新字体转标准简体", () => {
    expect(toSimplified("極楽浄土")).toBe("极乐净土");
    expect(toSimplified("残酷な天使のテーゼ")).toBe("残酷な天使のテーゼ");
    expect(toSimplified("紅蓮華")).toBe("红莲华");
  });
});

describe("MusicDeduplicator", () => {
  test("normalizeComparableText 标点、空白与繁简归一", () => {
    expect(normalizeComparableText("ブルーバード (青鸟)")).toBe("ブルーバード青鸟");
    expect(normalizeComparableText("Only My Railgun!")).toBe("onlymyrailgun");
    expect(normalizeComparableText("極楽浄土")).toBe("极乐净土");
  });

  test("extractCanonicalTitle 剥离版本后缀与括号噪音", () => {
    expect(extractCanonicalTitle("晴天 (Live)")).toBe("晴天");
    expect(extractCanonicalTitle("晴天 - 伴奏")).toBe("晴天");
    expect(extractCanonicalTitle("稻香 (Remastered)")).toBe("稻香");
    expect(extractCanonicalTitle("借口(原唱：周杰伦)")).toBe("借口");
  });

  test("extractArtistTokens 歌手切分与别名互通", () => {
    expect(extractArtistTokens("周杰伦 / 费玉清")).toEqual(["周杰伦", "费玉清"]);
    expect(extractArtistTokens("DAOKO × 米津玄師")).toEqual(["daoko", "米津玄师"]);

    // 生物股长 <-> いきものがかり
    expect(artistsOverlap(["生物股长"], ["いきものがかり"])).toBe(true);

    // TK <-> TK from 凛として时雨
    expect(artistsOverlap(["tk"], ["tkfrom凛として时雨"])).toBe(true);

    // GARNiDELiA <-> 美依礼芽
    expect(artistsOverlap(["garnidelia"], ["美依礼芽"])).toBe(true);
  });

  test("durationMatches 物理时长容差门限", () => {
    expect(durationMatches(240000, 241500, 3000)).toBe(true);
    expect(durationMatches(240000, 244000, 3000)).toBe(false);
    expect(durationMatches(undefined, 240000, 3000)).toBe(true);
  });

  test("isSameSongWork 跨平台作品判定", () => {
    const qqSong = {
      id: "qq:0017K7gL4WYnw2",
      title: "反方向的钟",
      artist: "周杰伦",
      durationMs: 258000,
    };
    const neteaseSame = {
      id: "netease:12345",
      title: "反方向的钟 (2020 Remaster)",
      artist: "周杰倫",
      durationMs: 259000,
    };
    const differentSong = {
      id: "netease:99999",
      title: "Star (反方向的钟)",
      artist: "XMASwu(吴骜)",
      durationMs: 180000,
    };

    expect(isSameSongWork(qqSong, neteaseSame)).toBe(true);
    expect(isSameSongWork(qqSong, differentSong)).toBe(false);
  });

  test("isDerivationSong 识别衍生与伴奏/翻唱版本", () => {
    expect(isDerivationSong({ id: "1", title: "晴天 (伴奏)", artist: "周杰伦" })).toBe(true);
    expect(isDerivationSong({ id: "2", title: "借口(原唱：周杰伦)", artist: "网络歌手" })).toBe(true);
    expect(isDerivationSong({ id: "3", title: "晴天", artist: "网络歌手" })).toBe(true);
    expect(isDerivationSong({ id: "4", title: "晴天", artist: "周杰伦", originCoverType: 2 })).toBe(true);
    expect(isDerivationSong({ id: "5", title: "晴天", artist: "周杰伦" })).toBe(false);
  });

  test("calculateRelevanceScore 评分权重严密性", () => {
    // 主标题完全匹配严格高于括号内副标题匹配
    const mainMatch = calculateRelevanceScore(
      { id: "qq:1", title: "反方向的钟", artist: "周杰伦", upstreamRank: 0 },
      "反方向的钟",
      false
    );
    const subMatch = calculateRelevanceScore(
      { id: "netease:2", title: "Star (反方向的钟)", artist: "XMASwu", upstreamRank: 0 },
      "反方向的钟",
      false
    );
    expect(mainMatch).toBeGreaterThan(subMatch);

    // Rank 0 单源独占原版严格高于 Rank 2 的双源杂散歌曲
    const rank0Single = calculateRelevanceScore(
      { id: "qq:jay", title: "借口", artist: "周杰伦", upstreamRank: 0 },
      "借口",
      false
    );
    const rank2Dual = calculateRelevanceScore(
      { id: "qq:indie", title: "借口", artist: "枕星而歌", upstreamRank: 2 },
      "借口",
      true
    );
    expect(rank0Single).toBeGreaterThan(rank2Dual);
  });

  test("aggregateAndDeduplicateSongs 聚合去重与置顶排序", () => {
    const raw = [
      {
        id: "netease:1899705498",
        title: "Star (反方向的钟)",
        artist: "XMASwu(吴骜)",
        durationMs: 180000,
        upstreamRank: 0,
      },
      {
        id: "qq:0017K7gL4WYnw2",
        title: "反方向的钟",
        artist: "周杰伦",
        durationMs: 258000,
        upstreamRank: 0,
      },
    ];

    const results = aggregateAndDeduplicateSongs(raw, "反方向的钟", 10);
    expect(results[0]?.title).toBe("反方向的钟");
    expect(results[0]?.artist).toBe("周杰伦");
  });
});
