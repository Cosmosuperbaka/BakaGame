import { randomUUID } from "node:crypto";
import { AppError } from "../../../domain/Errors";
import { describeError, type EventLogger } from "../../EventLogger";
import { asRecord, readNumber, readString } from "../../JsonReaders";
import type { MusicLoginSession, MusicQrLogin, MusicQrLoginCheck } from "../MusicProvider";
import type { SonGuessrMusicAccount } from "../../../shared/Index";
import { LoginStatusCache } from "../MusicCredential";
import type { NeteaseApiGateway } from "./NeteaseApiGateway";
import {
  musicLoginError,
  readLoginAccount,
  readVipAccount,
  responseBody,
  responseCode,
  responseCookie,
  responseMessage,
} from "./NeteaseResponse";

/**
 * 登录态校验结果的复用窗口。
 *
 * 房间接入（`song.auth.useCookie`）与开局复验都要读同一份账号状态，而玩家反复进出房间时
 * 凭据并没有变化。网易云文档明确要求登录成功后复用凭据、不要高频重复调用登录接口，
 * 因此成功校验的结果在短时间内复用；校验失败不入缓存，下一次请求照常回源。
 */
const LOGIN_STATUS_REUSE_TTL_MS = 60_000;
/** 登录态复用缓存的条目上限；每个玩家一份，超出按 LRU 淘汰。 */
const LOGIN_STATUS_CACHE_MAX_ENTRIES = 64;

export interface NeteaseLoginDeps {
  gateway: NeteaseApiGateway;
  deviceName: string;
  logger?: EventLogger;
  now: () => number;
}

/** 扫码登录、登录态校验与会员信息补全。出站一律经网关，复用缓存与在途合并状态在本类里。 */
export class NeteaseLogin {
  private readonly loginStatus: LoginStatusCache;
  private readonly gateway: NeteaseApiGateway;
  private readonly deviceName: string;
  private readonly logger?: EventLogger;
  private readonly now: () => number;

  constructor(deps: NeteaseLoginDeps) {
    this.gateway = deps.gateway;
    this.deviceName = deps.deviceName;
    this.logger = deps.logger;
    this.now = deps.now;
    this.loginStatus = new LoginStatusCache({
      maxEntries: LOGIN_STATUS_CACHE_MAX_ENTRIES,
      ttlMs: LOGIN_STATUS_REUSE_TTL_MS,
    });
  }

  private loginCookie(): Record<string, unknown> {
    return {
      os: "pc",
      appver: "3.1.29.205117",
      osver: "Microsoft-Windows-10-Professional-build-19045-64bit",
      channel: "netease",
      mobilename: this.deviceName,
      model: this.deviceName,
    };
  }

  private loginUserAgent(): string {
    return "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/3.1.29.205117";
  }

  async createQrLogin(): Promise<MusicQrLogin> {
    const loginCookie = this.loginCookie();
    const loginUa = this.loginUserAgent();
    // 每次扫码开启一个新的登录会话，并在会话内固定同一个 CN 出口 IP。
    // 沿用上一轮会话的旧 IP 会让「同设备同 IP」的设备指纹失去意义。
    const scope = `qr-login:${randomUUID()}`;
    // 取 unikey 这一步还没有可用于分桶的 key，先把 scope 显式传进去；
    // 拿到 key 后登记到同一个 scope 上，保证整轮握手始终是同一个出口 IP。
    const keyResponse = await this.gateway.call(
      ["login_qr_key"],
      { ua: loginUa },
      loginCookie,
      this.gateway.randomCNIP,
      true,
      false,
      scope
    );
    const keyBody = responseBody(keyResponse);
    if (responseCode(keyBody) !== 200) throw musicLoginError(keyBody, "无法创建登录二维码");
    const key = readString(asRecord(keyBody.data).unikey ?? keyBody.unikey);
    if (!key) throw new AppError("MUSIC_LOGIN_FAILED", "无法创建登录二维码");

    this.gateway.ipScopes.setLoginScope(key, scope);
    try {
      const qrResponse = await this.gateway.call(
        ["login_qr_create"],
        { key, qrimg: true, platform: this.deviceName, ua: loginUa },
        loginCookie,
        this.gateway.randomCNIP,
        true,
        false,
        scope
      );
      const qrBody = responseBody(qrResponse);
      if (responseCode(qrBody) !== 200) throw musicLoginError(qrBody, "无法生成登录二维码");
      const qrData = asRecord(qrBody.data);
      const qrUrl = readString(qrData.qrurl);
      const qrImage = readString(qrData.qrimg);
      if (!qrUrl || !qrImage) throw new AppError("MUSIC_LOGIN_FAILED", "无法生成登录二维码");
      return { key, qrUrl, qrImage };
    } catch (error) {
      this.gateway.ipScopes.deleteLoginScope(key);
      throw error;
    }
  }

