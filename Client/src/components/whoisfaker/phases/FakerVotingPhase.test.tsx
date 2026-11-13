import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ABSTAIN_TARGET_ID, ROOM_ID_TEST_MODE } from "@bakagame/shared/values";
import type { WhoIsFakerRoomSnapshot } from "@bakagame/shared";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { WIF_PEOPLE, wifPrivate, wifSnapshot } from "@/stories/fixtures/WhoIsFaker";
import { FakerPrivilegedActionPreview } from "../layout/FakerPrivilegedActionPreview";
import { FakerVotingPhase } from "./FakerVotingPhase";

const { me, peach, kita, azumi, stone, host } = WIF_PEOPLE;
const participants = [me, peach, kita, azumi];
const candidateIds = [peach.id, kita.id];
const sendCommand = vi.fn().mockResolvedValue({});

// 与服务端 ensureCanVote 相同的输入边界：PK 候选不投票，其他存活者只能投候选或弃票。
// 仅替代命令传输，真实 Store、投票组件和主持人预览组件都运行。
function preset(
  phase: "voting" | "tieBreak",
  viewer: Parameters<typeof wifPrivate>[0] = me,
  testMode = false
) {
  const base = wifSnapshot("vote1");
  const selectedIds = [...participants, stone, host].map((person) => person.id);
  const snapshot: WhoIsFakerRoomSnapshot = {
    ...base,
    roomId: testMode ? ROOM_ID_TEST_MODE : base.roomId,
    testMode,
    status: {
      ...base.status,
      phase,
      ...(phase === "tieBreak" ? { tieBreakCandidateIds: candidateIds } : {}),
    },
    players: base.players
      .filter((player) => selectedIds.some((id) => id === player.id))
      .map((player) => ({
        ...player,
        roundStatus:
          player.id === stone.id ? "dead" : player.id === host.id ? "questioner" : "alive",
      })),
  };
  const privateState = wifPrivate(viewer, "vote1", { myCurrentVoteTargetId: undefined });
  useWhoIsFakerStore.setState({ snapshot, privateState, sendCommand });
  return { snapshot, privateState };
}

beforeEach(() => {
  useWhoIsFakerStore.setState(useWhoIsFakerStore.getInitialState(), true);
  sendCommand.mockClear();
});
afterEach(() => {
  cleanup();
  useWhoIsFakerStore.setState(useWhoIsFakerStore.getInitialState(), true);
});

