import { create } from "zustand";
import type {
  CEECharacterSummary,
  CEEImageSize,
  CEERankedCommand,
  CEERankedLeaderboard,
  CEERankedPayload,
  CEERankedProfile,
  CEERankedState,
  CEESubjectSummary,
  ServerMessage,
} from "@bakagame/shared";
import * as ws from "@/lib/CEEWs";
import { createQueryReuseCache, keywordQueryKey } from "@/lib/QueryReuse";
import { consumeStateSync } from "@/lib/StateSync";
import { isProtocolError } from "@/lib/WebsocketClient";
import { rankedAntiCheatMessage } from "@/lib/AntiCheatCopy";
import { useCEEStore } from "./UseCEEStore";

/** 排位状态事件名，与服务端 `CEE_RANKED_STATE_EVENT` 同值；那份常量住在带 TypeBox 的模块里，客户端不能引。 */
const RANKED_STATE_EVENT = "cee.ranked.state";

/**
 * 排位查询的复用窗口，与多人房各自一份、互不影响；窗口语义见 `lib/QueryReuse`。
 */
const rankedCharacterSearchCache = createQueryReuseCache<CEECharacterSummary[]>(keywordQueryKey);
const rankedSubjectSearchCache = createQueryReuseCache<CEESubjectSummary[]>(keywordQueryKey);
const rankedSubjectCharactersCache = createQueryReuseCache<CEECharacterSummary[]>(keywordQueryKey);

/** 清空排位复用窗口；测试用它隔离用例，运行期无需调用（查询结果与场次无关）。 */
export function clearCEERankedQueryCache() {
  rankedCharacterSearchCache.clear();
  rankedSubjectSearchCache.clear();
  rankedSubjectCharactersCache.clear();
}

export type CEERankedAction =
  "queue" | "cancel" | "playBot" | "guess" | "surrender" | "exit" | "leave";

export interface CEERankedStore {
  /** 已从服务端拿到过一次排位状态。 */
  ready: boolean;
  state: CEERankedState | null;
  profile: CEERankedProfile | null;
  profileLoading: boolean;
  /** 正在往前翻更早的战绩。 */
  historyLoading: boolean;
  leaderboard: CEERankedLeaderboard | null;
  leaderboardLoading: boolean;
  /** 正在提交的命令（按钮的进行中锁与加载反馈用）；同一时刻同类命令只有一条。 */
  pending: Partial<Record<CEERankedAction, true>>;
  /** 进入排位页时调用：发 `cee.ranked.status`，之后服务端推送 `cee.ranked.state`。返回释放函数（离开页面时调用，停止响应推送并清理本地状态）。 */
  attach: () => () => void;
  queue: () => Promise<void>;
  cancel: () => Promise<void>;
  playBot: () => Promise<void>;
  /** 返回 false 表示没成功（供搜索框保留结果）。 */
  guess: (characterId: number) => Promise<boolean>;
  surrender: () => Promise<void>;
  exit: () => Promise<void>;
  leave: () => Promise<void>;
  loadProfile: () => Promise<void>;
  /** 接着 profile.recent 的最后一条往前翻一页，拼到 recent 后面。 */
  loadMoreHistory: () => Promise<void>;
  loadLeaderboard: () => Promise<void>;
  searchCharacters: (keyword: string) => Promise<CEECharacterSummary[]>;
  searchSubjects: (keyword: string) => Promise<CEESubjectSummary[]>;
  loadSubjectCharacters: (subjectId: number) => Promise<CEECharacterSummary[]>;
  characterImage: (characterId: number, size: CEEImageSize) => Promise<string | undefined>;
}

// ==================== 模块级同步基线 ====================
// 基线只装服务端下发的公开数据模型（Engineering §4）：展示派生字段一律不进这里，
// 否则 JSON Patch 的路径与索引会错位。
let rawState: CEERankedState | null = null;
let stateRevision: number | undefined;
/** 全量请求的进行中标记：同一时刻只发一条 `cee.ranked.status`。 */
let syncPending = false;
/** 事件流装入状态的次数：全量回包据此判断事件流是否已经抢先给过带修订号的基线。 */
let streamInstalls = 0;
/** 在途命令的归属代次：释放后晚到的回包一律忽略。 */
let commandGeneration = 0;
let attachCount = 0;
let unsubscribeMessage: (() => void) | null = null;
let unsubscribeStatus: (() => void) | null = null;

const settlementOf = (state: CEERankedState | null): string | undefined =>
  state?.status === "series" ? state.series.result?.settlement : undefined;

/** 本场结算从「还没落定」变成「已计分 / 不计分」：档案要跟着刷新一次。 */
const settlementLanded = (previous: CEERankedState | null, next: CEERankedState | null): boolean =>
  settlementOf(previous) === "pending" &&
  (settlementOf(next) === "rated" || settlementOf(next) === "unrated");

