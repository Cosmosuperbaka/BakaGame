import type { AgentFocusPart } from "../../shared/AgentActivity";
import type { GameId } from "../GameClient";

export type UiPart = AgentFocusPart;

export type UiControlRole = "button" | "textbox" | "switch" | "slider" | "select" | "listitem";

export interface UiControl {
  id: string;
  label: string;
  role: UiControlRole;
  part: UiPart;
  disabled?: boolean;
  /** 输入框当前内容、开关状态或滑杆当前区间。 */
  value?: string | number | boolean | Record<string, number>;
  /** 下拉/分段控件可选值。 */
  options?: Array<{ value: string; label: string; disabled?: boolean }>;
  hint?: string;
  maxLength?: number;
  /** 玩家在界面上看得到的行内信息（搜索结果、玩家卡片等）。 */
  data?: Record<string, unknown>;
}

export interface UiSection {
  id: string;
  title: string;
  controls: UiControl[];
}

export interface UiScreen {
  game: GameId;
  roomId?: string;
  roomName?: string;
  playerId?: string;
  phase: string;
  title: string;
  notice?: string;
  /** 玩家页面上刚出现的操作反馈（toast / 回执文案）。 */
  feedback?: string;
  you: Record<string, unknown>;
  players: Array<Record<string, unknown>>;
  chat: Array<Record<string, unknown>>;
  panel: Record<string, unknown>;
  sections: UiSection[];
  /** 扁平化后的控件表；`ui_run` 用它定位控件。 */
  controls: UiControl[];
  updatedAt: number;
}

export type UiStepAction = "focus" | "type" | "press" | "click" | "set";

export interface UiStep {
  action: UiStepAction;
  control?: string;
  text?: string;
  key?: string;
  value?: unknown;
  /** type 默认追加；true 时先清空原内容，等价于人类全选后重输。 */
  replace?: boolean;
}

export interface UiStepReport {
  index: number;
  action: UiStepAction;
  control?: string;
  label?: string;
  ok: boolean;
  durationMs: number;
  /** 玩家页面上会看到的一句执行结果；错误时是失败原因。 */
  feedback?: string;
}

export interface UiRunResult {
  ok: boolean;
  steps: UiStepReport[];
  screen: UiScreen;
}

/** 构建屏幕时下发给客户端的控件与焦点共用同一套 ID，客户端据此精确框住控件。 */
export const controlId = (prefix: string, suffix?: string | number): string =>
  suffix === undefined ? prefix : `${prefix}.${suffix}`;
