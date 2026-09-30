import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PrivateState, RoomSnapshot } from "@/types";
import { useWhoIsFakerStore as useGameStore } from "@/stores/UseWhoIsFakerStore";

import { WordSubmissionPhase } from "./WordSubmissionPhase";

const player = (id: string, name: string, isHost = false): RoomSnapshot["players"][number] => ({
  id,
  name,
  score: 0,
  membership: "active",
  online: true,
  isReady: true,
  isBot: false,
  isHost,
  roundStatus: "waiting",
});

// 主持人之外四名参与者：一名卧底、一名白板，余下两名平民。
const snapshot: RoomSnapshot = {
  roomId: "1234",
  name: "房间",
  visibility: "public",
  allowSpectators: true,
  hasPassword: false,
  hostPlayerId: "host",
  testMode: false,
  roleLimits: { maxUndercoverCount: 1, canEnableAngel: false, canEnableBlank: true },
  settings: { roleConfig: { undercoverCount: 1, hasAngel: false, hasBlank: true } },
  status: { phase: "wordSubmission", started: true, day: 0, questionerPlayerId: "host" },
  players: [
    player("host", "主持", true),
    player("a", "阿澄"),
    player("b", "桃子"),
    player("c", "北川"),
    player("d", "柚子"),
  ],
  descriptions: [],
  chat: [],
};

const privateState: PrivateState = {
  playerId: "host",
  sessionToken: "session",
  isQuestioner: true,
  canSubmitBlankGuess: false,
  blankGuessUsed: false,
  nightActionSubmitted: false,
};

/** 词语草稿由 GameArea 持有；这里用最小的受控外壳代替。 */
function Harness() {
  const [draft, setDraft] = useState({ civilianWord: "", undercoverWord: "", blankHint: "" });
  return <WordSubmissionPhase wordDraft={draft} onWordDraftChange={setDraft} />;
}

describe("word submission", () => {
  const sendCommand = vi.fn();

  beforeEach(() => {
    sendCommand.mockReset().mockResolvedValue({});
    useGameStore.setState({ snapshot, privateState, sendCommand });
  });

  it("词语输入框与随机分配开关由可见标签命名", () => {
    render(<Harness />);

    expect(screen.getByRole("textbox", { name: "平民词" })).toHaveAttribute("placeholder", "输入平民获得的词语");
    expect(screen.getByRole("textbox", { name: "卧底词" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "白板提示" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "随机分配身份" })).toHaveAttribute("aria-checked", "true");
  });

  it("按标签填写后提交词语，随机分配时不附带手动身份", async () => {
    render(<Harness />);

    fireEvent.change(screen.getByRole("textbox", { name: "平民词" }), { target: { value: " 饺子 " } });
    fireEvent.change(screen.getByRole("textbox", { name: "卧底词" }), { target: { value: "馄饨" } });
    fireEvent.change(screen.getByRole("textbox", { name: "白板提示" }), { target: { value: "一种面食" } });
    fireEvent.click(screen.getByRole("button", { name: "确认提交" }));

    await waitFor(() => {
      expect(sendCommand).toHaveBeenCalledWith("game.submitWords", {
        words: ["饺子", "馄饨"],
        blankHint: "一种面食",
        manualRoles: undefined,
      });
    });
  });

  it("关闭随机分配后展开逐人身份选择，并按房间配置预填", () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("switch", { name: "随机分配身份" }));

    expect(screen.getByRole("switch", { name: "随机分配身份" })).toHaveAttribute("aria-checked", "false");
    // 预填顺序：先卧底，再白板，其余平民。
    const pressedRole = (name: string) =>
      within(screen.getByRole("group", { name: `为 ${name} 分配身份` })).getByRole("button", { pressed: true });
    expect(pressedRole("阿澄")).toHaveAccessibleName("卧底");
    expect(pressedRole("桃子")).toHaveAccessibleName("白板");
    expect(pressedRole("北川")).toHaveAccessibleName("平民");
    expect(pressedRole("柚子")).toHaveAccessibleName("平民");
  });
});
