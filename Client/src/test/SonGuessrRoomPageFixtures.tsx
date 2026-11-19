import { cleanup, render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import type { SonGuessrPrivateState, SonGuessrRoomSnapshot } from "@bakagame/shared";
import SonGuessrRoomPage from "@/pages/SonGuessrRoomPage";

export const initialStoreState = useSonGuessrStore.getState();
export const mediaMethods = ["load", "play", "pause"] as const;
export const originalMediaDescriptors = new Map(
  mediaMethods.map((method) => [
    method,
    Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, method),
  ])
);

export const createMockSnapshot = (
  overrides: Partial<SonGuessrRoomSnapshot> = {}
): SonGuessrRoomSnapshot => ({
  roomId: "TEST_ROOM",
  name: "猜歌测试房",
  solo: false,
  visibility: "public",
  allowSpectators: true,
  hasPassword: false,
  testMode: false,
  musicAccountReady: true,
  hostPlayerId: "player-1",
  settings: {
    questionType: "song",
    questionMode: "manual",
    autoRotateSubmitter: false,
    autoFilters: { artists: [], minPopularity: 0 },
    lyricsLineCount: 4,
    showLyrics: true,
    bloodMode: false,
    maxGuessesPerRound: 5,
    guessDurationSeconds: 60,
    showGuessTimer: true,
  },
  phase: "waiting",
  roundNumber: 0,
  players: [
    {
      id: "player-1",
      name: "房主小明",
      score: 10,
      team: null,
      membership: "active",
      online: true,
      isReady: true,
      isBot: false,
      isHost: true,
      roundStatus: "waiting",
      correctGuesses: 0,
      totalGuesses: 0,
      roundMarks: [],
      guessesUsed: 0,
    },
    {
      id: "player-2",
      name: "玩家小红",
      score: 5,
      team: null,
      membership: "active",
      online: true,
      isReady: true,
      isBot: false,
      isHost: false,
      roundStatus: "waiting",
      correctGuesses: 0,
      totalGuesses: 0,
      roundMarks: [],
      guessesUsed: 0,
    },
  ],
  chat: [],
  ...overrides,
});

export const createMockPrivateState = (
  overrides: Partial<SonGuessrPrivateState> = {}
): SonGuessrPrivateState => ({
  playerId: "player-1",
  sessionToken: "token-1",
  isSubmitter: false,
  teamObserver: false,
  submitterCandidateIds: ["player-1", "player-2"],
  canSubmitSong: false,
  canGuess: false,
  canGiveUp: false,
  remainingGuesses: 5,
  visibleAttempts: [],
  ...overrides,
});

export function renderRoomPage(roomId = "TEST_ROOM") {
  return render(
    <MemoryRouter initialEntries={[`/songuessr/room/${roomId}`]}>
      <Routes>
        <Route path="/songuessr/room/:roomId" element={<SonGuessrRoomPage />} />
        <Route path="/songuessr" element={<div>Songuessr 游戏大厅</div>} />
      </Routes>
    </MemoryRouter>
  );
}

export function renderSoloPage() {
  return render(
    <MemoryRouter initialEntries={["/songuessr/solo"]}>
      <Routes>
        <Route path="/songuessr/solo" element={<SonGuessrRoomPage solo />} />
      </Routes>
    </MemoryRouter>
  );
}

export function registerRoomPageHooks() {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});

    useSonGuessrStore.setState({
      ...initialStoreState,
      roomId: "TEST_ROOM",
      connected: true,
      snapshot: createMockSnapshot(),
      privateState: createMockPrivateState(),
    });
  });

  afterEach(() => {
    try {
      // 先卸载真实组件，避免清理媒体或待提交草稿时调用已恢复的真实动作。
      cleanup();
    } finally {
      useSonGuessrStore.setState(initialStoreState, true);
      window.sessionStorage.removeItem("songuessr_solo_room");
      vi.restoreAllMocks();
      vi.useRealTimers();
    }

    for (const method of mediaMethods) {
      expect(Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, method)).toEqual(
        originalMediaDescriptors.get(method)
      );
    }
    expect(useSonGuessrStore.getState()).toBe(initialStoreState);
    expect(useSonGuessrStore.getState().sendCommand).toBe(initialStoreState.sendCommand);
  });
}
