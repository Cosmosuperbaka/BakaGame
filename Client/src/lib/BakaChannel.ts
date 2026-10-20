/**
 * 客户端通道探测：桌面/移动外壳（BakaGame 客户端）在页面加载前把一份只读身份挂到
 * `window.__BAKA_CHANNEL__` 上；网页里没有这个对象。
 *
 * 前端只做**存在性探测**——「有 = 原生客户端，无 = 网页」——绝不读取或调用其中的签名、
 * 自检等能力。凭据校验由服务端在握手里完成，客户端这边不反编译、不绕过完整性检查，
 * 也不代为生成签名（见 AGENTS.md 的客户端完整性边界）。握手时唯一读取的是壳已经自己
 * 签好的 `channelTicket`：票由壳生成、由服务端消费，前端只是把它拼进 URL。
 */

export type BakaClientType = "web" | "desktop" | "mobile";

/** 外壳注入的只读身份；`sign` / `selfCheck` 属于原生成对能力，前端从不调用。 */
export interface BakaChannelIdentity {
  clientType: BakaClientType;
  platform: string;
  clientVersion: string;
  /** 壳签好的一次性握手票据；无票时为空串或缺省。前端只读不用，读一次即作废。 */
  channelTicket?: string;
  sign?: (challenge: string) => Promise<string>;
  selfCheck?: () => Promise<object>;
  /** 窗口级防截屏开关；旧版壳没有该方法，调用方需容忍缺省。 */
  setSecureScreen?: (enabled: boolean) => void;
}

declare global {
  interface Window {
    /** 原生外壳注入；网页里为 `undefined`。 */
    __BAKA_CHANNEL__?: BakaChannelIdentity;
  }
}

/** 只读地取外壳身份；没有注入即网页环境，返回 `undefined`。 */
export const bakaChannel = (): BakaChannelIdentity | undefined =>
  typeof window === "undefined" ? undefined : window.__BAKA_CHANNEL__;

/** 是否运行在原生客户端里（存在性探测，不看内容）。 */
export const isBakaClient = (): boolean => bakaChannel() !== undefined;

/** 展示用的客户端类型：无外壳即网页。 */
export const bakaClientType = (): BakaClientType => bakaChannel()?.clientType ?? "web";

/**
 * 切换窗口级防截屏（安卓的 FLAG_SECURE）。
 *
 * 只在反作弊房里开：那里要求客户端接入，也不允许靠录屏/投屏把题目带出去。
 * 其余场景必须关掉 —— 常开会让普通玩家连正常截图分享都做不到。
 * 网页端没有壳对象，静默无操作；旧版壳没有该方法时同样跳过。
 */
export const setSecureScreen = (enabled: boolean): void => {
  bakaChannel()?.setSecureScreen?.(enabled);
};

/**
 * 追加到 `/api/cee/ws` 上的握手查询串。
 *
 * 只在原生客户端里带上：`CEEPlayerSchemas` 是 strict 的，进房载荷塞不下这些字段，
 * 而共享的 `WebSocketClient` 只是把 `path` 原样拼进 URL、没有首帧注册机制——所以握手
 * 查询串是不改动公共客户端的最小通道。网页环境返回空串，服务端据此判定「无通道证明」。
 *
 * **必须在每次建连时调用**，不能把结果缓存成字符串：`ticket` 是一次性的（服务端 30 秒
 * TTL、用过即焚），壳那边读一次就作废并补签下一张。构造时读一次会让所有重连带上废票，
 * 反作弊房里的断线重连因此全部进不来。握手 URL 只携带 `ticket`：客户端类型与版本由
 * 服务端验票后从设备表得出（项目约定版本/客户端类型判定归服务端权威），自报明文放进
 * URL 没有任何消费方，留着只会被后来者误当身份。
 */
export const bakaChannelQuery = (): string => {
  const ticket = bakaChannel()?.channelTicket;
  if (!ticket) return "";
  return `?ticket=${encodeURIComponent(ticket)}`;
};