  async checkQrLogin(keyValue: string): Promise<MusicQrLoginCheck> {
    const key = keyValue.trim();
    if (!key) throw new AppError("INVALID_LOGIN", "二维码登录密钥不能为空");
    // 本次轮询只认自己那个二维码对应的会话 IP，别人同时扫码不会串到这里。
    const scope = this.gateway.ipScopes.getLoginScope(key);
    const response = await this.gateway.call(
      ["login_qr_check"],
      { key, ua: this.loginUserAgent() },
      this.loginCookie(),
      this.gateway.randomCNIP,
      true,
      false,
      scope
    );
    const body = responseBody(response);
    const code = responseCode(body);
    if (code === 8810 || code === 10004) throw musicLoginError(body, "扫码登录失败");
    const message = responseMessage(body, "等待扫码");
    if (code === 800) return { status: "expired", message };
    if (code === 802) return { status: "scanned", message };
    if (code !== 803) return { status: "waiting", message };

    const cookie = responseCookie(response);
    if (!cookie) throw new AppError("MUSIC_LOGIN_FAILED", "扫码成功但未取得登录 Cookie");
    // 先固化会话 IP 再发后续请求：否则设备上报与状态校验会按 cookie 另起一个 IP，
    // 等会话 IP 回填时又切一次 —— 凭证刚建立就漂移，正是登录态反复失效的成因。
    this.gateway.ipScopes.bindSessionIp(cookie, scope);
    try {
      await this.uploadDeviceInfo(cookie, this.deviceName, scope);
      const session = await this.getLoginStatus(cookie, scope);
      return { status: "authorized", message, session };
    } finally {
      this.gateway.ipScopes.deleteLoginScope(key);
    }
  }

  async uploadDeviceInfo(
    cookieValue: string,
    deviceName = this.deviceName,
    loginScope?: string
  ): Promise<boolean> {
    const cookie = cookieValue.trim();
    if (!cookie) return false;
    const name = deviceName.trim() || this.deviceName;
    try {
      // 设备名上报只走 Enhanced API 的原生 `deviceinfo_center_upload` 模块。历史上该模块在
      // 4.40.x 尚不存在，这里于是回退到直接 import 包内 `util/request.js` + `util/option.js`
      // 自拼 EAPI 请求——那属于「直接导入传递依赖」：上游一改内部目录就整条失效，还会绕开本
      // provider 的限流队列与出口 IP 归属。API 包自 4.41.0 起自带同名模块，行为与自拼请求等价，
      // 回退路径已无必要，移除以免重新引入隐式依赖。
      const response = await this.gateway.callOptional(
        ["deviceinfo_center_upload"],
        { deviceName: name },
        `${cookie}; os=pc`,
        this.gateway.randomCNIP,
        false,
        loginScope
      );
      return Boolean(response);
    } catch (error) {
      this.logger?.warn("上报网易云设备名称未成功，保持原设备名运行", describeError(error));
      return false;
    }
  }

  async getLoginStatus(cookieValue: string, loginScope?: string): Promise<MusicLoginSession> {
    const cookie = cookieValue.trim();
    if (!cookie) throw new AppError("MUSIC_SESSION_INVALID", "登录 Cookie 不能为空");
    const cacheKey = this.gateway.cacheKey("login-status", cookie);
    // 复用期内直接返回同一份校验结果；校验失败不写缓存，所以失效的凭据下一次仍会回源。
    // 同凭据的并发校验合并：房间接入与开局复验经常同时到达，各打一次上游没有收益。
    return this.loginStatus.resolve(cacheKey, () => this.verifyLoginStatus(cookie, loginScope));
  }

  private async verifyLoginStatus(cookie: string, loginScope?: string): Promise<MusicLoginSession> {
    // 该校验请求必须携带与登录同源的 IP：历史实现显式关闭 randomCNIP 导致校验请求无 realIP，
    // 网易云按出口 IP 比对后判定为异地调用，正是「设备还在但凭证反复失效」的直接触发点。
    const response = await this.gateway.call(
      ["login_status"],
      {},
      cookie,
      this.gateway.randomCNIP,
      true,
      false,
      loginScope
    );
    const body = responseBody(response);
    const data = asRecord(body.data);
    const profile = asRecord(body.profile ?? data.profile);
    const nestedCode = readNumber(data.code);
    const userId = readString(profile.userId ?? profile.id);
    if (responseCode(body) !== 200 || (nestedCode !== undefined && nestedCode !== 200) || !userId) {
      throw new AppError("MUSIC_SESSION_INVALID", "网易云登录状态已失效");
    }
    return {
      cookie,
      account: await this.enrichVipAccount(cookie, readLoginAccount(body)),
    };
  }

  private async enrichVipAccount(
    cookie: string,
    account: SonGuessrMusicAccount
  ): Promise<SonGuessrMusicAccount> {
    const response = await this.gateway.callOptional(
      ["vip_info_v2", "vip_info"],
      account.userId ? { uid: account.userId } : {},
      cookie
    );
    if (!response) return { ...account, vipStatus: "unknown" };
    const body = responseBody(response);
    if (responseCode(body) !== 200) return { ...account, vipStatus: "unknown" };
    return readVipAccount(body, account, this.now());
  }
}