const installState = (next: CEERankedState | null, revision: number | undefined) => {
  const previous = rawState;
  rawState = next;
  stateRevision = revision;
  useCEERankedStore.setState({ state: next, ready: true });
  if (settlementLanded(previous, next)) void fetchProfile(true);
};

/**
 * 档案请求：加载中再来的请求只合并，不重复发。
 * 结算落定触发的刷新（`refresh`）例外——在途请求发出时结算还没落定，回包可能是旧战绩，
 * 所以先记下，等它结束后再补刷一次。
 */
let profileRefreshQueued = false;
async function fetchProfile(refresh: boolean): Promise<void> {
  const { profileLoading } = useCEERankedStore.getState();
  if (profileLoading) {
    if (refresh) profileRefreshQueued = true;
    return;
  }
  const generation = commandGeneration;
  useCEERankedStore.setState({ profileLoading: true });
  try {
    const profile = await ws.send("cee.ranked.profile", {});
    if (ownsGeneration(generation)) useCEERankedStore.setState({ profile });
  } catch (error) {
    if (ownsGeneration(generation)) reportFailure(error);
  } finally {
    if (ownsGeneration(generation)) {
      useCEERankedStore.setState({ profileLoading: false });
      if (profileRefreshQueued) {
        profileRefreshQueued = false;
        void fetchProfile(false);
      }
    }
  }
}

const attached = (generation: number): boolean =>
  generation === commandGeneration && attachCount > 0;

/**
 * 回包归属只看代次：释放后重进页面会让旧代次的在途请求作废。
 * 命令本身可能是玩家在没有 attach 的入口上按下的，失败照样要说给他听。
 */
const ownsGeneration = (generation: number): boolean => generation === commandGeneration;

/**
 * 全量同步：回包本身就是一份完整状态。
 *
 * 服务端先推一帧带修订号的全量、再回 ACK，所以事件通常先到。此时回包与那帧是同一份状态，
 * 再装一次只会把修订号清成 undefined，之后每个差量都对不上基线、白白再拉一次全量。
 * 事件流在请求途中装过状态就以它为准，回包只在事件丢失（例如积压丢帧）时兜底。
 */
async function requestStatus(): Promise<void> {
  if (syncPending) return;
  syncPending = true;
  const generation = commandGeneration;
  const installsBefore = streamInstalls;
  try {
    const state = await ws.send("cee.ranked.status", {});
    if (attached(generation) && streamInstalls === installsBefore) installState(state, undefined);
  } catch (error) {
    if (attached(generation)) reportFailure(error);
  } finally {
    syncPending = false;
  }
}

function handleRankedMessage(generation: number, message: ServerMessage): void {
  if (!attached(generation)) return;
  if (message.type !== "event" || message.event !== RANKED_STATE_EVENT) return;
  const result = consumeStateSync<CEERankedState>(rawState, stateRevision, message.payload);
  if (result.needsFullSync || !result.state) {
    void requestStatus();
    return;
  }
  streamInstalls += 1;
  installState(result.state, result.revision);
}

function handleRankedStatus(generation: number, connected: boolean): void {
  if (!attached(generation)) return;
  if (!connected) {
    // 断线即基线作废：修订号与状态一起清掉，重连后以新连接的第一份全量重新起算。
    rawState = null;
    stateRevision = undefined;
    useCEERankedStore.setState({ ready: false, state: null });
    return;
  }
  void requestStatus();
}

/** 失败上报：排位有专用措辞的错误码自己出文案，其余走 CEE store（它会拉起登录弹窗）。 */
function reportFailure(error: unknown): void {
  const cee = useCEEStore.getState();
  const rankedText = isProtocolError(error) ? rankedAntiCheatMessage(error.code) : undefined;
  if (rankedText === undefined) {
    cee.reportError(error);
    return;
  }
  cee.showToast(rankedText);
}

