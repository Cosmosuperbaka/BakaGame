import type { UiContext } from "./Support";
import type { UiControl, UiScreen } from "./Types";

/**
 * 一款玩法接入 Agent 屏幕所需的全部差异。
 *
 * 屏幕构造、控件操作与「点这个控件会不会改动服务端状态」原先分在几处靠字符串前缀对应，
 * 现在由玩法自己声明一份；`SeatUi` 只按游戏取适配器，不再对游戏编号做分支。
 */
export interface GameUiAdapter {
  build(context: UiContext): UiScreen;
  /** 读屏前替玩家完成的增强步骤（猜歌：上报音频已就绪）；失败不影响读屏。 */
  prepare?(context: UiContext): Promise<void>;
  click(context: UiContext, control: UiControl): Promise<string>;
  set(context: UiContext, control: UiControl, value: unknown): Promise<string>;
  press(context: UiContext, control: UiControl, key: string): Promise<string | undefined>;
  /** 输入框停止输入后的自动检索；没有检索控件的玩法什么也不做。 */
  autoSearch(context: UiContext, controlId: string): Promise<void>;
  /** 点击这个控件是否改动服务端状态：改动了就要等页面刷新再回屏。 */
  mutatesOnClick(id: string, context: UiContext): boolean;
  mutatesOnSet: ReadonlySet<string>;
  mutatesOnPress: ReadonlySet<string>;
  /** 出题、开局、换轮会跨多次上游请求，等待页面刷新时用长等待。 */
  longActions: ReadonlySet<string>;
  /** 聊天回车与发送按钮走的命令。 */
  chatCommand: string;
}

/** 控件 id 的匹配器：精确 id 与前缀两种写法并存，声明时一眼看全。 */
export const idMatcher = (
  ids: readonly string[],
  prefixes: readonly string[]
): ((id: string) => boolean) => {
  const exact = new Set(ids);
  return (id) => exact.has(id) || prefixes.some((prefix) => id.startsWith(prefix));
};
