import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultCEESettings, type CEERoomSnapshot } from "@bakagame/shared";

const { playSound } = vi.hoisted(() => ({ playSound: vi.fn() }));

vi.mock("@/lib/SoundEffects", () => ({ playSound }));

import { handleCEEMessage, resetCEEStateSync } from "./UseCEEStore";

const snapshot: CEERoomSnapshot = {
  roomId: "1234",
  source: "native",
  name: "测试",
  visibility: "public",
  hasPassword: false,
  allowSpectators: true,
  hostPlayerId: "p1",
  phase: "guessing",
  settings: createDefaultCEESettings(),
  players: [],
  roundNumber: 1,
  syncRound: 1,
  setterPlayerId: "p1",
  phaseDeadlineAt: null,
  chat: [],
  roundSummary: null,
  upstreamConnected: true,
  bakaAntiCheat: false,
  spectateRequests: [],
};

let revision = 0;
const pushSnapshot = (state: CEERoomSnapshot) => {
  revision += 1;
  handleCEEMessage({
    type: "event",
    event: "cee.room.snapshot",
    payload: { mode: "full", revision, state },
  } as never);
};

afterEach(() => {
  resetCEEStateSync();
  playSound.mockClear();
  revision = 0;
});

describe("CEE 开局音效", () => {
  it("does not sound when the first snapshot restores an ongoing round", () => {
    pushSnapshot(snapshot);
    expect(playSound).not.toHaveBeenCalled();
  });

  it("sounds once when the round number advances into guessing", () => {
    pushSnapshot(snapshot);
    pushSnapshot({ ...snapshot, roundNumber: 2 });
    expect(playSound).toHaveBeenCalledTimes(1);
    expect(playSound).toHaveBeenCalledWith("roundStart");
  });

  it("does not sound when a late full sync arrives after the round already ended", () => {
    pushSnapshot(snapshot);
    pushSnapshot({ ...snapshot, roundNumber: 2, phase: "settled" });
    expect(playSound).not.toHaveBeenCalled();
  });

  it("does not sound after a reconnect resets the sync baseline", () => {
    pushSnapshot(snapshot);
    resetCEEStateSync();
    pushSnapshot({ ...snapshot, roundNumber: 2 });
    expect(playSound).not.toHaveBeenCalled();
  });
});