export const useCEERankedStore = create<CEERankedStore>((set, get) => {
  /** 动作命令的公共骨架：进行中锁、失败上报、释放后忽略回包。 */
  const runAction = async <T extends CEERankedCommand>(
    action: CEERankedAction,
    command: T,
    payload: CEERankedPayload<T>
  ): Promise<boolean> => {
    const generation = commandGeneration;
    set({ pending: { ...get().pending, [action]: true } });
    try {
      await ws.send(command, payload);
      return ownsGeneration(generation);
    } catch (error) {
      if (ownsGeneration(generation)) reportFailure(error);
      return false;
    } finally {
      // 释放已经把 pending 清空并让代次作废；旧请求的收尾不能再动新一页的锁。
      if (ownsGeneration(generation)) {
        const rest = { ...get().pending };
        delete rest[action];
        set({ pending: rest });
      }
    }
  };

  return {
    ready: false,
    state: null,
    profile: null,
    profileLoading: false,
    historyLoading: false,
    leaderboard: null,
    leaderboardLoading: false,
    pending: {},
    attach: () => {
      const generation = commandGeneration;
      attachCount += 1;
      if (!unsubscribeMessage)
        unsubscribeMessage = ws.onMessage((message) => handleRankedMessage(generation, message));
      if (!unsubscribeStatus)
        unsubscribeStatus = ws.onStatus((connected) => handleRankedStatus(generation, connected));
      // 已连接时 onStatus 注册即回调并取状态，这里对被节流掉；未连接则等真正连上再取。
      void requestStatus();
      return () => {
        attachCount = Math.max(0, attachCount - 1);
        if (attachCount > 0) return;
        commandGeneration += 1;
        unsubscribeMessage?.();
        unsubscribeStatus?.();
        unsubscribeMessage = null;
        unsubscribeStatus = null;
        rawState = null;
        stateRevision = undefined;
        profileRefreshQueued = false;
        // 释放把节流放开：下一次进入页面必须能重新发一条状态请求。
        syncPending = false;
        set({
          ready: false,
          state: null,
          // 换号后再进页面不能短暂显示上一个账号的战绩与榜单。
          profile: null,
          profileLoading: false,
          leaderboard: null,
          pending: {},
          historyLoading: false,
          leaderboardLoading: false,
        });
      };
    },
    queue: async () => {
      await runAction("queue", "cee.ranked.queue", {});
    },
    cancel: async () => {
      await runAction("cancel", "cee.ranked.cancel", {});
    },
    playBot: async () => {
      await runAction("playBot", "cee.ranked.playBot", {});
    },
    guess: (characterId) => runAction("guess", "cee.ranked.guess", { characterId }),
    surrender: async () => {
      await runAction("surrender", "cee.ranked.surrender", {});
    },
    exit: async () => {
      await runAction("exit", "cee.ranked.exit", {});
    },
    leave: async () => {
      await runAction("leave", "cee.ranked.leave", {});
    },
    loadProfile: () => fetchProfile(false),
    loadMoreHistory: async () => {
      const { profile, historyLoading } = get();
      const last = profile?.recent.at(-1);
      if (historyLoading || !profile?.recentHasMore || !last) return;
      const generation = commandGeneration;
      set({ historyLoading: true });
      try {
        const page = await ws.send("cee.ranked.history", { before: last.endedAt });
        const current = get().profile;
        // 翻页途中资料被刷新（刚结算完一场）：新资料已从第一页重来，旧游标的这一页丢掉。
        if (!ownsGeneration(generation) || current?.recent.at(-1)?.seriesId !== last.seriesId)
          return;
        const seen = new Set(current.recent.map((entry) => entry.seriesId));
        set({
          profile: {
            ...current,
            recent: [
              ...current.recent,
              ...page.entries.filter((entry) => !seen.has(entry.seriesId)),
            ],
            recentHasMore: page.hasMore,
          },
        });
      } catch (error) {
        if (ownsGeneration(generation)) reportFailure(error);
      } finally {
        if (ownsGeneration(generation)) set({ historyLoading: false });
      }
    },
    loadLeaderboard: async () => {
      if (get().leaderboardLoading) return;
      const generation = commandGeneration;
      set({ leaderboardLoading: true });
      try {
        const leaderboard = await ws.send("cee.ranked.leaderboard", {});
        if (ownsGeneration(generation)) set({ leaderboard });
      } catch (error) {
        if (ownsGeneration(generation)) reportFailure(error);
      } finally {
        if (ownsGeneration(generation)) set({ leaderboardLoading: false });
      }
    },
    searchCharacters: (keyword) =>
      rankedCharacterSearchCache.run(keyword, async () => {
        const { results } = await ws.send("cee.ranked.characterSearch", { keyword });
        return results;
      }),
    searchSubjects: (keyword) =>
      rankedSubjectSearchCache.run(keyword, async () => {
        const { results } = await ws.send("cee.ranked.subjectSearch", { keyword });
        return results;
      }),
    loadSubjectCharacters: (subjectId) =>
      rankedSubjectCharactersCache.run(String(subjectId), async () => {
        const { results } = await ws.send("cee.ranked.subjectCharacters", { subjectId });
        return results;
      }),
    // 取图要回源上游，耗时由服务端决定：不设客户端超时，与多人房的图片命令同一口径。
    characterImage: async (characterId, size) => {
      const { imageUrl } = await ws.send(
        "cee.ranked.characterImage",
        { characterId, size },
        { timeout: 0 }
      );
      return imageUrl;
    },
  };
});
