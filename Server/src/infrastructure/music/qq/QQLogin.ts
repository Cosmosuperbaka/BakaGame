import { LRUCache } from "lru-cache";
import qqmusic from "qqmusic-api-enhanced";
import { AppError } from "../../../domain/Errors";
import { describeError, type EventLogger } from "../../EventLogger";
import { asRecord, readNumber } from "../../JsonReaders";
import type { MusicCookieInput, MusicLoginSession, MusicQrLogin, MusicQrLoginCheck } from "../MusicProvider";
import { audioCacheScope, extractQqCookie } from "./QQCookie";
import { readString, readText } from "./QQResponse";
import type { QQCallUpstream } from "./QQUpstream";

const LOGIN_STATUS_CACHE_TTL_MS = 2 * 60 * 1000;
/** 登录态复用缓存的条目上限；每个玩家一份，超出按 LRU 淘汰。 */
const LOGIN_STATUS_CACHE_MAX_ENTRIES = 512;

export interface QQLoginDeps {
  callUpstream: QQCallUpstream;
  logger?: EventLogger;
}

/** QQ 音乐扫码登录、登录态校验与续期；登录态复用缓存与在途合并状态都在本类里。 */
export class QQLogin {
  /** 登录态复用与网易云同口径：普通 LRU + 单 TTL，不进软/硬双 TTL 的公共缓存。 */
  private readonly loginStatusCache: LRUCache<string, MusicLoginSession>;
  /** 同一凭据、同一模式的在途校验共用一次回源；键是指纹，Cookie 原文不留在任何 Map 里。 */
  private readonly loginStatusInFlight = new Map<string, Promise<MusicLoginSession>>();
  private readonly callUpstream: QQCallUpstream;
  private readonly options: { logger?: EventLogger };

  constructor(deps: QQLoginDeps) {
    this.callUpstream = deps.callUpstream;
    this.options = { logger: deps.logger };
    this.loginStatusCache = new LRUCache<string, MusicLoginSession>({
      max: LOGIN_STATUS_CACHE_MAX_ENTRIES,
      ttl: LOGIN_STATUS_CACHE_TTL_MS,
    });
  }

  async createQrLogin(
    _platform?: "netease" | "qq",
    type: "qq" | "wx" | "mobile" = "qq"
  ): Promise<MusicQrLogin> {
    const qrType = type || "qq";
    // QQ 和微信二维码走独立的登录域名，不占用 musicu 的限流队列；
    // App 二维码要调 musicu 的 CreateQRCode，并开一条实时通道，必须继续排队限速。
    const create = () => qqmusic.login_qr_create({ type: qrType });
    let res: Awaited<ReturnType<typeof qqmusic.login_qr_create>>;
    try {
      res = qrType === "mobile" ? await this.callUpstream(undefined, create) : await create();
    } catch (error) {
      if (error instanceof AppError) throw error;
      this.options.logger?.warn?.("QQ 音乐登录二维码生成失败", { qrType, ...describeError(error) });
      throw new AppError("MUSIC_LOGIN_FAILED", "无法生成登录二维码，请稍后重试");
    }
    const body = asRecord(res.body);
    if (qrType === "qq") {
      const qrsig = readText(body.qrsig);
      const ptqrtoken = readText(body.ptqrtoken);
      const qrImage = readText(body.qrimg);
      if (!qrsig || !ptqrtoken || !qrImage) {
        throw new AppError("MUSIC_LOGIN_FAILED", "无法生成登录二维码，请稍后重试");
      }
      return { key: `${qrsig}:::${ptqrtoken}`, qrUrl: readText(body.url), qrImage };
    }
    if (qrType === "wx") {
      const uuid = readText(body.uuid);
      if (!uuid) throw new AppError("MUSIC_LOGIN_FAILED", "无法生成微信登录二维码，请稍后重试");
      const qrurl = readString(body.qrurl) || `https://open.weixin.qq.com/connect/qrcode/${uuid}`;
      return { key: uuid, qrUrl: qrurl, qrImage: qrurl };
    }
    const qrcodeID = readText(body.qrcodeID);
    const qrImage = readText(body.qrcode);
    if (!qrcodeID || !qrImage) {
      throw new AppError("MUSIC_LOGIN_FAILED", "无法生成登录二维码，请稍后重试");
    }
    return { key: qrcodeID, qrUrl: "https://y.qq.com", qrImage };
  }

