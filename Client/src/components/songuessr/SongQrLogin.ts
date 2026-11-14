import type { SonGuessrAck, SonGuessrMusicAccount } from "@bakagame/shared";
import type { SonGuessrCommandMap } from "@/lib/SonGuessrWs";
import type { GameSendCommand } from "@/lib/GameWs";
import { createSignal } from "@/lib/Signal";
import type { SongMusicPlatform } from "@/lib/SonGuessrMusicSession";
import { errorMessage } from "./SongErrorMessage";

export type QqScanMode = "qq" | "wx" | "mobile";

/** 二维码回包：形状由 shared 的 ack 契约给出。 */
export type QrCreateResponse = SonGuessrAck<"song.auth.qr.create">;

export interface QrLoginSnapshot {
  qr: QrCreateResponse | null;
  /** 二维码旁边给玩家看的一句话 */
  status: string;
  /** 正在生成二维码或正在退出 */
  busy: boolean;
}

export interface QrLoginDeps {
  send: GameSendCommand<SonGuessrCommandMap>;
  /** 扫码授权成功：调用方负责把凭据落到本机并提示 */
  onAuthorized: (
    platform: SongMusicPlatform,
    session: { cookie: string; account: SonGuessrMusicAccount }
  ) => void;
  /** 生成二维码失败：状态行已经写了原因，这里给调用方弹提示 */
  onCreateFailed: (message: string) => void;
}

const INITIAL_STATUS = "正在准备登录二维码…";

/** 提示文案里的平台称呼 */
export const SONG_PLATFORM_NAME: Record<SongMusicPlatform, string> = {
  netease: "网易云",
  qq: "QQ音乐",
};

const SCAN_PROMPT = {
  netease: "请使用网易云音乐 App 扫码",
  qq: { qq: "请使用手机 QQ 扫码", wx: "请使用微信扫码", mobile: "请使用 QQ 音乐 App 扫码" },
} as const;

const scanPrompt = (platform: SongMusicPlatform, scanType: QqScanMode): string =>
  platform === "qq" ? SCAN_PROMPT.qq[scanType] : SCAN_PROMPT.netease;

/** 这几个错误码都是该二维码的终态：不再轮询同一张码，提示原因并等玩家刷新。 */
const TERMINAL_CODES = new Set([
  "MUSIC_LOGIN_CANCELLED",
  "MUSIC_LOGIN_FAILED",
  "MUSIC_SESSION_INVALID",
]);

/** 把命令发给服务端的载荷：网易云是默认平台，不带参数。 */
const qrArgs = (platform: SongMusicPlatform, scanType: QqScanMode) =>
  platform === "qq" ? ({ platform: "qq", type: scanType } as const) : undefined;

/**
 * 扫码登录状态机：二维码的生成、轮询核对、过期与取消，以及退出时的服务端清除。
 * 与 React 无关，组件经 `subscribe/getSnapshot` 读取状态。
 *
 * 并发靠「代际号」：每次开始、取消、授权成功与卸载都让代际号加一，
 * 在途请求回来时与发起时的代际比较，不相等就整个丢弃——刷新二维码后，
 * 旧二维码迟到的回包不会覆盖新的，也不会把旧授权落盘。
 */
export class SongQrLogin {
  private generation = 0;
  private checkingGeneration: number | null = null;
  private snapshot: QrLoginSnapshot = { qr: null, status: INITIAL_STATUS, busy: false };
  private readonly changed = createSignal();

  private deps: QrLoginDeps;

  constructor(deps: QrLoginDeps) {
    this.deps = deps;
  }

  /** 换上最新的回调：在途请求回来时按玩家此刻的偏好落盘，而不是发起时的。 */
  updateDeps(deps: QrLoginDeps): void {
    this.deps = deps;
  }

  readonly subscribe = this.changed.subscribe;
  readonly getSnapshot = (): QrLoginSnapshot => this.snapshot;

  private update(patch: Partial<QrLoginSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.changed.emit();
  }

  /** 生成一张新二维码；与此前在途的生成或核对互相取代。 */
  async start(platform: SongMusicPlatform, scanType: QqScanMode): Promise<void> {
    const generation = ++this.generation;
    this.update({ busy: true });
    try {
      const args = qrArgs(platform, scanType);
      const qr = args
        ? await this.deps.send("song.auth.qr.create", args)
        : await this.deps.send("song.auth.qr.create");
      if (generation !== this.generation) return;
      this.update({ qr, status: scanPrompt(platform, scanType) });
    } catch (error) {
      if (generation !== this.generation) return;
      this.update({ status: errorMessage(error, "二维码生成失败，请稍后重试") });
      this.deps.onCreateFailed(errorMessage(error, "二维码生成失败"));
    } finally {
      if (generation === this.generation) this.update({ busy: false });
    }
  }

  /** 核对当前二维码的扫码状态；上一次核对还没回来时直接跳过。 */
  async check(platform: SongMusicPlatform, scanType: QqScanMode): Promise<void> {
    const { qr } = this.snapshot;
    if (!qr || this.checkingGeneration === this.generation) return;
    const generation = this.generation;
    this.checkingGeneration = generation;
    try {
      const args = qrArgs(platform, scanType);
      const result = await this.deps.send("song.auth.qr.check", { key: qr.key, ...args });
      if (generation !== this.generation) return;
      this.update({ status: result.message || "等待扫码" });
      if (result.status === "expired") {
        this.update({ qr: null, status: "二维码已过期，请点击刷新" });
      } else if (result.status === "authorized" && result.cookie && result.account) {
        this.generation += 1;
        this.update({ qr: null, status: "登录成功" });
        this.deps.onAuthorized(platform, { cookie: result.cookie, account: result.account });
      }
    } catch (error) {
      if (generation !== this.generation) return;
      this.failCheck(platform, error);
    } finally {
      if (this.checkingGeneration === generation) this.checkingGeneration = null;
    }
  }

  private failCheck(platform: SongMusicPlatform, error: unknown): void {
    const { code } = error as { code?: string };
    if (code === "MUSIC_LOGIN_RISK") {
      this.update({
        qr: null,
        status: `${SONG_PLATFORM_NAME[platform]}暂时拒绝了本次登录，请稍后重新扫码`,
      });
    } else if (code !== undefined && TERMINAL_CODES.has(code)) {
      this.update({ qr: null, status: errorMessage(error, "登录失败，请点击刷新二维码") });
    } else {
      this.update({ status: errorMessage(error, "二维码状态检查失败") });
    }
  }

  /** 放弃当前二维码与一切在途请求。 */
  cancel(): void {
    this.generation += 1;
    this.checkingGeneration = null;
    this.update({ busy: false, qr: null });
  }

  /** 卸载：让在途请求回来后什么都不做。 */
  dispose(): void {
    this.generation += 1;
  }

  /**
   * 退出：先放弃当前登录，再让服务端清掉账号池里的凭据。
   * `superseded` 表示等待期间被别的操作取代，调用方什么都不做；
   * `failed` 表示服务端没清掉，本机凭据必须保留，玩家才能重试。
   */
  async clear(platform: SongMusicPlatform): Promise<"cleared" | "failed" | "superseded"> {
    this.cancel();
    const generation = this.generation;
    this.update({ busy: true });
    try {
      if (platform === "qq") await this.deps.send("song.auth.clear", { platform: "qq" });
      else await this.deps.send("song.auth.clear");
    } catch {
      if (generation !== this.generation) return "superseded";
      this.update({ busy: false });
      return "failed";
    }
    if (generation !== this.generation) return "superseded";
    this.update({ busy: false });
    return "cleared";
  }
}
