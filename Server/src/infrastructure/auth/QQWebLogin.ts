import { AppError } from "../../domain/Errors";

/**
 * QQ 网页扫码登录（QQ 空间 ptlogin）与昵称查询。
 *
 * 昵称接口 `cgi_get_portrait.fcg` 已不再匿名可用，必须带 QQ 空间登录态；这里用管理员扫码登录的
 * 一个 QQ 号的 Cookie 去查所有注册用户的昵称（见 Agents/Account.md §4）。纯 HTTP，不依赖 QQ 客户端。
 *
 * 协议要点：
 * - `ptqrshow` 返回二维码 PNG 并下发 `qrsig`；轮询 `ptqrlogin` 时带上它和由它算出的 `ptqrtoken`。
 * - 轮询返回 `ptuiCB('码', …, '跳转地址', …, '提示', '昵称')`：66 未扫码、67 已扫码待确认、65 已失效、0 成功。
 * - 成功后跟随一次跳转地址（`check_sig`），在 `qzone.qq.com` 下拿到 `p_skey` 等登录态。
 * - 昵称接口带 `g_tk`（由 `p_skey` 算出），响应为 GBK 编码的 JSONP。
 */

const APP_ID = "549000912";
const DAID = "5";
const SUCCESS_URL = "https://qzs.qq.com/qzone/v5/loginsucc.html?para=izone";
const TIMEOUT_MS = 8_000;
/** 一次查询的 QQ 号上限：接口按逗号分隔接收，过长的请求会被拒。 */
export const NICKNAME_BATCH_SIZE = 20;

export type QQLoginPoll =
  | { state: "waiting" }
  | { state: "scanned" }
  | { state: "expired" }
  | { state: "success"; uin: string; nickname: string; cookies: Record<string, string> }
  | { state: "failed"; message: string };

/** ptlogin 的 `hash33`：`ptqrtoken` 由 `qrsig` 算出。 */
export const ptqrToken = (qrsig: string): number => {
  let hash = 0;
  for (const char of qrsig) hash += (hash << 5) + char.charCodeAt(0);
  return hash & 0x7fffffff;
};

/** QQ 空间接口的 `g_tk`（`bkn`）：由 `p_skey`（缺失时退回 `skey`）算出。 */
export const gtkOf = (key: string): number => {
  let hash = 5381;
  for (const char of key) hash += (hash << 5) + char.charCodeAt(0);
  return hash & 0x7fffffff;
};

/**
 * 收集响应下发的 Cookie。
 *
 * 空值（`name=; Expires=1970…`）是按域名作用域的删除指令，**不能**在平铺容器里当删除处理：
 * 真实 check_sig 先下发 `p_skey=…; Domain=qzone.qq.com`，随后紧跟一条 `p_skey=; Domain=qq.com`
 * 的删除指令；平铺容器无法区分作用域，按删除处理会把刚拿到的合法值一并清掉（2026-10-13 首次
 * 真实扫码验收即因此丢失 p_skey，昵称接口恒报「请先登录」）。这里统一忽略空值——删除只作用于
 * 自己的域，不影响其它域的同名值；平铺容器只服务 qzone 侧请求，保留非空值是安全且正确的近似。
 */
const collectCookies = (response: Response, into: Record<string, string>) => {
  for (const line of response.headers.getSetCookie()) {
    const pair = line.split(";")[0] ?? "";
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (value) into[name] = value;
  }
  return into;
};

const cookieHeader = (cookies: Record<string, string>) =>
  Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join("; ");

