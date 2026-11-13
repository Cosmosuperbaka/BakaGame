import { parseQrc as amllParseQrc, parseLrc as amllParseLrc } from "@applemusic-like-lyrics/lyric";
import qqmusic from "qqmusic-api-enhanced";
import type { EventLogger } from "../../EventLogger";
import { asRecord } from "../../JsonReaders";
import { fromAmllLines } from "../lyrics/AmllLineMapper";
import type { AmllLookup, AmllLyricClient } from "../lyrics/AmllLyricClient";
import { resolveLyricChain, type LyricTierOutcome } from "../lyrics/LyricSourceChain";
import { parseTTML } from "../lyrics/LyricTtml";
import { sanitizeLyrics } from "../lyrics/LyricSanitizer";
import { readString } from "./QQResponse";
import type { QQCallUpstream } from "./QQUpstream";
import type { SongLyricLine, SongSearchResult } from "../../../shared/SonGuessr";

/**
 * 从 XML 包裹的 QRC 中剥出 `LyricContent` 属性值；已是裸格式则原样返回。
 *
 * 属性值里的 `\n` 是字面量转义（XML 属性不能含真实换行），需还原成真实换行，
 * 否则所有行会被拼成一行。
 *
 * 必须「提取属性值」而非「剔除标签」：剥离标签的正则会把开标签、结尾自闭合
 * 与两者之间的整段歌词一并吃掉，结果为空。
 */
export const extractQrcPayload = (raw: string): string => {
  const attr = /LyricContent="([\s\S]*?)"/.exec(raw);
  const payload = attr ? attr[1] : raw;
  return payload.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
};

/**
 * 解析 QQ 音乐逐字歌词（QRC）。
 *
 * 上游有两种形态：裸 QRC 文本（`[行起,行长]字(起,长)...`），以及被
 * `<QrcInfos><LyricInfo><Lyric_1 LyricContent="...">` 包裹的 XML（解密后的原始返回）。
 * AMLL 的 `parseQrc` 只认裸格式，直接喂 XML 会得到空数组 —— 因此这里先剥出
 * `LyricContent` 属性值，再交给 `parseQrc`，两种形态都能解析。
 */
export const parseQrcLyrics = (raw: string): SongLyricLine[] => {
  if (!raw || !raw.trim()) return [];
  const normalized = extractQrcPayload(raw);
  try {
    return fromAmllLines(amllParseQrc(normalized));
  } catch {
    return [];
  }
};

export const parseLrcLyrics = (raw: string): SongLyricLine[] => {
  if (!raw || !raw.trim()) return [];
  try {
    const amllLines = amllParseLrc(raw);
    return amllLines
      .map((line) => {
        const text =
          line.words && line.words.length > 0
            ? line.words
                .map((w) => w.word)
                .join("")
                .trim()
            : "";
        return {
          time: line.startTime,
          endTime: line.endTime,
          text,
          translatedLyric: line.translatedLyric || undefined,
          romanLyric: line.romanLyric || undefined,
        };
      })
      .filter((line) => line.text.length > 0);
  } catch {
    return [];
  }
};

export interface QQLyricChainDeps {
  amllClient: AmllLyricClient;
  callUpstream: QQCallUpstream;
  logger?: EventLogger;
}

type LyricBase = Pick<SongSearchResult, "title" | "artist" | "album">;

/** QQ 歌词的优先取法：AMLL 按标识、AMLL 按歌名、平台逐字 QRC、普通 LRC。 */
export class QQLyricChain {
  private readonly amllClient: AmllLyricClient;
  private readonly callUpstream: QQCallUpstream;
  private readonly logger?: EventLogger;

  constructor(deps: QQLyricChainDeps) {
    this.amllClient = deps.amllClient;
    this.callUpstream = deps.callUpstream;
    this.logger = deps.logger;
  }

  /**
   * 严格遵循优先级标准：AMLL 官方 TTML > 平台原生逐字 (QRC) > 普通歌词 (LRC)。
   *
   * `onDegraded`：排在命中者之前的来源没取到（瞬态失败）时回调一次，调用方据此不把这份
   * 结果随元数据缓存——「确实没有」照常缓存，「没取到」下次重新回源。
   */
  async loadLyrics(
    mid: string,
    base: LyricBase,
    cookie?: string,
    onDegraded?: () => void
  ): Promise<SongLyricLine[]> {
    const { lines, degraded } = await resolveLyricChain(
      [
        {
          // 1. AMLL 官方歌词库通过 qqMusicId / mid 匹配
          run: async () =>
            this.adoptTtml(await this.amllClient.lookupTtmlLyrics(mid, { songId: mid }), base),
          onError: { message: "AMLL qqMusicId 匹配失败", context: { mid } },
        },
        {
          // 2. AMLL 官方歌词库按歌曲名与歌手检索
          run: async () =>
            this.adoptTtml(
              await this.amllClient.lookupTtmlLyricsBySearch(base.title, base.artist, {
                title: base.title,
              }),
              base
            ),
          onError: { message: "AMLL 歌曲名搜索匹配失败", context: { title: base.title } },
        },
        {
          // 3. 平台原生逐字歌词（QRC），4. 普通 LRC 降级：同一次上游请求
          run: () => this.loadNativeLyrics(mid, base, cookie),
          onError: { message: "QQ 音乐平台原生歌词拉取失败", context: { mid } },
        },
      ],
      this.logger
    );
    if (degraded) onDegraded?.();
    return lines;
  }

  private adoptTtml(lookup: AmllLookup, base: LyricBase): LyricTierOutcome {
    if (lookup.status === "failed") return { lines: [], failed: true };
    if (lookup.status === "missing") return { lines: [] };
    const parsed = parseTTML(lookup.ttml);
    if (parsed.length === 0) return { lines: [] };
    return { lines: sanitizeLyrics(parsed, base), settled: true };
  }

  private async loadNativeLyrics(
    mid: string,
    base: LyricBase,
    cookie?: string
  ): Promise<LyricTierOutcome> {
    const lyricRes = await this.callUpstream(cookie, async () =>
      qqmusic.lyric({ id: mid, qrc: true, cookie })
    );
    const body = asRecord(lyricRes.body);
    const rawQrc = readString(body.lyric);
    if (rawQrc?.includes("<QrcInfos>")) {
      const parsed = parseQrcLyrics(rawQrc);
      if (parsed.length > 0) return { lines: sanitizeLyrics(parsed, base), settled: true };
    }

    const rawLrc = readString(body.lyric) ?? readString(asRecord(body.raw).lyric);
    if (rawLrc) {
      const parsed = parseLrcLyrics(rawLrc);
      if (parsed.length > 0) return { lines: sanitizeLyrics(parsed, base), settled: true };
    }
    return { lines: [] };
  }
}
