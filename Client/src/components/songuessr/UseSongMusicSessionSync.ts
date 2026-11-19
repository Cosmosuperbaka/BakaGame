import { useCallback, useEffect, useRef, useState } from "react";
import {
  clearStoredSongMusicSession,
  getStoredSongMusicSession,
  saveSongMusicSession,
  onSongMusicSessionChanged,
  type StoredSongMusicSession,
} from "@/lib/SonGuessrMusicSession";
import type { SonGuessrAck, SonGuessrPrivateState, SonGuessrRoomSnapshot } from "@bakagame/shared";
import type { SonGuessrStore } from "@/stores/UseSonGuessrStore";
import { errorCode } from "@/lib/ErrorMessage";

/**
 * 把本机凭据装载进房间的退避重试节奏。
 *
 * 这一步要等网易云校验凭据，属于上游决定耗时的操作：单发一次失败时，房间徽标会一直停在
 * 「正在连接」，直到下一次与凭据无关的快照变化（房间活动，空闲房间则是 60 秒全量校准）
 * 才重新触发。固定退避把这种情况收敛到秒级，同时重试次数有界，不会放大上游压力。
 */
const MUSIC_SESSION_RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;

/** 上游抖动与传输层失败值得重试；会话失效、非房主这类业务拒绝重试也不会变好。 */
const TRANSIENT_MUSIC_SESSION_ERROR_CODES = new Set([
  "MUSIC_API_RATE_LIMITED",
  "MUSIC_API_BUSY",
  "MUSIC_API_FAILED",
  "TIMEOUT",
  "DISCONNECTED",
  "NOT_CONNECTED",
]);

const isTransientMusicSessionError = (error: { code?: string }): boolean =>
  error.code === undefined || TRANSIENT_MUSIC_SESSION_ERROR_CODES.has(error.code);

/** 同一房间、席位与凭据只允许一个装载事务；`settled` 表示已经落定，不再重复上传。 */
interface MusicSessionTask {
  key: string;
  keyPrefix?: string;
  cancelled: boolean;
  settled: boolean;
}

/** `song.auth.useCookie` 的回包：装载凭据后服务端确认的账号与本次实际生效的 cookie。 */
type MusicSessionAuthResult = SonGuessrAck<"song.auth.useCookie">;

/** 上游给出账号资料后，把本次实际生效的 cookie 写回本地凭据与事务键。 */
function settleMusicSessionUpload(
  task: MusicSessionTask,
  platform: "netease" | "qq",
  storedSession: StoredSongMusicSession,
  result: MusicSessionAuthResult | undefined
): void {
  if (!result?.account) return;
  const nextCookie = result.cookie || storedSession.cookie;
  if (task.keyPrefix) {
    task.key = `${task.keyPrefix}:${nextCookie}`;
  }
  saveSongMusicSession(
    { cookie: nextCookie, account: { ...result.account, platform } },
    storedSession.persistent,
    platform
  );
}

/** 返回 `undefined` 表示不再重试：重试用尽或确定性拒绝，交回给下一次快照变化（房间活动或周期校准）再装一次。 */
function musicSessionRetryDelay(attempt: number, error: { code?: string }): number | undefined {
  const delay = MUSIC_SESSION_RETRY_DELAYS_MS[attempt];
  if (delay === undefined || !isTransientMusicSessionError(error)) return undefined;
  return delay;
}

/**
 * 准备页把本机保存的音乐凭据装载进房间：任务去重、上传结果回写与退避重试都在这里，
 * 房间生命周期只消费它暴露的取消入口。
 */