  async checkQrLogin(
    key: string,
    _platform?: "netease" | "qq",
    type: "qq" | "wx" | "mobile" = "qq"
  ): Promise<MusicQrLoginCheck> {
    const qrType = type || "qq";
    const [qrsig, ptqrtoken] = key.split(":::");
    let res: Awaited<ReturnType<typeof qqmusic.login_qr_check>>;
    try {
      res = await qqmusic.login_qr_check(
        qrType === "qq"
          ? { type: "qq", qrsig, ptqrtoken: ptqrtoken || undefined }
          : qrType === "wx"
            ? { type: "wx", uuid: key }
            : { type: "mobile", qrcodeID: key }
      );
    } catch (error) {
      // 轮询自身的瞬时异常不等于二维码作废：继续等，下一轮重试。
      this.options.logger?.debug?.("QQ 音乐扫码轮询异常，按等待处理", {
        qrType,
        ...describeError(error),
      });
      return { status: "waiting", message: "等待扫码" };
    }
    const body = asRecord(res.body);

    const code = readNumber(body.code);
    if (code === 200) {
      const cookieStr = readString(body.cookieStr) ?? "";
      if (!cookieStr) {
        throw new AppError("MUSIC_LOGIN_FAILED", "扫码成功但未取得登录凭证，请重新扫码");
      }
      let session: MusicLoginSession;
      try {
        session = await this.resolveLoginSession(cookieStr, {});
      } catch (error) {
        if (error instanceof AppError && error.code === "MUSIC_SESSION_INVALID") {
          // 凭证刚签发就校验不过：说明扫码链路拿到的是无效凭证，而不是“旧登录态过期”。
          // 单独标记，避免玩家看到笼统的“登录状态已失效”而不知道该重新扫码。
          this.options.logger?.warn?.("QQ 音乐扫码登录后凭证校验未通过", { qrType });
          throw new AppError("MUSIC_LOGIN_FAILED", "扫码已通过但 QQ 音乐校验未通过，请重新扫码");
        }
        throw error;
      }
      return {
        status: "authorized",
        message: "登录成功",
        session,
      };
    }
    if (code === 800) {
      return { status: "expired", message: "二维码已过期，请点击刷新" };
    }
    if (code === 802 || code === 67) {
      return { status: "scanned", message: "已扫码，等待确认" };
    }
    if (code === 803) {
      throw new AppError("MUSIC_LOGIN_CANCELLED", "已在手机上取消登录，请重新扫码");
    }
    if (code === 500) throw this.qrProtocolError(qrType, body);
    return { status: "waiting", message: readString(body.message) ?? "等待扫码" };
  }

  /** 上游协议失败 → 业务异常：保留阶段与上游码进日志，面向玩家的文案按原因区分。 */
  private qrProtocolError(qrType: string, body: Record<string, unknown>): AppError {
    const reason = readString(body.reason) ?? "protocol";
    const stage = readString(body.stage) ?? "unknown";
    const upstreamCode = readNumber(body.upstreamCode);
    this.options.logger?.warn?.("QQ 音乐扫码登录协议失败", {
      qrType,
      stage,
      reason,
      upstreamCode,
      detail: body.detail,
    });
    if (reason === "rate_limited") {
      return new AppError("MUSIC_LOGIN_RISK", "QQ 音乐暂时拒绝了本次登录，请稍后重新扫码", {
        upstreamCode,
      });
    }
    const message =
      reason === "auth_invalid"
        ? "本次扫码授权已失效，请重新扫码"
        : reason === "device_limit"
          ? "该账号登录设备数量已达上限，请先在 QQ 音乐中下线其他设备"
          : reason === "account_restricted"
            ? "该账号当前被 QQ 音乐限制登录"
            : `QQ 音乐登录接口异常（${stage}），请稍后重新扫码`;
    return new AppError("MUSIC_LOGIN_FAILED", message, { upstreamCode });
  }

  async getLoginStatus(
    rawCookie: MusicCookieInput,
    _platform?: "netease" | "qq",
    options: { forceRefresh?: boolean } = {}
  ): Promise<MusicLoginSession> {
    return this.resolveLoginSession(rawCookie, options);
  }

