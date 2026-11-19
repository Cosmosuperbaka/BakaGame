import {
  protocolErrorCode,
  SITE_SESSION_ALIVE_COMMAND,
  SITE_SESSION_ATTACH_COMMAND,
  SITE_SESSION_CLAIM_COMMAND,
} from "@bakagame/shared/values";
import { sessionStore } from "@/lib/SafeStorage";
import { clearSeatCredentials } from "@/lib/Storage";

/**
 * 标签页身份：这张标签页只要没关，就是同一个人。
 *
 * 身份由站点连接向服务端领取，存在 sessionStorage，生命周期因此天然等于标签页：刷新、
 * 前进后退、站内跳转都不变，关掉就没了。令牌是持有者凭证，只在首帧发给服务端，
 * 不进 URL（ws 地址会落进边缘与访问日志）、不进遥测，也不写进任何给别人看的地方。
 *
 * 复制标签页与 `window.open` 会连 sessionStorage 一起继承，下面分两道拦：
 * 本地标记在首屏同步判出绝大多数情况，服务端探测兜住标记看不见的情形。
 */
const TAB_TOKEN_KEY = "bakagame:tab_token";
/** 「这份 sessionStorage 正被一张开着的页面使用」的标记：离开页面时摘掉。 */
const TAB_OPEN_KEY = "bakagame:tab_open";
const SERVER_EPOCH_KEY = "bakagame:server_epoch";

/** 游戏连接等身份的上限：覆盖站点连接建连加一次服务端探测，超时按无身份继续。 */
export const TAB_READY_TIMEOUT_MS = 4_000;
/** 重启判定只在这段时间内有效：房间是重启后紧接着发现没了的，才归因到重启。 */
const SERVER_RESTART_NOTICE_WINDOW_MS = 60_000;

/** 一次连接内的请求-应答；由 WebSocket 客户端提供，走在业务命令之前。 */
export type PreludeExchange = (
  type: string,
  payload: Record<string, unknown>
) => Promise<Record<string, unknown>>;

/** 内存里留一份：存储被禁用时，本页存活期间身份依然稳定。 */
let tabToken: string | null = null;
let settled = false;
let waiters: Array<() => void> = [];
let serverRestartedAt: number | null = null;

const forgetInheritedIdentity = (): void => {
  tabToken = null;
  sessionStore.remove(TAB_TOKEN_KEY);
  clearSeatCredentials();
};

/**
 * 判定这份 sessionStorage 是不是从一张还开着的标签页继承来的。
 *
 * 刷新与站内离开都会先走 `pagehide` 摘掉标记，所以新页面读到标记只有两种可能：
 * 被复制时原页面还开着，或原页面没来得及走 `pagehide`（崩溃、被系统回收）。
 * 后者由浏览器标为 `wasDiscarded` 的单独放行；真崩溃后恢复的页面按新人处理，
 * 代价只是丢座位，好过两张标签页共用一份身份互相顶号。
 */
const claimTabStorage = (): void => {
  if (typeof window === "undefined") return;
  const discarded = (document as Document & { wasDiscarded?: boolean }).wasDiscarded === true;
  if (sessionStore.get(TAB_OPEN_KEY) !== null && !discarded) forgetInheritedIdentity();
  else tabToken = sessionStore.get(TAB_TOKEN_KEY);
  sessionStore.set(TAB_OPEN_KEY, "1");
  window.addEventListener("pagehide", () => sessionStore.remove(TAB_OPEN_KEY));
  // 从往返缓存恢复时页面不重新执行，标记要补回来。
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) sessionStore.set(TAB_OPEN_KEY, "1");
  });
};

claimTabStorage();

const settle = (): void => {
  settled = true;
  const pending = waiters;
  waiters = [];
  for (const resolve of pending) resolve();
};

/** 两种连接都带回 epoch：重启后谁先连上由退避决定，游戏连接先到时也要先知道服务端重启过。 */
const noteServerEpoch = (epoch: unknown): void => {
  if (typeof epoch !== "string") return;
  const previous = sessionStore.get(SERVER_EPOCH_KEY);
  if (previous !== null && previous !== epoch) serverRestartedAt = Date.now();
  sessionStore.set(SERVER_EPOCH_KEY, epoch);
};

const applyClaim = (ack: Record<string, unknown>): void => {
  if (typeof ack.token !== "string") return;
  // 带去的身份正被另一张开着的标签页占用：这份存储是继承来的，座位凭证也要一起丢。
  if (ack.rotated === true) forgetInheritedIdentity();
  tabToken = ack.token;
  sessionStore.set(TAB_TOKEN_KEY, ack.token);
  noteServerEpoch(ack.serverEpoch);
};

/**
 * 站点连接的前置帧：领取或续用身份。服务端明确答不了（旧服务端不认识这条命令）时不拦业务，
 * 游戏连接按无身份继续，退回每个座位一份随机玩家号的旧行为。
 * 连接中途断开不算答复：站点连接会自己重连再领一次，游戏连接接着等，超时再放行。
 */
export const claimTabSession = async (exchange: PreludeExchange): Promise<void> => {
  try {
    applyClaim(await exchange(SITE_SESSION_CLAIM_COMMAND, tabToken ? { token: tabToken } : {}));
  } catch (error) {
    if (protocolErrorCode(error) !== "DISCONNECTED") settle();
    throw error;
  }
  settle();
};

const waitForTabToken = (timeoutMs: number): Promise<string | null> => {
  if (settled) return Promise.resolve(tabToken);
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      waiters = waiters.filter((candidate) => candidate !== finish);
      resolve(tabToken);
    };
    const timer = setTimeout(finish, timeoutMs);
    waiters.push(finish);
  });
};

/**
 * 游戏连接的前置帧：挂上站点连接领到的身份。
 *
 * 必须等站点连接的结果：刚复制出来的标签页手里那份可能正要被换掉，抢先挂上去就坐到了别人的座位上。
 * 走首帧而不是握手查询串，同时也不和 CEE 的一次性票据混在一起：票据换连接时这里会重新走一遍。
 */
export const attachTabSession = async (exchange: PreludeExchange): Promise<void> => {
  const token = await waitForTabToken(TAB_READY_TIMEOUT_MS);
  if (token) noteServerEpoch((await exchange(SITE_SESSION_ATTACH_COMMAND, { token })).serverEpoch);
};

/** 应答服务端探测：另一条连接带着同一份身份来领取时，靠这一帧证明本页还开着。 */
export const answerTabProbe = (nonce: string, exchange: PreludeExchange): void => {
  void exchange(SITE_SESSION_ALIVE_COMMAND, { nonce }).catch(() => undefined);
};

/** 房间没了的时候，服务端是不是刚重启过：决定该说「解散」还是「重启」。 */
export const serverRestartedRecently = (): boolean =>
  serverRestartedAt !== null && Date.now() - serverRestartedAt < SERVER_RESTART_NOTICE_WINDOW_MS;
