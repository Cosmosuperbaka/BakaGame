import { describeError, type EventLogger } from "../../EventLogger";
import { parseTTML, sanitizeLyrics } from "../lyrics/LyricLines";
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
    const yrc = this.parseNeteaseYrcLyrics(input);
    if (yrc.length > 0) return yrc;

    const byId = await this.withTtmlLyrics(input, () => this.deps.getAmllTtmlLyrics(input.id), {
      log: "解析 AMLL 网易云 ID 匹配 TTML 歌词失败",
      context: { songId: input.id },
    });
    if (byId.length > 0) return byId;

    if (!input.song.title) return this.parseNeteaseLineLyrics(input);
    const byTitle = await this.withTtmlLyrics(
      input,
      () => this.deps.searchAmllTtmlLyrics(input.song.title, input.song.artist),
      { log: "解析 AMLL 歌曲名搜索 TTML 歌词失败", context: { title: input.song.title } }
    );
    return byTitle.length > 0 ? byTitle : this.parseNeteaseLineLyrics(input);
  }

  /** 拉一次 TTML 并解析；上游失败或没有结果都当作「这一级没命中」，只记告警。 */
  private async withTtmlLyrics(
    input: LyricChainInput,
    fetchTtml: () => Promise<string | undefined>,
    failure: { log: string; context: Record<string, unknown> }
  ): Promise<SongLyricLine[]> {
    try {
      const ttmlRaw = await fetchTtml();
      return ttmlRaw ? (adoptVerbatimLyrics(parseTTML(ttmlRaw), input) ?? []) : [];
    } catch (err) {
      this.deps.logger?.warn?.(failure.log, { ...failure.context, ...describeError(err) });
      return [];
    }
  }

  /** 优先级 1：网易云官方 YRC 逐字歌词，命中即不碰任何第三方。 */
  private parseNeteaseYrcLyrics(input: LyricChainInput): SongLyricLine[] {
    if (!input.yrc) return [];
    try {
      return adoptVerbatimLyrics(parseYrc(input.yrc), input) ?? [];
    } catch (err) {
      this.deps.logger?.warn?.("解析网易云 YRC 歌词失败", {
        songId: input.id,
        ...describeError(err),
      });
      return [];
    }
  }

  /** 优先级 4 兜底：网易云普通 LRC，只有行级时间轴（播放器按行滚动高亮）。 */
  private parseNeteaseLineLyrics(input: LyricChainInput): SongLyricLine[] {
    if (!input.lrc) return [];
    try {
      const merged = mergeTranslations(parseLrc(input.lrc), input.lrcTrans, input.lrcRoma);
      return sanitizeLyrics(merged, input.song);
    } catch (err) {
      this.deps.logger?.warn?.("解析网易云 LRC 歌词失败", {
        songId: input.id,
        ...describeError(err),
      });
      return [];
    }
  }
}
