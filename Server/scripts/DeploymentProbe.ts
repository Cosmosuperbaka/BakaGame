/**
 * 只读发布探针；不加载应用、凭据或第三方 Provider。
 *
 * 本文件必须**自包含**（无 import）：部署作业经 stdin 把它喂给容器里的 bun
 * （见 .github/workflows/deploy.yml 的 `bun --no-env-file - < DeploymentProbe.ts`），
 * 任何相对导入都会在 stdin 布局下解析失败。因此额度只能镜像，不能引用应用代码。
 */
export interface DeploymentProbeIO {
  fetch: typeof globalThis.fetch;
  now: () => number;
  sleep: (milliseconds: number) => Promise<unknown>;
}

/**
 * `/health` 的额度镜像。**真相在 `Server/src/transport/routes/System.ts`**：
 * `PROBE_WINDOW_MS` / `PROBE_IP_MAX_REQUESTS`（一份 60 秒窗口内单 IP 的 /health 次数）。
 * 只有 /health 设额度，/livez 与 /readyz 是 LB 契约、不设额度（同文件注释），
 * 所以探针可以对后两者保持高频轮询、只对 /health 自我限速。
 * 镜像值与来源不符时 `Server/scripts/Delivery.test.ts` 的镜像断言直接变红。
 */
export const HEALTH_WINDOW_MS = 60_000;
export const HEALTH_QUOTA_REQUESTS = 120;
/** 只消耗额度的一半：另一半留给同 IP 上的负载均衡与健康监控，探针不该把 /health 扫爆。 */
export const HEALTH_QUOTA_SHARE = 2;
/** 由额度推导出的 /health 最小提问间隔：60000 / (120 / 2) = 1000ms。 */
export const HEALTH_MIN_INTERVAL_MS = Math.ceil(
  HEALTH_WINDOW_MS / (HEALTH_QUOTA_REQUESTS / HEALTH_QUOTA_SHARE)
);

/** 快轮询起步间隔：绝大多数重启在 1 秒内就绪，快速命中可以省下整片滚动预算。 */
const POLL_MIN_INTERVAL_MS = 200;
/** 未就绪时轮询间隔的上限：越等越慢，避免把「启动慢」熬成「自己把服务打爆」。 */
const POLL_MAX_INTERVAL_MS = 1_000;
/** 单次请求与 WS 计时器的上限，同时是取消/预算收缩时的最小粒度。 */
const REQUEST_MAX_MS = 5_000;
/** 默认总预算；部署作业按本片剩余时间经 DEPLOY_PROBE_BUDGET_MS 注入，见 deploy.yml 预算块。 */
export const DEFAULT_BUDGET_MS = 30_000;

type Check = { ok: boolean; reason: string; rateLimited: boolean; retryAfter?: number };

const retryAfterMs = (
  response: { headers: { get(name: string): string | null } },
  now: number
): number | undefined => {
  // 429 由 rateLimitHeaders() 同时给出 retry-after（秒）与 x-ratelimit-reset（绝对 epoch 秒）。
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.ceil(retryAfter * 1000);
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1000 - now);
  return undefined;
};

/**
 * 单个 GET 的判定：429、5xx、网络错误、超时统统是「还没就绪」，不是失败。
 * 只有预算耗尽才抛出，且带上最后一次观察到的现象——运维据此分辨「服务慢」与「服务坏」，
 * 不必再猜是不是探针自己把 /health 打到了限流（审查 F82）。
 */
const checkPath = async (
  baseUrl: string,
  path: string,
  remaining: () => number,
  signal: AbortSignal | undefined,
  io: DeploymentProbeIO
): Promise<Check> => {
  try {
    const response = await io.fetch(`${baseUrl}${path}`, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(remaining())])
        : AbortSignal.timeout(remaining()),
    });
    if (response.status === 429) {
      const retry = retryAfterMs(response, io.now());
      return {
        ok: false,
        reason: `${path} 限流 429${retry === undefined ? "" : `（Retry-After ${Math.ceil(retry / 1000)}s）`}`,
        rateLimited: true,
        retryAfter: retry,
      };
    }
    const body = (await response.json().catch(() => ({}))) as {
      status?: string;
      ready?: boolean;
    };
    if (!response.ok)
      return { ok: false, reason: `${path} HTTP ${response.status}`, rateLimited: false };
    if (body.status !== "ok")
      return { ok: false, reason: `${path} status=${String(body.status)}`, rateLimited: false };
    if (path === "/readyz" && body.ready !== true)
      return { ok: false, reason: "/readyz ready!=true", rateLimited: false };
    return { ok: true, reason: `${path} ok`, rateLimited: false };
  } catch (error) {
    return {
      ok: false,
      reason: `${path} 请求失败: ${error instanceof Error ? error.message : String(error)}`,
      rateLimited: false,
    };
  }
};

