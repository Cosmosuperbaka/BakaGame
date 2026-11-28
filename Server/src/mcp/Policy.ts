/**
 * 猜歌的「不许查」规则。Agent 能拿到片段音频与歌词，查一下就等于直接拿到答案，
 * 所以这条与使用边界同级，并且在猜歌屏幕、播放反馈与接管页面的听片段回包里逐处重复，
 * Agent 无论从哪个入口进来都会看到。
 */
export const SONGUESSR_NO_SEARCH_RULE =
  "玩 SongGuessr（猜歌）时禁止任何形式的联网搜索与识别：不得搜索歌词、歌名、歌手、专辑或番剧，" +
  "不得调用听歌识曲、哼唱识别、音频指纹等识别接口或工具（联网服务与本机工具都不行），" +
  "也不得把片段音频或歌词发给任何外部服务；只能凭自己听到的音频和看到的歌词判断，再用游戏内的猜测搜索框作答。";

/**
 * MCP 的使用边界：随 initialize / server discover 一起下发给 Agent，
 * 不依赖某个客户端是否展示工具描述。
 */
export const MCP_POLICY = [
  "本 MCP 只能用于纯 Agent 自行游玩。",
  "严禁用于辅助人类作弊：不得代看答案、不得语音报点、不得与人类玩家实时协同作弊或代替人类作答。",
  "人类把标签页交给 Agent 后只能旁观，可以随时收回控制；Agent 不得诱导人类绕过这一点。",
  "Agent 看到的不超过这张标签页的主人能看到的内容；不得读取其他玩家的私有状态、答案或词对。",
  "管理后台、账号、登录等敏感页面与区域不向 Agent 开放，也不得诱导人类代为操作。",
  SONGUESSR_NO_SEARCH_RULE,
].join("\n");

export const MCP_INSTRUCTIONS = [
  MCP_POLICY,
  "",
  "先调用 tools/list 查看能力；不知道站点有什么时先调 get_site_map（站点地图），再用 visit_page 定位到某个大厅或只读页面。",
  "整条连接只有一个入口：/api/ws 同时承载三款游戏与站点活动，不需要也不应该为每款游戏各开一条连接。",
  "加入房间前确认房间支持 MCP（大厅摘要的 allowAgents 为 true），或由 Agent 自己 create_room。",
  "Agent 自己的座位没有浏览器页面：先 get_screen 看玩家页面（玩家栏、聊天栏、面板与控件），再用 ui_run 操作这些控件。没有屏幕之外的私有机密接口。",
  "必须像人类一样操作：输入前先 focus 输入框，type 只能作用于当前焦点；点搜索结果或按钮用 click。ui_run 与 page_act 都支持一次提交多个步骤串行执行，并返回每一步结果。",
  "ui_run 与 page_act 都会返回最新画面；不要假设动作已生效，以返回的画面为准。",
  "你的界面位置会实时显示在站点首页（哪款游戏、哪个房间、在做什么）；搜索词、猜测与聊天草稿不会广播，无需担心泄露。",
  "接管人类标签页：人类在任意页面的设置里开启后会得到 8 位配对码。用 control_page 认领后，page_state 看页面（文字、控件与状态），page_act 操作控件（navigate/click/focus/type/press/select/scroll），首页、大厅、房间内都是同一套；用完 release_page 交还。配对码一次有效；认领后人类刷新不影响接管，人类可以随时收回，3 分钟没有动作会自动交还。",
  "接管期间你用的就是这张标签页本来的座位，没有别的座位与凭证；create_room、join_room、get_screen、ui_run 只用于你自己的 Agent 座位，接管时不可用。",
  "SongGuessr 需要人类在房间内登录网易云或 QQ 音乐。播放回合里点 song.audio.play（接管页面时用 page_act 点「播放片段」），本回合的片段音频会作为 audio 内容块随结果返回；房间开着歌词时，歌词在 panel.audio.clip.lines（接管时就在页面上）。不提供任何音轨地址。",
  "猜歌/那个游戏的搜索框停止输入后会自动检索，点结果才提交；出题选歌会先打开片段确认，确认后才真正提交。",
].join("\n");

/** 协议版本协商的单一来源：stdio 与远程入口共用，避免两处分叉。 */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2026-07-28",
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
] as const;
export const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

/** 客户端请求的版本在支持表内就沿用，否则回服务端默认版本，不原样回显任意字符串。 */
export const protocolVersionOf = (requested: unknown): string =>
  typeof requested === "string" &&
  (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : DEFAULT_PROTOCOL_VERSION;
