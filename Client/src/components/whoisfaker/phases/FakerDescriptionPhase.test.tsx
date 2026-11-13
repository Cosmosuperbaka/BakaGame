import { fireEvent, render, screen, within } from "@testing-library/react";
import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WhoIsFakerPrivateState, WhoIsFakerRoomSnapshot } from "@bakagame/shared";
import { recordClockSample, resetClockSample } from "@/stores/UseServerClock";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { FakerDescriptionPhase } from "./FakerDescriptionPhase";

const snapshot: WhoIsFakerRoomSnapshot = {
  roomId: "1234",
  name: "测试房间",
  visibility: "public",
  allowSpectators: true,
  hasPassword: false,
  hostPlayerId: "host_1",
  testMode: false,
  roleLimits: {
    maxUndercoverCount: 1,
    canEnableAngel: false,
    canEnableBlank: false,
  },
  settings: {
    roleConfig: { undercoverCount: 1, hasAngel: false, hasBlank: false },
  },
  status: {
    phase: "description",
    speechMode: "normal",
    started: true,
    day: 1,
    questionerPlayerId: "host_1",
    descriptionOrder: ["player_2", "player_3"],
    // 服务端在发言阶段总会下发当前这一列的名单，客户端只认它
    speechOrder: ["player_2", "player_3"],
    submittedSpeechPlayerIds: [],
  },
  players: [
    {
      id: "host_1",
      name: "出题人",
      score: 0,
      membership: "active",
      online: true,
      isReady: true,
      isBot: false,
      isHost: true,
      roundStatus: "alive",
    },
    {
      id: "player_2",
      name: "玩家2",
      score: 0,
      membership: "active",
      online: true,
      isReady: true,
      isBot: false,
      isHost: false,
      roundStatus: "alive",
    },
    {
      id: "player_3",
      name: "玩家3",
      score: 0,
      membership: "active",
      online: true,
      isReady: true,
      isBot: false,
      isHost: false,
      roundStatus: "alive",
    },
  ],
  descriptions: [],
  chat: [],
};

const privateState: WhoIsFakerPrivateState = {
  playerId: "player_2",
  sessionToken: "session_token",
  isQuestioner: false,
  canSubmitBlankGuess: false,
  blankGuessUsed: false,
  nightActionSubmitted: false,
};

type SendCommand = ReturnType<typeof useWhoIsFakerStore.getState>["sendCommand"];
/** 测试里的命令发送器只关心调用记录，签名交给 store 的类型兜住。 */
const asSend = (mock: ReturnType<typeof vi.fn>) => mock as unknown as SendCommand;

const NOW = 1_700_000_000_000;

/** 带阶段倒计时的描述阶段快照；`endsAt` 是服务端时间轴上的截止时刻。 */
const withTimer = (endsAt: number): WhoIsFakerRoomSnapshot => ({
  ...snapshot,
  status: {
    ...snapshot.status,
    phaseTimer: { durationSeconds: 60, endsAt, phase: "description" as const },
  },
});

function mountWithTimer(endsAt: number, sendCommand: ReturnType<typeof vi.fn>) {
  useWhoIsFakerStore.setState({
    snapshot: withTimer(endsAt),
    privateState,
    sendCommand: asSend(sendCommand),
  });
  const view = render(<FakerDescriptionPhase />);
  fireEvent.change(screen.getByPlaceholderText("输入你的描述..."), {
    target: { value: "我的词语是红色的" },
  });
  return view;
}

const submitCalls = (mock: ReturnType<typeof vi.fn>) =>
  mock.mock.calls.filter(([type]) => type === "game.submitDescription");

/** 分小步推进、每步单独 act：React 才会在步与步之间真的渲染，「提交中」的亮灭才看得见。 */
const advance = async (ms: number) => {
  for (let left = ms; left > 0; left -= 25) {
    await act(async () => void (await vi.advanceTimersByTimeAsync(Math.min(25, left))));
  }
};