  private async resolveLoginSession(
    rawCookie: MusicCookieInput,
    options: { forceRefresh?: boolean }
  ): Promise<MusicLoginSession> {
    const extracted = extractQqCookie(rawCookie);
    const currentCookie = extracted ?? (typeof rawCookie === "string" ? rawCookie : "");
    const trimmed = currentCookie.trim();
    if (!trimmed) {
      throw new AppError("MUSIC_SESSION_INVALID", "QQ 音乐登录 Cookie 不能为空");
    }

    const cacheKey = this.loginStatusKey(trimmed);
    // 强制续期必须绕过缓存：缓存里是上一次校验结果，不会替我们换新 key。
    const reused = options.forceRefresh ? undefined : this.loginStatusCache.get(cacheKey);
    if (reused) {
      return { cookie: reused.cookie, account: { ...reused.account } };
    }

    // 房间接入、开局复验与后台续期会同时到达：同凭据的在途校验合并，
    // 否则续期接口被并行打两次，一次性的 refresh 凭据会让后一次失败。
    const flightKey = `${cacheKey}:${options.forceRefresh ? "refresh" : "check"}`;
    let flight = this.loginStatusInFlight.get(flightKey);
    if (!flight) {
      flight = this.verifyLoginSession(currentCookie, trimmed, options).finally(() => {
        this.loginStatusInFlight.delete(flightKey);
      });
      this.loginStatusInFlight.set(flightKey, flight);
    }
    const session = await flight;
    // 对齐网易云：返回副本，调用方对返回值的改写不得污染复用缓存或其它并发调用方。
    return { cookie: session.cookie, account: { ...session.account } };
  }

  private loginStatusKey(trimmedCookie: string): string {
    return `login-status:${audioCacheScope(trimmedCookie)}`;
  }

  private async verifyLoginSession(
    initialCookie: string,
    trimmed: string,
    options: { forceRefresh?: boolean }
  ): Promise<MusicLoginSession> {
    let currentCookie = initialCookie;
    const cacheKey = this.loginStatusKey(trimmed);
    let statusRes = await this.callUpstream(currentCookie, () =>
      qqmusic.login_status({ cookie: currentCookie })
    );
    // 状态接口本身也可能轮换 Cookie；有回写就先接住，避免继续拿旧 key 去续期。
    if (statusRes.body?.cookieStr?.trim()) currentCookie = statusRes.body.cookieStr;
    if (options.forceRefresh || !statusRes.body?.isLogin) {
      try {
        const refreshRes = await this.callUpstream(currentCookie, () =>
          qqmusic.login_refresh({ cookie: currentCookie })
        );
        if (refreshRes.body?.code === 200 && refreshRes.body.cookieStr) {
          currentCookie = refreshRes.body.cookieStr;
          statusRes = await this.callUpstream(currentCookie, () =>
            qqmusic.login_status({ cookie: currentCookie })
          );
          if (statusRes.body?.cookieStr?.trim()) currentCookie = statusRes.body.cookieStr;
        } else {
          this.options.logger?.warn?.("QQ 音乐凭证续期未取得新 key", {
            code: refreshRes.body?.code,
            message: refreshRes.body?.message,
          });
        }
      } catch (error) {
        this.options.logger?.warn?.("QQ 音乐凭证续期失败", describeError(error));
      }
    }

    if (!statusRes.body?.isLogin) {
      throw new AppError("MUSIC_SESSION_INVALID", "QQ 音乐登录状态已失效，请重新扫码登录");
    }

    const acc = statusRes.body?.account;
    const session: MusicLoginSession = {
      cookie: currentCookie,
      account: {
        platform: "qq",
        userId: acc?.userId || "",
        nickname: acc?.nickname || "QQ音乐用户",
        avatarUrl: acc?.avatarUrl,
        vipStatus: acc?.vipStatus || "unknown",
        vipTier: acc?.vipTier,
        vipLevel: acc?.vipLevel,
        vipYear: acc?.vipYear,
        vipExpireTime: acc?.vipExpireTime,
      },
    };

    this.loginStatusCache.set(cacheKey, session);
    if (currentCookie.trim() !== trimmed) {
      this.loginStatusCache.set(this.loginStatusKey(currentCookie.trim()), session);
    }
    return session;
  }
}
