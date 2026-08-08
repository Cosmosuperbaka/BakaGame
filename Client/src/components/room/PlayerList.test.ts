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
