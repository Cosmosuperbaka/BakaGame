/**
 * Agent 活动的中文标签：站点首页指示器与房间内的焦点浮层共用这一张表。
 * 新增焦点类型时只改这里，两个落点不会各说各话。
 */
const KIND_LABELS: Record<string, string> = {
  site: "正在浏览站点",
  lobby: "正在查看大厅",
  enter_room: "已进入房间",
  state: "正在查看房间状态",
  action: "正在操作",
};

export const AGENT_ACTION_LABELS: Record<string, string> = {
  read: "正在查看页面",
  navigate: "正在前往",
  focus: "正在看",
  type: "正在输入",
  press: "正在按键",
  click: "正在点击",
  select: "正在选择",
  scroll: "正在滚动",
};

/** 接管时显示的一句话：动作加目标；两步之间它在想下一步，不再重复上一个动作。 */
export const agentActivityText = (action?: string, label?: string, idle = false): string => {
  const verb = action ? AGENT_ACTION_LABELS[action] : undefined;
  if (idle || !verb) return "正在思考";
  return label ? `${verb} · ${label}` : verb;
};

/** `label` 是 Agent 自报的更具体位置（如页面标题），用它取代泛化标签。 */
export const agentActivityLabel = (kind: string, label?: string): string =>
  label || KIND_LABELS[kind] || KIND_LABELS.action!;
