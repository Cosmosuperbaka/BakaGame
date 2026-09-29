import { describe, expect, it } from "vitest";
import type { CCBPlayer, CCBRoomSnapshot } from "@bakagame/shared";
import { ccbDisplayRound, ccbPerspective, readCCBSession, removeCCBSession, writeCCBSession } from "./CCBSession";

function player(id: string, overrides: Partial<CCBPlayer> = {}): CCBPlayer {
  return { id, name: id, online: true, ready: true, team: null, membership: "active", score: 0, status: "playing", attempts: 0, marks: "", syncCompleted: false, ...overrides };
}

function room(phase: CCBRoomSnapshot["phase"], players: CCBPlayer[], setterPlayerId: string | null = null) {
  return { phase, players, setterPlayerId };
}

describe("CCB 会话凭据", () => {
  it("只按统一房号存取，不同房号互不影响", () => {
    writeCCBSession("1234", "first-token");
    writeCCBSession("5678", "second-token");
    expect(readCCBSession("1234")).toBe("first-token");
    expect(readCCBSession("5678")).toBe("second-token");
    expect(readCCBSession("9012")).toBeNull();
    removeCCBSession("1234");
    expect(readCCBSession("1234")).toBeNull();
    expect(readCCBSession("5678")).toBe("second-token");
  });
});

describe("CCB 顶栏局数", () => {
  it("准备与出题阶段显示即将开始的一局，其余阶段显示最近开始的一局", () => {
    expect(ccbDisplayRound("waiting", 0)).toBe(0);
    expect(ccbDisplayRound("preparing", 0)).toBe(1);
    expect(ccbDisplayRound("answering", 0)).toBe(1);
    expect(ccbDisplayRound("guessing", 1)).toBe(1);
    expect(ccbDisplayRound("settled", 1)).toBe(1);
    expect(ccbDisplayRound("waiting", 1)).toBe(1);
    expect(ccbDisplayRound("preparing", 1)).toBe(2);
  });
});

describe("CCB 顶栏视角", () => {
  it("出题人按 setterPlayerId 判定，出题阶段状态仍是等待也显示出题人视角", () => {
    expect(ccbPerspective(room("answering", [player("setter", { status: "waiting" })], "setter"), "setter")).toBe("setter");
    expect(ccbPerspective(room("guessing", [player("setter", { status: "observing" })], "setter"), "setter")).toBe("setter");
    expect(ccbPerspective(room("settled", [player("setter", { status: "observing" })], "setter"), "setter")).toBe("setter");
  });

  it("旁观分组与本局观战的玩家都是旁观视角，正在猜的玩家没有视角徽章", () => {
    const players = [player("guest", { membership: "spectator", status: "observing" }), player("mate", { status: "observing" }), player("guesser"), player("done", { status: "solved" })];
    expect(ccbPerspective(room("guessing", players, "setter"), "guest")).toBe("observer");
    expect(ccbPerspective(room("guessing", players, "setter"), "mate")).toBe("observer");
    expect(ccbPerspective(room("guessing", players, "setter"), "guesser")).toBeNull();
    expect(ccbPerspective(room("guessing", players, "setter"), "done")).toBeNull();
  });

  it("等待阶段不属于任何一局，只有旁观分组显示旁观视角", () => {
    const players = [player("setter", { status: "observing" }), player("guest", { membership: "spectator", status: "waiting" })];
    expect(ccbPerspective(room("waiting", players, "setter"), "setter")).toBeNull();
    expect(ccbPerspective(room("waiting", players, "setter"), "guest")).toBe("observer");
    expect(ccbPerspective(room("waiting", players), "missing")).toBeNull();
  });
});
