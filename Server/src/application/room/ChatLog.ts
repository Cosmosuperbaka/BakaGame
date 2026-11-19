import {
  CHAT_LIMIT,
  CHAT_RATE_LIMIT_PER_CONNECTION,
  CHAT_RATE_LIMIT_WINDOW_MS,
} from "../../config/Constants";
import { AppError } from "../../domain/Errors";
import { normalizeWord } from "../../domain/Rules";
import { assertTextAllowed } from "../../infrastructure/SensitiveText";
import { SlidingWindowRateLimiter } from "../../infrastructure/RateLimiter";
import type { ChatChannel, ChatMessage } from "../../shared/Model";

/** 聊天受理：限流、文本规范化与敏感词、按滑动窗口追加、系统消息。下发形态各玩法自定。 */

export interface ChatError {
  code: string;
  message: string;
}

export const CHAT_RATE_LIMITED: ChatError = {
  code: "RATE_LIMITED",
  message: "发言过于频繁，请稍后再试",
};

/**
 * 每条连接的聊天额度：每条聊天都会扇出给全房，客户端防抖替代不了服务端配额。
 * 限流键是连接号；额度只来自公共常量。
 */
export class ChatLimiter {
  private readonly limiter: SlidingWindowRateLimiter;
  private readonly rejection: ChatError;

  constructor(
    private readonly options: {
      now: () => number;
      /**
       * TODO(行为统一)：CEE 今天在入口另设一组额度与文案，接入时传现值保持零变化；
       * 三款统一聊天额度后删掉这三项，只用公共常量。
       */
      windowMs?: number;
      maxRequests?: number;
      rejection?: ChatError;
    }
  ) {
    this.limiter = new SlidingWindowRateLimiter({
      windowMs: options.windowMs ?? CHAT_RATE_LIMIT_WINDOW_MS,
      maxRequests: options.maxRequests ?? CHAT_RATE_LIMIT_PER_CONNECTION,
    });
    this.rejection = options.rejection ?? CHAT_RATE_LIMITED;
  }

  consume(connectionId: string): void {
    if (!this.limiter.allow(connectionId, this.options.now())) {
      throw new AppError(this.rejection.code, this.rejection.message);
    }
  }
}

/**
 * 受理一条聊天文本：规范化（去控制字符、折叠空白）→ 截断 → 判空 → 敏感词。
 * 先截断再判空，与现有两款同序；敏感词按规范化后的文本判定，插空格的规避写法同样命中。
 */
export const acceptChatText = (
  raw: string,
  options: {
    /** TODO(行为统一)：卧底不截断，猜歌截 200，CEE 截 500；统一上限后改成固定值。 */
    maxLength: number | undefined;
    /** TODO(行为统一)：三款空消息码各不相同（见三款现值）；统一后改成固定值。 */
    emptyError: ChatError;
  }
): string => {
  const normalized = normalizeWord(raw);
  const text =
    options.maxLength === undefined ? normalized : normalized.slice(0, options.maxLength);
  if (!text) throw new AppError(options.emptyError.code, options.emptyError.message);
  assertTextAllowed(text);
  return text;
};

/**
 * 追加一条消息并保持滑动窗口形状：挤出最旧、追加最新，两端的补丁编码依赖这个形状。
 * 换一个新数组而不原地 push：上一份快照可能还引用着旧数组。
 */
export const appendChat = (
  room: { chat: ChatMessage[] },
  message: ChatMessage,
  limit: number = CHAT_LIMIT
): void => {
  const next = room.chat.slice(Math.max(0, room.chat.length + 1 - limit));
  next.push(message);
  room.chat = next;
};

/**
 * 系统消息的发送者占位。
 * TODO(行为统一)：卧底与猜歌用 `system` / `系统`，CEE 用两个空串。占位随快照下发，
 * 改 CEE 要先核对客户端渲染；接入时 CEE 传 `{ playerId: "", playerName: "" }`，统一后删掉参数。
 */
export const SYSTEM_SENDER = { playerId: "system", playerName: "系统" } as const;

export const systemMessage = (input: {
  id: string;
  text: string;
  createdAt: number;
  sender?: { playerId: string; playerName: string };
  channel?: ChatChannel;
}): ChatMessage => {
  const sender = input.sender ?? SYSTEM_SENDER;
  const message: ChatMessage = {
    id: input.id,
    playerId: sender.playerId,
    playerName: sender.playerName,
    text: input.text,
    createdAt: input.createdAt,
    system: true,
  };
  if (input.channel) message.channel = input.channel;
  return message;
};
