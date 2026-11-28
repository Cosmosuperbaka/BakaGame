import type { SitePageAudioClip } from "@bakagame/shared";

/**
 * 接管页面时 Agent 点了猜歌的「播放片段」：页面把本回合的站内播放地址与片段区间随结果交回服务端，
 * 由远程 MCP 截出片段音频附给 Agent。
 *
 * 地址不写进 DOM 属性：按钮只带一个标记，数据留在这份模块状态里，由猜歌页登记、离开时撤销。
 * 服务端只拿它取片段，不会把地址回给 Agent。
 */
export const AGENT_AUDIO_ATTRIBUTE = "data-agent-audio";

let current: SitePageAudioClip | undefined;

/** 登记当前回合在播的片段，返回撤销函数（只撤销自己这一份，不误清后来者）。 */
export const registerAgentAudioClip = (clip: SitePageAudioClip): (() => void) => {
  const registered = { ...clip };
  current = registered;
  return () => {
    if (current === registered) current = undefined;
  };
};

/** 被点的控件带标记时交回当前片段；其余控件什么也不带。 */
export const agentAudioClipFor = (element: Element): SitePageAudioClip | undefined =>
  element.closest(`[${AGENT_AUDIO_ATTRIBUTE}]`) ? current : undefined;
