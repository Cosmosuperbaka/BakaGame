import { describe, expect, it } from "vitest";
import type { CEEPlayer, CEERoomSnapshot } from "@bakagame/shared";
import {
  ceeDisplayRound,
  ceePerspective,
  readCEESession,
  removeCEESession,
  writeCEESession,
} from "./CEESession";

function player(id: string, overrides: Partial<CEEPlayer> = {}): CEEPlayer {
  return {
    id,
    name: id,
    online: true,
    ready: true,
    team: null,
    membership: "active",
    score: 0,
    status: "playing",
    attempts: 0,
    marks: "",
    syncCompleted: false,
    ...overrides,
  };
}

function room(
  phase: CEERoomSnapshot["phase"],
  players: CEEPlayer[],
  setterPlayerId: string | null = null
) {
  return { phase, players, setterPlayerId };
}

describe("CEE 会话凭据", () => {
  it("只按统一房号存取，不同房号互不影响", () => {
    writeCEESession("1234", "first-token");
    writeCEESession("5678", "second-token");
    expect(readCEESession("1234")).toBe("first-token");
    expect(readCEESession("5678")).toBe("second-token");
    expect(readCEESession("9012")).toBeNull();
    removeCEESession("1234");
    expect(readCEESession("1234")).toBeNull();
    expect(readCEESession("5678")).toBe("second-token");
  });
});

describe("CEE 等价房号会话", () => {
  it("规范房号写入后支持大小写和空白读取及删除", () => {
    writeCEESession("Oblivionis", "canonical");
    expect(readCEESession(" oblivionis ")).toBe("canonical");
    removeCEESession(" OBLIVIONIS ");
    expect(readCEESession("Oblivionis")).toBeNull();
    writeCEESession(" 1234 ", "numeric");
    expect(readCEESession("1234")).toBe("numeric");
    expect(readCEESession("5678")).toBeNull();
  });
});

describe("CEE 顶栏局数", () => {
  it("准备与出题阶段显示即将开始的一局，其余阶段显示最近开始的一局", () => {
    expect(ceeDisplayRound("waiting", 0)).toBe(0);
    expect(ceeDisplayRound("preparing", 0)).toBe(1);
    expect(ceeDisplayRound("answering", 0)).toBe(1);
    expect(ceeDisplayRound("guessing", 1)).toBe(1);
    expect(ceeDisplayRound("settled", 1)).toBe(1);
    expect(ceeDisplayRound("waiting", 1)).toBe(1);
    expect(ceeDisplayRound("preparing", 1)).toBe(2);
  });
});

describe("CEE 顶栏视角", () => {
  it("出题人按 setterPlayerId 判定，出题阶段状态仍是等待也显示出题人视角", () => {
    expect(
      ceePerspective(
        room("answering", [player("setter", { status: "waiting" })], "setter"),
        "setter"
      )
    ).toBe("setter");
    expect(
      ceePerspective(
        room("guessing", [player("setter", { status: "observing" })], "setter"),
        "setter"
      )
    ).toBe("setter");
    expect(
      ceePerspective(
        room("settled", [player("setter", { status: "observing" })], "setter"),
        "setter"
      )
    ).toBe("setter");
  });

  it("旁观分组与本局观战的玩家都是旁观视角，正在猜的玩家没有视角徽章", () => {
    const players = [
      player("guest", { membership: "spectator", status: "observing" }),
      player("mate", { status: "observing" }),
      player("guesser"),
      player("done", { status: "solved" }),
    ];
    expect(ceePerspective(room("guessing", players, "setter"), "guest")).toBe("observer");
    expect(ceePerspective(room("guessing", players, "setter"), "mate")).toBe("observer");
    expect(ceePerspective(room("guessing", players, "setter"), "guesser")).toBeNull();
    expect(ceePerspective(room("guessing", players, "setter"), "done")).toBeNull();
  });

  it("等待阶段不属于任何一局，只有旁观分组显示旁观视角", () => {
    const players = [
      player("setter", { status: "observing" }),
      player("guest", { membership: "spectator", status: "waiting" }),
    ];
    expect(ceePerspective(room("waiting", players, "setter"), "setter")).toBeNull();
    expect(ceePerspective(room("waiting", players, "setter"), "guest")).toBe("observer");
    expect(ceePerspective(room("waiting", players), "missing")).toBeNull();
  });
});
