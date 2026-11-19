import type { AgentFocusKind, SitePageAction } from "@bakagame/shared";

/**
 * Agent 活动的中文标签：站点首页指示器与房间内的焦点浮层共用这一张表。
 * 新增焦点类型时只改这里，两个落点不会各说各话。
 */
const KIND_LABELS: Record<AgentFocusKind, string> = {
  site: "正在浏览站点",
  lobby: "正在查看大厅",
  enter_room: "已进入房间",
  state: "正在查看房间状态",
  action: "正在操作",
};

const AGENT_ACTION_LABELS: Record<SitePageAction, string> = {
  read: "正在查看页面",
  navigate: "正在前往",
  focus: "正在看",
  type: "正在输入",
  press: "正在按键",
  click: "正在点击",
  select: "正在选择",
  scroll: "正在滚动",
};

/**
 * 标签表的键由共享契约的动作与焦点类型约束，新增动作不补标签会编译报错；
 * 运行时收到的仍可能是更新的服务端发来的未知值，所以查表时按可缺失处理。
 */
const lookup = (table: Record<string, string>, key: string): string | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined;

/** 接管时显示的一句话：动作加目标；两步之间它在想下一步，不再重复上一个动作。 */
export const agentActivityText = (action?: string, label?: string, idle = false): string => {
  const verb = action ? lookup(AGENT_ACTION_LABELS, action) : undefined;
  if (idle || !verb) return "正在思考";
  return label ? `${verb} · ${label}` : verb;
};

/** `label` 是 Agent 自报的更具体位置（如页面标题），用它取代泛化标签。 */
export const agentActivityLabel = (kind: string, label?: string): string =>
  label || lookup(KIND_LABELS, kind) || KIND_LABELS.action;
