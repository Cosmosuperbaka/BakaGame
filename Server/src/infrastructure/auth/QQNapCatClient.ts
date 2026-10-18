import { AppError } from "../../domain/Errors";
import { normalizeAccountName, QQ_NUMBER_PATTERN } from "../../shared/Account";

/**
 * 通过 NapCatQQ 的 OneBot 11 HTTP 接口查 QQ 昵称。
 *
 * 上一版走 QQ 空间网页扫码（ptlogin + `cgi_get_portrait.fcg`），QQ 侧风控会按 UA/来源吊销
 * 这种「非客户端」登录态（实测两次会话分别 ~4h / 89min 失效），查昵称随之全站停摆。
 * NapCat 是真正的 QQ 客户端（NTQQ 协议），`get_stranger_info` 拿到的 `nickname` 就是
 * 手机 QQ 资料卡上的昵称，不经过网页登录，因此不受那类风控影响。见 Agents/Account.md §4。
 *
 * 协议要点：
 * - `POST {apiUrl}/{action}`，JSON 请求体；鉴权头 `Authorization: Bearer <accessToken>`。
 * - `get_login_info` → `{ user_id, nickname }`：登录号自身，用于后台状态面板。
 * - `get_stranger_info` → `{ user_id, nickname, ... }`：单号查询，响应还带生日、手机号等
 *   大量与昵称无关的资料，**只取 nickname**，其余字段一律不落地、不入日志。
 * - 昵称可能含方向隔离符等不可见字符（实测 `⁧` U+2067 / `⁦` U+2066），交给共享的
 *   `normalizeAccountName` 清洗与截断。
 */

const TIMEOUT_MS = 8_000;
/** 单批并发上限：串行太慢，压满会触发 QQ 侧频率限制。 */
const CONCURRENCY = 4;
/** 相邻两次 OneBot 调用的最小间隔：批量刷新 200 个号时约 16 QPS。 */
const DEFAULT_MIN_INTERVAL_MS = 60;

/** NapCat 在 QQ 未登录 / 令牌错误时的固定提示。 */
const TOKEN_HINT = /token/i;

export interface QQNapCatOptions {
  /** OneBot HTTP 基址，不含结尾斜杠（如 `https://napcat.baka.website/onebot-internal`）。 */
  apiUrl: string;
  accessToken: string;
  fetcher?: typeof fetch;
  /** 覆盖默认调用间隔（测试置 0）。 */
  minIntervalMs?: number;
}

interface OneBotEnvelope<T> {
  status?: string;
  retcode?: number;
  data?: T | null;
  message?: string;
  wording?: string;
}

/** 失败原因分类：只用于日志与后台状态文案，调用方按错误对象判断即可。 */
type NapCatFailure = "network" | "unauthorized" | "protocol" | "empty";

export class QQNapCatClient {
  private readonly fetcher: typeof fetch;
  private readonly minIntervalMs: number;

  constructor(private readonly options: QQNapCatOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  }

  private fail(
    message: string,
    kind: NapCatFailure,
    extra: Record<string, unknown> = {}
  ): AppError {
    return new AppError("QQ_NICKNAME_UNAVAILABLE", message, { kind, ...extra });
  }

  private async request(action: string, payload: Record<string, unknown>): Promise<Response> {
    const headers = new Headers({ "content-type": "application/json" });
    if (this.options.accessToken)
      headers.set("authorization", `Bearer ${this.options.accessToken}`);
    try {
      return await this.fetcher(`${this.options.apiUrl}/${action}`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw this.fail("无法连接 QQ 昵称服务", "network", { cause: String(error) });
    }
  }

  /** 调用一个动作；`null` 表示这一条查不到（而不是整条链路不可用）。 */
  private async call<T>(action: string, payload: Record<string, unknown>): Promise<T | null> {
    const response = await this.request(action, payload);
    let body: OneBotEnvelope<T>;
    try {
      body = (await response.json()) as OneBotEnvelope<T>;
    } catch {
      throw this.fail("QQ 昵称服务返回格式异常", "protocol", { status: response.status });
    }
    if (TOKEN_HINT.test(body.message ?? "") || TOKEN_HINT.test(body.wording ?? "")) {
      throw this.fail("QQ 昵称服务的访问令牌无效", "unauthorized", { status: response.status });
    }
    if (response.status === 401 || response.status === 403) {
      throw this.fail("QQ 昵称服务拒绝了访问", "unauthorized", { status: response.status });
    }
    if (body.status === "ok" && body.retcode === 0 && body.data) return body.data;
    if (response.status >= 500) {
      throw this.fail("QQ 昵称服务暂时不可用", "protocol", { status: response.status });
    }
    return null;
  }

  /**
   * 限制并发与调用频率地遍历。
   *
   * 按序号预分配发起时刻（`start + index × interval`），而不是让每个 worker 互相等待：
   * 后者会把并发退化成串行、且实际间隔变成 interval × 并发数。为序号排期则无论并发多少，
   * 整体速率都稳定在 1/interval，单个请求变慢时其余 worker 仍能顶上。
   */
  private async eachLimited<T>(
    items: readonly T[],
    worker: (item: T) => Promise<void>
  ): Promise<void> {
    const startedAt = Date.now();
    let cursor = 0;
    const run = async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        const wait = startedAt + index * this.minIntervalMs - Date.now();
        if (wait > 0) await Bun.sleep(wait);
        await worker(items[index]!);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, run));
  }

  /** 登录号自身信息；未登录或查不到时返回 `null`，网络与鉴权故障抛错。 */
  async loginInfo(): Promise<{ uin: string; nickname: string } | null> {
    const data = await this.call<{ user_id?: number | string; nickname?: string }>(
      "get_login_info",
      {}
    );
    if (!data) return null;
    const uin = String(data.user_id ?? "").trim();
    if (!uin) return null;
    return { uin, nickname: normalizeAccountName(data.nickname ?? "") || uin };
  }

  /**
   * 批量查昵称。查不到的号不出现在结果里。
   *
   * 全部号都拿不到有效响应时抛错：这通常意味着 NapCat 掉线或令牌失效，
   * 与「个别 QQ 号查不到」必须区分开——前者要停用注册，后者只是这批少几个人。
   */
  async nicknames(uins: readonly string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const targets = [
      ...new Set(uins.map((uin) => uin.trim()).filter((uin) => QQ_NUMBER_PATTERN.test(uin))),
    ];
    if (!targets.length) return result;
    let answered = 0;
    await this.eachLimited(targets, async (uin) => {
      const data = await this.call<{ nickname?: string }>("get_stranger_info", {
        user_id: Number(uin),
        no_cache: false,
      });
      if (!data) return;
      answered += 1;
      const name = normalizeAccountName(typeof data.nickname === "string" ? data.nickname : "");
      if (name) result.set(uin, name);
    });
    if (answered === 0)
      throw this.fail("QQ 昵称服务没有返回任何结果", "empty", { count: targets.length });
    return result;
  }
}
