import type { EventLogger } from "../../EventLogger";
import { parseTTML } from "../lyrics/LyricTtml";
import { resolveLyricChain, type LyricTier } from "../lyrics/LyricSourceChain";
import { sanitizeLyrics } from "../lyrics/LyricSanitizer";
import {
  adoptVerbatimLyrics,
  mergeTranslations,
  parseLrc,
  parseYrc,
  type LyricChainInput,
} from "./NeteaseLyricParse";
import type { SongLyricLine } from "../../../shared/Index";

export interface NeteaseLyricChainDeps {
  logger?: EventLogger;
  getAmllTtmlLyrics: (songId: string) => Promise<string | undefined>;
  searchAmllTtmlLyrics: (songName: string, artistName?: string) => Promise<string | undefined>;
}

/** 网易云歌词的四级优先取法；各级的解析失败都只记告警、当作没命中。 */
export class NeteaseLyricChain {
  constructor(private readonly deps: NeteaseLyricChainDeps) {}

  /**
   * 按四级优先取歌词：官方 YRC 逐字 → AMLL 按网易云 ID → AMLL 按歌名搜索 → 普通 LRC 兜底。
   *
   * 逐级短路是硬约束：AMLL 是外部服务，前一级命中就绝不能多发后一级的请求。
   */
  async resolveSongLyrics(input: LyricChainInput): Promise<SongLyricLine[]> {
    const tiers: LyricTier[] = [
      {
        // 优先级 1：网易云官方 YRC 逐字歌词，命中即不碰任何第三方。
        run: () => ({
          lines: input.yrc ? (adoptVerbatimLyrics(parseYrc(input.yrc), input) ?? []) : [],
        }),
        onError: { message: "解析网易云 YRC 歌词失败", context: { songId: input.id } },
      },
      this.ttmlTier(input, () => this.deps.getAmllTtmlLyrics(input.id), {
        message: "解析 AMLL 网易云 ID 匹配 TTML 歌词失败",
        context: { songId: input.id },
      }),
    ];
    if (input.song.title) {
      tiers.push(
        this.ttmlTier(input, () => this.deps.searchAmllTtmlLyrics(input.song.title, input.song.artist), {
          message: "解析 AMLL 歌曲名搜索 TTML 歌词失败",
          context: { title: input.song.title },
        })
      );
    }
    tiers.push({
      // 优先级 4 兜底：网易云普通 LRC，只有行级时间轴（播放器按行滚动高亮）。
      run: () => ({ lines: this.parseLineLyrics(input) }),
      onError: { message: "解析网易云 LRC 歌词失败", context: { songId: input.id } },
    });
    return (await resolveLyricChain(tiers, this.deps.logger)).lines;
  }

  /** 拉一次 TTML 并解析；上游没有结果当作「这一级没命中」。 */
  private ttmlTier(
    input: LyricChainInput,
    fetchTtml: () => Promise<string | undefined>,
    onError: LyricTier["onError"]
  ): LyricTier {
    return {
      run: async () => {
        const ttmlRaw = await fetchTtml();
        return { lines: ttmlRaw ? (adoptVerbatimLyrics(parseTTML(ttmlRaw), input) ?? []) : [] };
      },
      onError,
    };
  }

  private parseLineLyrics(input: LyricChainInput): SongLyricLine[] {
    if (!input.lrc) return [];
    const merged = mergeTranslations(parseLrc(input.lrc), input.lrcTrans, input.lrcRoma);
    return sanitizeLyrics(merged, input.song);
  }
}
