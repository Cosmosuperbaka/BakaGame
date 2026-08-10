import { describe, expect, it } from "vitest";

import type { PublicPlayerView } from "@/types";
import { buildKnownRoleMap, resolveStatus } from "./playerPresentation";

const createPlayer = (overrides: Partial<PublicPlayerView> = {}): PublicPlayerView => ({
  id: "player-1",
  name: "玩家",
  score: 0,
  membership: "active",
  online: true,
  isReady: false,
  isBot: false,
  isHost: false,
  roundStatus: "alive",
  ...overrides,
});

describe("player list presentation", () => {
  it("uses the server-revealed role for eliminated players", () => {
    const deadPlayer = createPlayer({
      roundStatus: "dead",
      revealedRole: "undercover",
    });

    expect(buildKnownRoleMap([deadPlayer]).get(deadPlayer.id)).toBe("undercover");
  });

  it("leaves the leading badge slot empty for eliminated players", () => {
    // 出局改用名字之后的骷髅图标表达，行首不再占一枚徽章。
    const deadPlayer = createPlayer({ roundStatus: "dead", revealedRole: "civilian" });

    expect(resolveStatus(deadPlayer, false, false)).toBeNull();
  });

  it("keeps the questioner badge even after elimination checks", () => {
    const questioner = createPlayer({ roundStatus: "questioner" });

    expect(resolveStatus(questioner, false, false)).toEqual({ label: "主持", tone: "violet" });
  });

  it("never renders readiness for spectators", () => {
    const spectator = createPlayer({
      membership: "spectator",
      roundStatus: "spectator",
      isReady: true,
    });

    expect(resolveStatus(spectator, true, false)).toEqual({
      label: "旁观",
      tone: "default",
    });
    expect(resolveStatus(spectator, true, true)).toBeNull();
  });
});