describe.each([false, true])("投票权限 UI（testMode=%s）", (testMode) => {
  it.each([peach, kita])("平票候选 $name 本人既不能投人，也不能弃票", (candidate) => {
    preset("tieBreak", candidate, testMode);
    render(<FakerVotingPhase />);
    expect(screen.getByText("平票 PK · 投票")).toBeVisible();
    expect(screen.getByText("你是平票候选人，本轮不参与投票。")).toBeVisible();
    expect(screen.queryByRole("button", { name: "弃票" })).not.toBeInTheDocument();
    for (const person of participants) {
      expect(screen.queryByRole("button", { name: person.name })).not.toBeInTheDocument();
    }
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("候选外存活玩家可投 PK 候选，但不能投自己、非候选或出局玩家", async () => {
    preset("tieBreak", me, testMode);
    render(<FakerVotingPhase />);
    for (const candidate of [peach, kita]) {
      expect(screen.getByRole("button", { name: candidate.name })).toBeEnabled();
    }
    for (const excluded of [me, azumi, stone, host]) {
      expect(screen.queryByRole("button", { name: excluded.name })).not.toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole("button", { name: peach.name }));
    await waitFor(() =>
      expect(sendCommand).toHaveBeenCalledExactlyOnceWith("game.submitVote", { targetId: peach.id })
    );
  });

  it("候选外存活玩家可在 PK 中弃票", async () => {
    preset("tieBreak", me, testMode);
    render(<FakerVotingPhase />);
    const abstain = screen.getByRole("button", { name: "弃票" });
    expect(abstain).toBeEnabled();
    fireEvent.click(abstain);
    await waitFor(() =>
      expect(sendCommand).toHaveBeenCalledExactlyOnceWith("game.submitVote", {
        targetId: ABSTAIN_TARGET_ID,
      })
    );
  });

  it("普通投票中同一候选玩家可以投其他存活者，仍不能自投或投出局者", async () => {
    preset("voting", peach, testMode);
    render(<FakerVotingPhase />);
    expect(screen.getByText("投票阶段")).toBeVisible();
    expect(screen.queryByText("你是平票候选人，本轮不参与投票。")).not.toBeInTheDocument();
    for (const target of [me, kita, azumi]) {
      expect(screen.getByRole("button", { name: target.name })).toBeEnabled();
    }
    for (const excluded of [peach, stone, host]) {
      expect(screen.queryByRole("button", { name: excluded.name })).not.toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole("button", { name: azumi.name }));
    await waitFor(() =>
      expect(sendCommand).toHaveBeenCalledExactlyOnceWith("game.submitVote", { targetId: azumi.id })
    );
  });

  it("普通投票中同一候选玩家可以弃票", async () => {
    preset("voting", peach, testMode);
    render(<FakerVotingPhase />);
    fireEvent.click(screen.getByRole("button", { name: "弃票" }));
    await waitFor(() =>
      expect(sendCommand).toHaveBeenCalledExactlyOnceWith("game.submitVote", {
        targetId: ABSTAIN_TARGET_ID,
      })
    );
  });
});

/** 服务端确认投票后下发的私有状态。 */
const castVote = (targetId: string) =>
  act(() =>
    useWhoIsFakerStore.setState((state) => ({
      privateState: { ...state.privateState!, myCurrentVoteTargetId: targetId },
    }))
  );

describe("投票回执的可访问性", () => {
  it("回执写进常驻的状态播报节点，节点先存在、再换文案", () => {
    preset("voting", me);
    render(<FakerVotingPhase />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("");
    castVote(peach.id);
    expect(screen.getByRole("status")).toBe(status);
    expect(status).toHaveTextContent(`已完成投票，投给 ${peach.name}`);
  });

  it("弃票的回执同样播报", () => {
    preset("voting", me);
    render(<FakerVotingPhase />);
    castVote(ABSTAIN_TARGET_ID);
    expect(screen.getByRole("status")).toHaveTextContent("已弃票，本轮不投出任何一票");
  });

  it("点选投票后选项卸载，焦点落到回执的「撤销」上而不是丢到页面根", async () => {
    preset("voting", me);
    render(<FakerVotingPhase />);
    const option = screen.getByRole("button", { name: peach.name });
    option.focus();
    fireEvent.click(option);
    await waitFor(() => expect(sendCommand).toHaveBeenCalled());
    castVote(peach.id);
    await waitFor(() => expect(screen.getByRole("button", { name: "撤销" })).toHaveFocus());
  });

  it("刷新后已投过票，回执出现时不抢走焦点", () => {
    preset("voting", me);
    useWhoIsFakerStore.setState((state) => ({
      privateState: { ...state.privateState!, myCurrentVoteTargetId: peach.id },
    }));
    render(<FakerVotingPhase />);
    expect(screen.getByRole("button", { name: "撤销" })).not.toHaveFocus();
  });
});

describe("主持人投票预览的资格口径", () => {
  it("PK 仅等待候选外存活者，候选人仍作为计票目标展示", () => {
    preset("tieBreak", host);
    useWhoIsFakerStore.setState((state) => ({
      privateState: {
        ...state.privateState!,
        privilegedActionPreview: { votes: [], nightActions: [] },
      },
    }));
    render(<FakerPrivilegedActionPreview mode="vote" />);
    const preview = within(screen.getByRole("region", { name: "投票预览" }));
    expect(preview.getAllByText("等待投票", { exact: true })).toHaveLength(2);
    // 候选姓名只出现于计票目标卡，不应再列入待投票者。
    for (const candidate of [peach, kita]) {
      expect(preview.getAllByText(candidate.name, { exact: true })).toHaveLength(1);
    }
    for (const voter of [me, azumi]) {
      expect(preview.getByText(voter.name, { exact: true })).toBeVisible();
    }
    expect(preview.queryByText(stone.name, { exact: true })).not.toBeInTheDocument();
    expect(preview.queryByText(host.name, { exact: true })).not.toBeInTheDocument();
  });

  it("普通投票仍等待所有存活参与者，包括相同两名玩家", () => {
    preset("voting", host);
    useWhoIsFakerStore.setState((state) => ({
      privateState: {
        ...state.privateState!,
        privilegedActionPreview: { votes: [], nightActions: [] },
      },
    }));
    render(<FakerPrivilegedActionPreview mode="vote" />);
    const preview = within(screen.getByRole("region", { name: "投票预览" }));
    expect(preview.getAllByText("等待投票", { exact: true })).toHaveLength(4);
    for (const participant of participants) {
      expect(preview.getAllByText(participant.name, { exact: true })).toHaveLength(2);
    }
    expect(preview.queryByText(stone.name, { exact: true })).not.toBeInTheDocument();
  });

  it("候选外玩家投票和弃票后，不再虚假等待 PK 候选提交", () => {
    preset("tieBreak", host);
    useWhoIsFakerStore.setState((state) => ({
      privateState: {
        ...state.privateState!,
        privilegedActionPreview: {
          votes: [
            { voterId: me.id, targetId: peach.id },
            { voterId: azumi.id, targetId: ABSTAIN_TARGET_ID },
          ],
          nightActions: [],
        },
      },
    }));
    render(<FakerPrivilegedActionPreview mode="vote" />);
    const preview = within(screen.getByRole("region", { name: "投票预览" }));
    expect(preview.queryByText("等待投票", { exact: true })).not.toBeInTheDocument();
    expect(preview.getAllByText("弃票", { exact: true })).toHaveLength(2);
    expect(preview.getAllByText("1", { exact: true })).toHaveLength(2);
    expect(preview.getByText("0", { exact: true })).toBeVisible();
    expect(preview.getAllByText(peach.name, { exact: true })).toHaveLength(2);
    expect(preview.getAllByText(kita.name, { exact: true })).toHaveLength(1);
  });

  it("普通玩家不获取主持人的私有投票预览", () => {
    preset("tieBreak", me);
    render(<FakerPrivilegedActionPreview mode="vote" />);
    expect(screen.queryByRole("region", { name: "投票预览" })).not.toBeInTheDocument();
  });
});
