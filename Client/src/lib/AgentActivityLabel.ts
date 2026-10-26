/**
 * Agent 活动的中文标签：站点首页指示器与房间内的焦点浮层共用这一张表。
 * 新增焦点类型时只改这里，两个落点不会各说各话。
 */
const KIND_LABELS: Record<string, string> = {
  site: "正在浏览站点",
  lobby: "正在查看大厅",
  enter_room: "已进入房间",
  state: "正在查看房间状态",
  private_state: "正在查看自己的身份",
  record: "正在查看结算",
  song_search: "正在检索歌曲/番剧",
  song_audio: "正在听本回合音频",
  cee_search: "正在检索角色资料",
  vote: "正在投票",
  describe: "正在发言",
  submit_words: "正在提交出题词语",
  submit_song: "正在提交出题歌曲",
  guess: "正在作答",
  set_answer: "正在设置谜底",
  image_hint: "正在查看角色提示",
  chat: "正在发送聊天",
  settings: "正在修改房间设置",
  claim: "已接管座位",
  action: "正在操作",
};

export const AGENT_ACTION_LABELS: Record<string, string> = {
  focus: "正在看",
  type: "正在输入",
  press: "正在按键",
  click: "正在点击",
  set: "正在设置",
};

/** `label` 是 Agent 自报的更具体位置（如页面标题），用它取代泛化标签。 */
export const agentActivityLabel = (kind: string, label?: string): string =>
  label || KIND_LABELS[kind] || KIND_LABELS.action!;
