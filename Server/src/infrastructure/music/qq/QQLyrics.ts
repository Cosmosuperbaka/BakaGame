import { parseQrc as amllParseQrc, parseLrc as amllParseLrc } from "@applemusic-like-lyrics/lyric";
import qqmusic from "qqmusic-api-enhanced";
import { describeError, type EventLogger } from "../../EventLogger";
import { asRecord } from "../../JsonReaders";
import type { AmllLyricClient } from "../lyrics/AmllLyricClient";
import { parseTTML, sanitizeLyrics } from "../lyrics/LyricLines";
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
    const amllLines = amllParseQrc(normalized);
    return amllLines
      .map((line) => {
        const text =
          line.words && line.words.length > 0
            ? line.words
                .map((w) => w.word)
                .join("")
                .trim()
            : "";
        const hasTranslation = Boolean(line.translatedLyric);
        return {
          time: line.startTime,
          endTime: line.endTime,
          text,
          words:
            line.words && line.words.length > 0
              ? line.words.map((w) => ({
                  startTime: w.startTime,
                  endTime: w.endTime,
                  word: w.word,
                  romanWord: hasTranslation ? undefined : w.romanWord || undefined,
                }))
              : undefined,
          translatedLyric: line.translatedLyric || undefined,
          romanLyric: hasTranslation ? undefined : line.romanLyric || undefined,
          isBG: line.isBG || undefined,
          isDuet: line.isDuet || undefined,
        };
      })
      .filter((line) => line.text.length > 0);
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

/** QQ 歌词的四级优先取法：AMLL 按标识、AMLL 按歌名、平台逐字 QRC、普通 LRC。 */
export class QQLyricChain {
  private readonly amllClient: AmllLyricClient;
  private readonly callUpstream: QQCallUpstream;
  private readonly options: { logger?: EventLogger };

  constructor(deps: QQLyricChainDeps) {
    this.amllClient = deps.amllClient;
    this.callUpstream = deps.callUpstream;
    this.options = { logger: deps.logger };
  }

  async loadLyrics(
    mid: string,
    base: Pick<SongSearchResult, "title" | "artist" | "album">,
    cookie?: string
  ): Promise<SongLyricLine[]> {
    // 严格遵循优先级标准：AMLL 官方 TTML > 平台原生逐字 (QRC) > 普通歌词 (LRC)

    // 1. 尝试 AMLL 官方歌词库通过 qqMusicId / mid 匹配
    try {
      const ttmlById = await this.amllClient.getTtmlLyrics(mid, { songId: mid });
      if (ttmlById) {
        const parsed = parseTTML(ttmlById);
        if (parsed.length > 0) {
          return sanitizeLyrics(parsed, base);
        }
      }
    } catch (error) {
      this.options.logger?.warn?.("AMLL qqMusicId 匹配失败", { mid, ...describeError(error) });
    }

    // 2. 尝试 AMLL 官方歌词库按歌曲名与歌手检索
    try {
      const ttmlBySearch = await this.amllClient.searchTtmlLyrics(base.title, base.artist, {
        title: base.title,
      });
      if (ttmlBySearch) {
        const parsed = parseTTML(ttmlBySearch);
        if (parsed.length > 0) {
          return sanitizeLyrics(parsed, base);
        }
      }
    } catch (error) {
      this.options.logger?.warn?.("AMLL 歌曲名搜索匹配失败", {
        title: base.title,
        ...describeError(error),
      });
    }

    // 3. 尝试 QQ 音乐原生逐字歌词 (QRC via parseQrc)
    try {
      const lyricRes = await this.callUpstream(cookie, async () =>
        qqmusic.lyric({ id: mid, qrc: true, cookie })
      );
      const body = asRecord(lyricRes.body);
      const rawQrc = readString(body.lyric);
      if (rawQrc?.includes("<QrcInfos>")) {
        const parsed = parseQrcLyrics(rawQrc);
        if (parsed.length > 0) {
          return sanitizeLyrics(parsed, base);
        }
      }

      // 4. 普通 LRC 歌词降级
      const rawLrc = readString(body.lyric) ?? readString(asRecord(body.raw).lyric);
      if (rawLrc) {
        const parsed = parseLrcLyrics(rawLrc);
        if (parsed.length > 0) {
          return sanitizeLyrics(parsed, base);
        }
      }
    } catch (error) {
      this.options.logger?.warn?.("QQ 音乐平台原生歌词拉取失败", { mid, ...describeError(error) });
    }

    return [];
  }
}
