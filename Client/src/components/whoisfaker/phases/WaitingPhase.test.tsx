import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PrivateState, RoomSnapshot } from "@/types";
import { useWhoIsFakerStore as useGameStore } from "@/stores/UseWhoIsFakerStore";

import { WaitingPhase } from "./WaitingPhase";

const snapshot: RoomSnapshot = {
  roomId: "1234",
  name: "房间",
  visibility: "public",
  allowSpectators: true,
  hasPassword: false,
  hostPlayerId: "host",
  testMode: false,
  roleLimits: {
    maxUndercoverCount: 1,
    canEnableAngel: false,
    canEnableBlank: false,
  },
  settings: {
    roleConfig: { undercoverCount: 1, hasAngel: false, hasBlank: false },
  },
  status: { phase: "waiting", started: false, day: 0 },
  players: [
    {
      id: "host",
      name: "房主",
      score: 0,
      membership: "active",
      online: true,
      isReady: true,
      isBot: false,
      isHost: true,
      roundStatus: "waiting",
    },
    {
      id: "guest",
      name: "玩家",
      score: 0,
      membership: "active",
      online: true,
      isReady: false,
      isBot: false,
      isHost: false,
      roundStatus: "waiting",
    },
  ],
  descriptions: [],
  chat: [],
};

const privateState: PrivateState = {
  playerId: "guest",
  sessionToken: "session",
  isQuestioner: false,
  canSubmitBlankGuess: false,
  blankGuessUsed: false,
  nightActionSubmitted: false,
};

describe("waiting room sharing", () => {
  beforeEach(() => {
    useGameStore.setState({ snapshot, privateState });
  });

  it("lets a non-host copy the room link", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(<WaitingPhase />);
    fireEvent.click(screen.getByRole("button", { name: "复制" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/whoisfaker/room/1234`);
    });
    expect(screen.getByRole("button", { name: "已复制" })).toBeInTheDocument();
  });
});