describe("DescriptionPhase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    resetClockSample();
    vi.useRealTimers();
  });

  it("发言表只按服务端下发的 speechOrder 与 submittedSpeechPlayerIds 排列", () => {
    useWhoIsFakerStore.setState({
      snapshot: {
        ...snapshot,
        status: {
          ...snapshot.status,
          // 与下发的名单不一致的旧字段不能影响结果
          descriptionOrder: ["player_2", "player_3"],
          speechOrder: ["player_3", "player_2"],
          submittedSpeechPlayerIds: ["player_3"],
        },
      },
      privateState,
    });
    render(<FakerDescriptionPhase />);
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getByRole("rowheader").textContent)).toEqual([
      "玩家3",
      "玩家2",
    ]);
    // 玩家3 已提交但内容未公开；轮到本人（玩家2）发言
    expect(screen.getByPlaceholderText("输入你的描述...")).toBeInTheDocument();
  });

  it("当阶段倒计时归零且输入框有内容时，自动提交发言", async () => {
    const sendCommand = vi.fn().mockResolvedValue({});
    mountWithTimer(NOW + 10_000, sendCommand);
    await advance(9_900);
    expect(submitCalls(sendCommand)).toHaveLength(0);
    await advance(200);
    expect(submitCalls(sendCommand)).toEqual([
      ["game.submitDescription", { text: "我的词语是红色的" }],
    ]);
  });

  it("本机时钟比服务端快时，在校正后的到点时刻才提交", async () => {
    // 本机快 5 秒：服务端此刻是 NOW - 5000，截止时刻（服务端时间轴）NOW + 10000 还有 15 秒
    recordClockSample(NOW - 5_000, NOW, NOW);
    const sendCommand = vi.fn().mockResolvedValue({});
    mountWithTimer(NOW + 10_000, sendCommand);
    await advance(14_900);
    expect(submitCalls(sendCommand)).toHaveLength(0);
    await advance(200);
    expect(submitCalls(sendCommand)).toHaveLength(1);
  });

  it("本机时钟比服务端慢时，在校正后的到点时刻就提交，不等本机钟走到", async () => {
    // 本机慢 5 秒：服务端此刻是 NOW + 5000，离截止只剩 5 秒
    recordClockSample(NOW + 5_000, NOW, NOW);
    const sendCommand = vi.fn().mockResolvedValue({});
    mountWithTimer(NOW + 10_000, sendCommand);
    await advance(4_900);
    expect(submitCalls(sendCommand)).toHaveLength(0);
    await advance(200);
    expect(submitCalls(sendCommand)).toHaveLength(1);
  });

  it("提交被拒后不循环重试，同一截止时刻只自动提交一次", async () => {
    // 真实网络下失败总在渲染之后才回来，「提交中」会真的亮一次再复位；立即 reject 看不出循环
    const sendCommand = vi.fn(
      () => new Promise((_, reject) => setTimeout(() => reject(new Error("阶段已变化")), 50))
    );
    useWhoIsFakerStore.setState({ addToast: vi.fn() });
    mountWithTimer(NOW + 1_000, sendCommand);
    await advance(1_100);
    expect(submitCalls(sendCommand)).toHaveLength(1);
    await advance(30_000);
    expect(submitCalls(sendCommand)).toHaveLength(1);
    expect(useWhoIsFakerStore.getState().addToast).toHaveBeenCalledTimes(1);
  });

  it("到点时输入框为空则不提交", async () => {
    const sendCommand = vi.fn().mockResolvedValue({});
    useWhoIsFakerStore.setState({
      snapshot: withTimer(NOW + 1_000),
      privateState,
      sendCommand: asSend(sendCommand),
    });
    render(<FakerDescriptionPhase />);
    await advance(2_000);
    expect(submitCalls(sendCommand)).toHaveLength(0);
  });
});
