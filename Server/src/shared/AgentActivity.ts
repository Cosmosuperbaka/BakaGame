import { Type as t, type Static } from "@sinclair/typebox";

export const AGENT_FOCUS_KINDS = [
  "lobby",
  "enter_room",
  "state",
  "private_state",
  "record",
  "song_search",
  "song_audio",
  "cee_search",
  "vote",
  "describe",
  "submit_words",
  "submit_song",
  "guess",
  "set_answer",
  "image_hint",
  "chat",
  "settings",
  "claim",
  "action",
] as const;

export type AgentFocusKind = (typeof AGENT_FOCUS_KINDS)[number];

/** 房间页的五个界面区域；客户端按它把没有控件标记的焦点退回整块区域。 */
export const AGENT_FOCUS_PARTS = ["header", "player", "game", "chat", "settings", "dialog"] as const;

export type AgentFocusPart = (typeof AGENT_FOCUS_PARTS)[number];

/**
 * Agent 上报「正在看/操作哪个控件」。
 *
 * `input` 是逐步输入的当前文本，只发给被接管座位的人类查看器，不广播给同房其他玩家：
 * 搜索词、猜测和发言都可能提前泄露意图。
 */
export const AgentFocusInputSchema = t.Object(
  {
    agentName: t.String({ minLength: 1, maxLength: 32 }),
    tool: t.String({ minLength: 1, maxLength: 64 }),
    action: t.Optional(t.String({ maxLength: 64 })),
    // 用短字符串而不是字面量联合：把三款游戏的整张命令表推导到过深会导致类型实例化爆炸。
    // 真正的取值校验在服务端 handleAgentFocus 里按 AGENT_FOCUS_KINDS 做。
    kind: t.String({ minLength: 1, maxLength: 32 }),
    targetId: t.Optional(t.String({ maxLength: 64 })),
    controlId: t.Optional(t.String({ pattern: "^[A-Za-z0-9_.:-]{1,96}$" })),
    part: t.Optional(t.String({ maxLength: 16 })),
    label: t.Optional(t.String({ maxLength: 48 })),
    input: t.Optional(t.String({ maxLength: 200 })),
  },
  { additionalProperties: false }
);

export type AgentFocusInput = Static<typeof AgentFocusInputSchema>;

export const isAgentFocusKind = (value: string): value is AgentFocusKind =>
  (AGENT_FOCUS_KINDS as readonly string[]).includes(value);

export const isAgentFocusPart = (value: string): value is AgentFocusPart =>
  (AGENT_FOCUS_PARTS as readonly string[]).includes(value);

export interface AgentFocusEvent extends Omit<AgentFocusInput, "kind" | "part"> {
  kind: AgentFocusKind;
  part?: AgentFocusPart;
  game: "faker" | "song" | "cee";
  roomId?: string;
  playerId?: string;
  at: number;
}