/** `ptuiCB('66','0','','0','二维码未失效。', '')` → 参数数组。 */
export const parsePtuiCallback = (body: string): string[] | null => {
  const match = /ptuiCB\((.*)\)/s.exec(body);
  if (!match) return null;
  return [...match[1]!.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((item) => item[1]!);
};

/** QQ 号从 `uin`（`o0123456`）或跳转地址的 `uin=` 参数里取出。 */
const uinOf = (cookies: Record<string, string>, redirect: string) => {
  const fromCookie = cookies.uin ?? cookies.p_uin;
  if (fromCookie) return fromCookie.replace(/^o0*/, "");
  try {
    return new URL(redirect).searchParams.get("uin") ?? "";
  } catch {
    return "";
  }
};

const decodeEntities = (text: string) =>
  text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");

export class QQWebLoginClient {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  private request(url: string, init: RequestInit = {}) {
    return this.fetcher(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), ...init }).catch((error: unknown) => {
      throw new AppError("QQ_LOGIN_UNAVAILABLE", "QQ 登录服务暂时无法访问", { cause: String(error) });
    });
  }

  /** 申请二维码：返回 PNG（data URL）与之后轮询要带的 `qrsig`。 */
  async createQrCode(): Promise<{ image: string; qrsig: string }> {
    const url = `https://ssl.ptlogin2.qq.com/ptqrshow?appid=${APP_ID}&e=2&l=M&s=3&d=72&v=4&t=${Math.random()}&daid=${DAID}&pt_3rd_aid=0`;
    const response = await this.request(url);
    const qrsig = collectCookies(response, {}).qrsig;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!response.ok || !qrsig || bytes.byteLength === 0) {
      throw new AppError("QQ_LOGIN_UNAVAILABLE", "二维码获取失败，请稍后重试", { status: response.status });
    }
    return { image: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`, qrsig };
  }

  async poll(qrsig: string): Promise<QQLoginPoll> {
    const params = new URLSearchParams({
      u1: SUCCESS_URL, ptqrtoken: String(ptqrToken(qrsig)), ptredirect: "0", h: "1", t: "1", g: "1", from_ui: "1",
      ptlang: "2052", action: `0-0-${Date.now()}`, js_ver: "24112817", js_type: "1", login_sig: "", pt_uistyle: "40",
      aid: APP_ID, daid: DAID, has_onekey: "1",
    });
    const response = await this.request(`https://ssl.ptlogin2.qq.com/ptqrlogin?${params}`, { headers: { cookie: `qrsig=${qrsig}` } });
    const cookies = collectCookies(response, {});
    const args = parsePtuiCallback(await response.text());
    if (!args) return { state: "failed", message: "QQ 登录返回格式异常" };
    const [code, , redirect = "", , message = "", nickname = ""] = args;
    if (code === "66") return { state: "waiting" };
    if (code === "67") return { state: "scanned" };
    if (code === "65") return { state: "expired" };
    if (code !== "0") return { state: "failed", message: message || `QQ 登录失败（${code}）` };

    // 跟随 check_sig 拿 qzone.qq.com 下的 p_skey；只跟到 qq.com 内，避免被引到别处。
    let next = redirect;
    for (let hop = 0; hop < 3 && next; hop += 1) {
      const target = new URL(next);
      if (!/(^|\.)qq\.com$/.test(target.hostname)) break;
      const step = await this.request(target.toString(), { headers: { cookie: cookieHeader(cookies) } });
      collectCookies(step, cookies);
      const location = step.status >= 300 && step.status < 400 ? step.headers.get("location") : null;
      next = location && !location.startsWith(SUCCESS_URL.split("?")[0]!) ? new URL(location, target).toString() : "";
    }
    const uin = uinOf(cookies, redirect);
    if (!uin || !(cookies.p_skey || cookies.skey)) return { state: "failed", message: "未取得 QQ 空间登录态，请重新扫码" };
    return { state: "success", uin, nickname: decodeEntities(nickname), cookies };
  }

  /**
   * 批量查昵称；查不到的号不出现在结果里。
   * 登录态失效时抛 `QQ_SESSION_EXPIRED`，调用方据此提示管理员重新扫码。
   */
  async nicknames(uins: readonly string[], cookies: Record<string, string>): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (!uins.length) return result;
    const key = cookies.p_skey ?? cookies.skey ?? "";
    const url = `https://r.qzone.qq.com/fcg-bin/cgi_get_portrait.fcg?g_tk=${gtkOf(key)}&uins=${uins.join(",")}`;
    const response = await this.request(url, { headers: { cookie: cookieHeader(cookies), referer: "https://user.qzone.qq.com/" } });
    const text = new TextDecoder("gbk").decode(await response.arrayBuffer());
    const start = text.indexOf("(");
    const end = text.lastIndexOf(")");
    let payload: unknown;
    try {
      payload = JSON.parse(text.slice(start + 1, end));
    } catch {
      throw new AppError("QQ_NICKNAME_UNAVAILABLE", "QQ 昵称接口返回格式异常", { status: response.status });
    }
    const error = (payload as { error?: { type?: string; msg?: string } }).error;
    if (error) {
      if (/login/i.test(error.type ?? "") || /登录/.test(error.msg ?? "")) {
        throw new AppError("QQ_SESSION_EXPIRED", "查昵称用的 QQ 登录已失效，请在后台重新扫码");
      }
      throw new AppError("QQ_NICKNAME_UNAVAILABLE", "QQ 昵称查询失败", { type: error.type });
    }
    // 每项形如 `"10001": [头像地址, 访问量, -1, 0, 0, 0, "昵称", 0]`。
    for (const [uin, entry] of Object.entries(payload as Record<string, unknown>)) {
      const name = Array.isArray(entry) && typeof entry[6] === "string" ? decodeEntities(entry[6]).trim() : "";
      if (name) result.set(uin, name);
    }
    return result;
  }
}