/** 三条大厅订阅的命令往返；返回 undefined 表示全绿，否则返回失败现象。 */
const probeSubscriptions = async (
  baseUrl: string,
  signal: AbortSignal | undefined,
  remaining: () => number
): Promise<string | undefined> => {
  const results = await Promise.allSettled(
    [
      ["/api/whoisfaker/ws", "lobby.subscribeRooms"],
      ["/api/songuessr/ws", "song.lobby.subscribeRooms"],
      ["/api/cee/ws", "cee.lobby.subscribeRooms"],
    ].map(
      ([path, requestType]) =>
        new Promise<void>((resolve, reject) => {
          const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}${path}`);
          const id = crypto.randomUUID();
          let settled = false;
          const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            socket.close();
            if (error) reject(error);
            else resolve();
          };
          const onAbort = () => finish(new Error("部署探针已取消"));
          signal?.addEventListener("abort", onAbort, { once: true });
          const timer = setTimeout(() => finish(new Error(`订阅 ACK 超时: ${path}`)), remaining());
          socket.addEventListener(
            "open",
            () => socket.send(JSON.stringify({ id, type: requestType, payload: {} })),
            { once: true }
          );
          socket.addEventListener("error", () => finish(new Error(`协议连接失败: ${path}`)), {
            once: true,
          });
          socket.addEventListener("close", () => finish(new Error(`协议提前关闭: ${path}`)), {
            once: true,
          });
          socket.addEventListener("message", (event) => {
            let packet: { id?: string; type?: string; requestType?: string };
            try {
              packet = JSON.parse(String(event.data));
            } catch {
              return;
            }
            if (packet.id !== id) return;
            if (packet.type !== "ack" || packet.requestType !== requestType)
              return finish(new Error(`订阅 ACK 无效: ${path}`));
            finish();
          });
        })
    )
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status !== "rejected") return undefined;
  return String((failure.reason as Error).message ?? failure.reason);
};

/** 需要跨轮保留的观察状态。 */
interface ProbeState {
  healthOk: boolean;
  nextHealthAt: number;
  lastHealthIssue: string | null;
  rateLimitedSeen: boolean;
}

/**
 * 一轮就绪探测。`/health` 只在到自己的限速窗口时提问，`/livez` 与 `/readyz` 每轮都问
 * （它们不设额度），返回本轮观察到的「还没就绪」现象与两个免额度端点的状态。
 */
const runReadinessRound = async (
  baseUrl: string,
  signal: AbortSignal | undefined,
  io: DeploymentProbeIO,
  remaining: () => number,
  state: ProbeState
): Promise<{ blockers: string[]; liveOk: boolean; readyOk: boolean }> => {
  /** 真正的「还没就绪」现象；/health 只是未到自身限速窗口不算现象，否则会把等待熬成超时。 */
  const blockers: string[] = [];
  let liveOk = false;
  let readyOk = false;

  // /health 受额度约束：按推导出的最小间隔提问，429 时继续退避；观察到一次 ok 之后不再提问——
  // 就绪判定已由 /livez + /readyz + 订阅 ACK 承担，继续提问只会白白消耗额度
  // （这正是 F82 里探针自己把 /health 扫爆的来源）。
  if (!state.healthOk && state.nextHealthAt <= io.now()) {
    const health = await checkPath(baseUrl, "/health", remaining, signal, io);
    if (health.ok) state.healthOk = true;
    else {
      blockers.push(health.reason);
      // /health 之后不再提问，最后一次现象必须留档：预算耗尽时它是分辨「慢」与「坏」的关键。
      state.lastHealthIssue = health.reason;
    }
    // 撞到自己的额度说明上一次退避还不够长：优先听 Retry-After，没有标头就保守地等半个窗口。
    const backoff = health.rateLimited
      ? Math.max(HEALTH_MIN_INTERVAL_MS, health.retryAfter ?? HEALTH_WINDOW_MS / 2)
      : HEALTH_MIN_INTERVAL_MS;
    state.nextHealthAt = io.now() + backoff;
    if (health.rateLimited) state.rateLimitedSeen = true;
  }

  for (const path of ["/livez", "/readyz"]) {
    const result = await checkPath(baseUrl, path, remaining, signal, io);
    if (result.rateLimited) state.rateLimitedSeen = true;
    if (!result.ok) {
      blockers.push(result.reason);
      continue;
    }
    if (path === "/livez") liveOk = true;
    else readyOk = true;
  }

  return { blockers, liveOk, readyOk };
};

/** 预算耗尽时的失败文案：带上最后一次观察，用来分辨「服务仍在启动」与「服务异常」。 */
const describeTimeout = (budgetMs: number, blocker: string, state: ProbeState): string => {
  const detail =
    state.lastHealthIssue && !blocker.includes(state.lastHealthIssue)
      ? `${state.lastHealthIssue}；${blocker}`
      : blocker;
  return (
    `业务探针失败（就绪预算 ${budgetMs}ms 用尽）: ${detail}` +
    (state.rateLimitedSeen
      ? "；/health 出现过 429 限流（探针已按额度自我限速），请分辨「服务仍在启动」与「服务异常」"
      : "")
  );
};

export async function probeDeployment(
  baseUrl = "http://127.0.0.1:4850",
  budgetMs = Number(process.env.DEPLOY_PROBE_BUDGET_MS ?? DEFAULT_BUDGET_MS),
  signal?: AbortSignal,
  io: DeploymentProbeIO = { fetch: globalThis.fetch, now: Date.now, sleep: Bun.sleep }
): Promise<void> {
  const deadline = io.now() + budgetMs;
  const remaining = () => Math.max(1, Math.min(REQUEST_MAX_MS, deadline - io.now()));
  const state: ProbeState = {
    healthOk: false,
    nextHealthAt: 0,
    lastHealthIssue: null,
    rateLimitedSeen: false,
  };
  let interval = POLL_MIN_INTERVAL_MS;
  let blocker = "尚未发起请求";

  for (;;) {
    signal?.throwIfAborted();
    const round = await runReadinessRound(baseUrl, signal, io, remaining, state);

    if (state.healthOk && round.liveOk && round.readyOk) {
      const wsFailure = await probeSubscriptions(baseUrl, signal, remaining);
      if (!wsFailure) {
        if (state.rateLimitedSeen)
          console.warn(`探针提示：/health 期间被限流，但 /livez、/readyz 与三个订阅 ACK 全绿`);
        return;
      }
      round.blockers.push(wsFailure);
    }

    blocker = round.blockers.join("；") || blocker;
    // 未就绪：本轮没有进展 → 轮询间隔翻倍（封顶 1s），/health 仍受自身限速间隔约束。
    interval = Math.min(POLL_MAX_INTERVAL_MS, interval * 2);

    const waited = io.now();
    if (waited >= deadline) throw new Error(describeTimeout(budgetMs, blocker, state));
    await io.sleep(Math.min(interval, Math.max(0, deadline - waited)));
  }
}

if (import.meta.main) {
  const budget = Number(process.env.DEPLOY_PROBE_BUDGET_MS ?? DEFAULT_BUDGET_MS);
  console.log(
    `探针预算 ${budget}ms；/health 自我限速 ≥${HEALTH_MIN_INTERVAL_MS}ms（镜像额度 ${HEALTH_QUOTA_REQUESTS} 次/${HEALTH_WINDOW_MS}ms，取 1/${HEALTH_QUOTA_SHARE}）`
  );
  await probeDeployment("http://127.0.0.1:4850", budget);
  console.log("业务就绪通过: /health /livez /readyz 与三个订阅 ACK");
}
