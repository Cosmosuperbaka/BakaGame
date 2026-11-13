import { asArray, asRecord, readString } from "../../JsonReaders";
import type { MusicCookieInput } from "../MusicProvider";
import { raceWithTimeout } from "../RaceTimeout";
import type { NeteaseApiGateway } from "./NeteaseApiGateway";
import { normalizeAudioUrl, responseBody } from "./NeteaseResponse";
import type { NeteaseMusicProviderOptions } from "./NeteaseTypes";

/**
 * 解灰音源优先级。包内 `matchID` 不传 `source` 时按 modules 目录的字母序尝试，`bugpk` 恰好排在最前，
 * 而它对没有自有音源的歌曲会返回网易云官方灰链兜底（`/song/media/outer/url`）：字符串非空所以被当成
 * 「解灰成功」，实际播放器只会拿到下载页 HTML，还会短路掉后面真正可用的音源。
 * 这里显式指定顺序：多平台音源 `unm` 放最前，能快速失败的放中间，慢且易伪解灰的 `bugpk` 压到最后。
 */
const UNBLOCK_SOURCE_ORDER = [
  "unm",
  "ddyr",
  "gdmusic",
  "byfuns",
  "msls",
  "oi",
  "qijieya",
  "bugpk",
] as const;
/** 单个解灰音源的最长等待。 */
const DEFAULT_UNBLOCK_SOURCE_TIMEOUT_MS = 4_000;
/** 一次解灰尝试的总预算；用尽后不再换源，直接判定解灰失败。 */
const DEFAULT_UNBLOCK_TOTAL_BUDGET_MS = 12_000;

/**
 * 给上游 Promise 加一个上界。
 *
 * 解灰音源（尤其第三方聚合站）存在「请求被丢弃、返回的 Promise 永不 settle」的情况。
 * 一旦在 `await` 上无限等待，自动出题会永久停在 `automaticRoundLoading`：房间再也开不了下一轮，
 * 客户端因为对长任务发的是 `timeout: 0`，连超时提示都没有。
 *
 * 必须同时给原 Promise 挂上 `catch`：它在超时之后才拒绝时，若没有处理器就会变成
 * unhandledRejection —— Bun 会直接终止整个进程。
 */
const settleWithin = <T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> =>
  raceWithTimeout(
    promise.catch(() => fallback),
    timeoutMs,
    () => fallback
  );

/**
 * 识别「伪解灰」：解灰结果指回网易云官方外链 `/song/media/outer/url`。
 * 该外链只对未受限歌曲有效，受限歌曲会 302 到下载页 HTML（`content-type: text/html`），
 * 播放器必然报错。解灰只在官方明确受限（无地址 / 试听片段 / 404）时才触发，
 * 因此在这个语境下拿到该形态一律视为解灰失败，应继续尝试下一个音源，不得写入缓存或广播。
 */
const isNeteaseFallbackUrl = (raw: string): boolean => {
  try {
    const url = new URL(raw);
    if (url.hostname !== "music.163.com") return false;
    return url.pathname.startsWith("/song/media/outer/url");
  } catch {
    return false;
  }
};

/** 全局音乐解灰：官方接口无可用地址时，按显式优先级逐个音源换取可播放直链。 */
export class NeteaseAudioUnblocker {
  private readonly generalUnblockEnabled: () => boolean;

  /**
   * 把开关值写回 `process.env.ENABLE_GENERAL_UNBLOCK`：
   * 上游封装库读的是那一份，不同步的话后台改了这里、上游那边仍按旧值走。
   * 只在构造与受限歌曲的解灰判定这两处做，开关本身的读取（`generalUnblockEnabled`）没有副作用。
   */
  private syncLibraryEnv(enabled: boolean): void {
    if (
      typeof process !== "undefined" &&
      process.env &&
      process.env.ENABLE_GENERAL_UNBLOCK !== String(enabled)
    ) {
      process.env.ENABLE_GENERAL_UNBLOCK = String(enabled);
    }
  }

  constructor(
    private readonly gateway: NeteaseApiGateway,
    private readonly options: NeteaseMusicProviderOptions,
    private readonly now: () => number
  ) {
    const unblockOption = options.enableGeneralUnblock;
    this.generalUnblockEnabled =
      typeof unblockOption === "function"
        ? unblockOption
        : () =>
            unblockOption ??
            (typeof process !== "undefined" && process.env?.ENABLE_GENERAL_UNBLOCK !== undefined
              ? process.env.ENABLE_GENERAL_UNBLOCK === "true"
              : true);
    this.syncLibraryEnv(this.generalUnblockEnabled());
  }

  /** 受限歌曲的解灰入口：按当时的开关值同步环境变量；开关关闭时不发起解灰，返回空串。 */
  async unblockIfEnabled(songId: string, cookie?: MusicCookieInput): Promise<string> {
    const enabled = this.generalUnblockEnabled();
    this.syncLibraryEnv(enabled);
    if (!enabled) return "";
    return this.unblockSongAudio(songId, cookie);
  }

  private async unblockSongAudio(songId: string, cookie?: MusicCookieInput): Promise<string> {
    const sourceTimeoutMs =
      this.options.unblockSourceTimeoutMs ?? DEFAULT_UNBLOCK_SOURCE_TIMEOUT_MS;
    const deadline =
      this.now() + (this.options.unblockTotalBudgetMs ?? DEFAULT_UNBLOCK_TOTAL_BUDGET_MS);

    // 1. 按显式优先级逐个音源调用 song_url_match，跳过伪解灰结果。
    //    必须显式传 source：不传时包内按目录字母序尝试，bugpk 排在最前且会返回网易云灰链兜底，
    //    字符串非空被误判为成功，导致 unm 等真正可用的音源永远得不到机会。
    //    每个音源都必须带上界，否则一个被丢弃的请求就足以把整轮出题钉死（见 settleWithin）。
    for (const source of UNBLOCK_SOURCE_ORDER) {
      if (this.now() >= deadline) break;
      const matchResponse = await settleWithin(
        this.gateway.callOptional(["song_url_match"], { id: songId, source }, cookie),
        sourceTimeoutMs,
        undefined
      );
      if (!matchResponse) continue;
      const body = responseBody(matchResponse);
      const url = readString(body.data) ?? readString(body.proxyUrl);
      const normalized = normalizeAudioUrl(url);
      if (normalized && !isNeteaseFallbackUrl(normalized)) return normalized;
    }

    // 2. 尝试 song_url_v1 带 unblock 参数解灰
    const v1Response = await settleWithin(
      this.gateway.callOptional(
        ["song_url_v1"],
        { id: songId, level: "standard", unblock: "true" },
        cookie
      ),
      sourceTimeoutMs,
      undefined
    );
    if (v1Response) {
      const body = responseBody(v1Response);
      const songData = asRecord(asArray(body.data)[0]);
      const url = readString(songData.url) ?? readString(songData.proxyUrl);
      const normalized = normalizeAudioUrl(url);
      if (normalized && !isNeteaseFallbackUrl(normalized)) return normalized;
    }

    return "";
  }
}
