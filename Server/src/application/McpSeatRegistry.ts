import type { GameId } from "../shared/Protocol";
import { createHash, randomUUID } from "node:crypto";

type SeatGame = GameId;

export interface McpController {
  roomId: string;
  playerId: string;
  connectionId: string;
  tokenHash: string;
  pairedAt: number;
}

const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

const seatKey = (roomId: string, playerId: string): string => `${roomId}:${playerId}`;

/**
 * MCP 座位控制器登记，只存在于进程内存：
 * 人类会话凭证只用于首次认领，之后 Agent 使用独立的控制器令牌；
 * 停机/重启后控制器自然失效，人类座位恢复手动。
 */
export class McpSeatRegistry {
  private readonly controllers = new Map<string, McpController>();
  private readonly controllersByToken = new Map<string, McpController>();

  constructor(private readonly now: () => number = Date.now) {}

  controllerFor(roomId: string, playerId: string): McpController | undefined {
    return this.controllers.get(seatKey(roomId, playerId));
  }

  isControlled(roomId: string, playerId: string): boolean {
    return this.controllers.has(seatKey(roomId, playerId));
  }

  isController(roomId: string, playerId: string, connectionId: string): boolean {
    return this.controllers.get(seatKey(roomId, playerId))?.connectionId === connectionId;
  }

  /** 首次认领：登记控制器并签发独立的控制器令牌；同一座位已被别的连接控制时拒绝。 */
  bind(
    roomId: string,
    playerId: string,
    connectionId: string
  ): { token: string; controller: McpController } {
    const key = seatKey(roomId, playerId);
    const existing = this.controllers.get(key);
    if (existing && existing.connectionId !== connectionId) {
      throw Object.assign(new Error("该座位已被另一个 MCP 连接控制"), {
        code: "MCP_SEAT_TAKEN",
      });
    }
    const token = randomUUID().replace(/-/g, "");
    const controller: McpController = {
      roomId,
      playerId,
      connectionId,
      tokenHash: hashToken(token),
      pairedAt: this.now(),
    };
    this.controllers.set(key, controller);
    this.controllersByToken.set(controller.tokenHash, controller);
    return { token, controller };
  }

  findByControllerToken(token: string): McpController | undefined {
    return this.controllersByToken.get(hashToken(token.trim()));
  }

  matchesControllerToken(roomId: string, playerId: string, token: string): boolean {
    return this.controllers.get(seatKey(roomId, playerId))?.tokenHash === hashToken(token.trim());
  }

  rebind(
    controller: McpController,
    connectionId: string
  ): { token: string; controller: McpController } {
    const previousToken = controller.tokenHash;
    const token = randomUUID().replace(/-/g, "");
    const next: McpController = {
      ...controller,
      connectionId,
      tokenHash: hashToken(token),
    };
    this.controllers.set(seatKey(next.roomId, next.playerId), next);
    this.controllersByToken.delete(previousToken);
    this.controllersByToken.set(next.tokenHash, next);
    return { token, controller: next };
  }

  unbind(roomId: string, playerId: string): McpController | undefined {
    const key = seatKey(roomId, playerId);
    const controller = this.controllers.get(key);
    if (!controller) return undefined;
    this.controllers.delete(key);
    this.controllersByToken.delete(controller.tokenHash);
    return controller;
  }

  unbindByConnection(connectionId: string): McpController | undefined {
    for (const controller of this.controllers.values()) {
      if (controller.connectionId === connectionId) {
        return this.unbind(controller.roomId, controller.playerId);
      }
    }
    return undefined;
  }

  clearRoom(roomId: string): void {
    for (const [key, controller] of this.controllers) {
      if (controller.roomId !== roomId) continue;
      this.controllers.delete(key);
      this.controllersByToken.delete(controller.tokenHash);
    }
  }
}

const MINIMAL_PRIVATE: Record<SeatGame, Record<string, unknown>> = {
  faker: { isQuestioner: false },
  song: {
    isSubmitter: false,
    teamObserver: false,
    submitterCandidateIds: [],
    canSubmitSong: false,
    canGuess: false,
    canGiveUp: false,
    remainingGuesses: 0,
    visibleAttempts: [],
  },
  cee: {
    canGuess: false,
    canSurrender: false,
    canStart: false,
    canSetAnswer: false,
    setterCandidateIds: [],
    guesses: [],
    answer: null,
    hints: [],
    imageHintAvailable: false,
    imageHintLevel: 0,
    deadlineAt: null,
    bannedCharacterIds: [],
    spectatePending: false,
  },
};

/**
 * 交给接管座位的人类查看器的脱敏私有状态：保留渲染当前控件所需的身份位、能力位与公开派生值，
 * 清掉词语、答案、提示、猜测记录等私有内容。保留能力位不是泄露：出题人/主持人/作答资格
 * 本来就能从公开快照推出；不保留它们，人类页面会收起对应控件，Agent 的控件级焦点就无处可落。
 */
const REDACTED_KEYS: Record<SeatGame, readonly string[]> = {
  faker: [
    "role",
    "isQuestioner",
    "canSubmitBlankGuess",
    "blankGuessUsed",
    "nightActionSubmitted",
    "myCurrentVoteTargetId",
    "myCurrentNightTargetId",
  ],
  song: [
    "isSubmitter",
    "teamObserver",
    "submitterCandidateIds",
    "canSubmitSong",
    "canGuess",
    "canGiveUp",
    "remainingGuesses",
    "guessDeadlineAt",
  ],
  cee: [
    "canGuess",
    "canSurrender",
    "canStart",
    "canSetAnswer",
    "setterCandidateIds",
    "imageHintAvailable",
    "imageHintLevel",
    "deadlineAt",
    "bannedCharacterIds",
    "spectatePending",
  ],
};

/**
 * 控制器连接收到完整私有状态，但人类会话凭证除外：它只用于首次认领，之后 Agent 一律凭控制器令牌。
 * 把原始凭证随私有状态继续推给 Agent，等于让它绕开控制器令牌、直接以人类身份重连或发命令。
 */
export const controllerPrivateState = <T extends object>(state: T): T =>
  "sessionToken" in state ? { ...state, sessionToken: "" } : state;

export const redactPrivateState = (
  game: SeatGame,
  state: Record<string, unknown>
): Record<string, unknown> => {
  const redacted: Record<string, unknown> = {
    ...MINIMAL_PRIVATE[game],
    playerId: state.playerId,
    sessionToken: state.sessionToken,
    mcpControlled: true,
  };
  for (const key of REDACTED_KEYS[game]) {
    if (key in state) redacted[key] = state[key];
  }
  return redacted;
};