export function useSongMusicSessionSync(input: {
  connected: boolean;
  snapshot: SonGuessrRoomSnapshot | null;
  privateState: SonGuessrPrivateState | null;
  roomId: string;
  sendCommand: SonGuessrStore["sendCommand"];
  showToast: SonGuessrStore["showToast"];
}): { cancelMusicSessionUpload: (platform?: "netease" | "qq") => void } {
  const { connected, snapshot, privateState, roomId, sendCommand, showToast } = input;
  const [musicSessionRevision, setMusicSessionRevision] = useState(0);
  const musicSessionTasksRef = useRef<{
    netease: MusicSessionTask | null;
    qq: MusicSessionTask | null;
  }>({ netease: null, qq: null });

  /** 终止指定或全部平台的当前装载事务：在途请求与待执行的退避都作废，下一次快照变化可重新发起。 */
  const cancelMusicSessionUpload = useCallback((platform?: "netease" | "qq") => {
    if (!platform || platform === "netease") {
      const task = musicSessionTasksRef.current.netease;
      if (task) task.cancelled = true;
      musicSessionTasksRef.current.netease = null;
    }
    if (!platform || platform === "qq") {
      const task = musicSessionTasksRef.current.qq;
      if (task) task.cancelled = true;
      musicSessionTasksRef.current.qq = null;
    }
  }, []);

  const uploadMusicSession = useCallback(
    async (
      task: MusicSessionTask,
      platform: "netease" | "qq",
      storedSession: StoredSongMusicSession
    ) => {
      const platformName = platform === "qq" ? "QQ音乐" : "网易云";
      for (let attempt = 0; ; attempt += 1) {
        if (task.cancelled) return;
        try {
          const result = await sendCommand("song.auth.useCookie", {
            cookie: storedSession.cookie,
            platform,
          });
          if (task.cancelled) return;
          task.settled = true;
          settleMusicSessionUpload(task, platform, storedSession, result);
          return;
        } catch (error) {
          if (task.cancelled) return;
          const code = errorCode(error);
          if (code === "MUSIC_SESSION_INVALID") {
            cancelMusicSessionUpload(platform);
            clearStoredSongMusicSession(platform);
            showToast(`${platformName}登录状态已失效，请重新扫码登录`, "error");
            return;
          }
          const delay = musicSessionRetryDelay(attempt, { code });
          if (delay === undefined) {
            cancelMusicSessionUpload(platform);
            return;
          }
          await new Promise<void>((resolve) => {
            window.setTimeout(resolve, delay);
          });
        }
      }
    },
    [cancelMusicSessionUpload, sendCommand, showToast]
  );

  useEffect(() => () => cancelMusicSessionUpload(), [cancelMusicSessionUpload]);

  useEffect(() => {
    const handleSessionChanged = () => setMusicSessionRevision((revision) => revision + 1);
    return onSongMusicSessionChanged(handleSessionChanged);
  }, []);

  useEffect(() => {
    if (!connected) {
      cancelMusicSessionUpload();
      return;
    }
    if (
      !snapshot ||
      !privateState ||
      snapshot.roomId !== roomId ||
      // 账号只在准备页自动装载：B4 之后谁都能贡献自己的号，但共享开关是「等待阶段才可改」，
      // 局中把本机凭据塞进池子只会让池子与实际生效的开关状态对不上（服务端 installMusicSession
      // 也按这一条决定新号是否默认入池）。
      snapshot.phase !== "waiting"
    ) {
      cancelMusicSessionUpload();
      return;
    }

    const platforms: ("netease" | "qq")[] = ["netease", "qq"];
    for (const platform of platforms) {
      const storedSession = getStoredSongMusicSession(platform);
      if (!storedSession) {
        cancelMusicSessionUpload(platform);
        continue;
      }
      const keyPrefix = `${snapshot.roomId}:${privateState.playerId}:${platform}`;
      const mountKey = `${keyPrefix}:${storedSession.cookie}`;
      const active = musicSessionTasksRef.current[platform];
      // 同一房间、席位与凭据：在途或已落定的装载都不重发；快照变化不能取消正在退避重试的装载。
      if (active?.key === mountKey && (active.settled || !active.cancelled)) continue;

      // 只看我自己的号（私有态）：池里排在前面的往往是别人的号，拿它判「已在房」会永远跳过自己的装载；
      // 公开的号池只有展示投影，也没有判断「同一个账号」所需的账号标识。
      const myAccount = privateState.musicAccounts?.[platform];
      // 池里已经是我这一份凭据（同一个账号）就不用再传：服务端已经有了，重传只会多跑一次上游校验。
      // 服务端对「同一份凭据」不改共享开关，所以这里也读不出开或关，开关状态仍以服务端快照为准。
      if (
        (myAccount?.userId && myAccount.userId === storedSession.account?.userId) ||
        (active?.key === mountKey && active.settled)
      ) {
        continue;
      }

      cancelMusicSessionUpload(platform);
      const task: MusicSessionTask = { key: mountKey, keyPrefix, cancelled: false, settled: false };
      musicSessionTasksRef.current[platform] = task;
      void uploadMusicSession(task, platform, storedSession);
    }
  }, [
    cancelMusicSessionUpload,
    connected,
    musicSessionRevision,
    privateState,
    roomId,
    snapshot,
    uploadMusicSession,
  ]);

  return { cancelMusicSessionUpload };
}
