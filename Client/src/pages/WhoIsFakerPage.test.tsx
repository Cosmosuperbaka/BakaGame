import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import type { WhoIsFakerRoomSummary } from "@/types";
import WhoIsFakerPage from "./WhoIsFakerPage";

const initialStoreState = useWhoIsFakerStore.getState();

const mockRooms: WhoIsFakerRoomSummary[] = [
  {
    roomId: "8629",
    name: "测试房间一",
    phase: "waiting",
    playerCount: 4,
    spectatorCount: 1,
    onlineCount: 5,
    hasPassword: true,
    allowSpectators: true,
    visibility: "public",
    testMode: false,
  },
  {
    roomId: "9999",
    name: "测试房间二",
    phase: "description",
    playerCount: 6,
    spectatorCount: 0,
    onlineCount: 6,
    hasPassword: false,
    allowSpectators: false,
    visibility: "public",
    testMode: false,
  },
];

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/whoisfaker"]}>
      <Routes>
        <Route path="/whoisfaker" element={<WhoIsFakerPage />} />
        <Route path="/whoisfaker/room/:id" element={<div data-testid="room-target" />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("WhoIsFakerPage 房间列表渲染与卡片隔离", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWhoIsFakerStore.setState(initialStoreState, true);
  });

  afterEach(() => {
    useWhoIsFakerStore.setState(initialStoreState, true);
  });

  it("当房间列表为空且已连接时渲染空状态提示", () => {
    useWhoIsFakerStore.setState({ rooms: [], connected: true, lobbyReady: true });
    renderPage();

    const empty = screen.getByText("暂无房间").closest('[role="status"]');
    expect(empty).not.toBeNull();
    // 创建入口只有标题行一个，空状态里不再重复放按钮。
    expect(within(empty as HTMLElement).queryByRole("button")).toBeNull();
    expect(screen.getAllByRole("button", { name: "创建房间" })).toHaveLength(1);
  });

  it("已连接但首个房间列表未到时仍显示骨架屏", () => {
    useWhoIsFakerStore.setState({ rooms: [], connected: true, lobbyReady: false });
    renderPage();

    expect(screen.getByRole("status", { name: "正在加载房间列表" })).toBeInTheDocument();
    expect(screen.queryByText("暂无房间")).not.toBeInTheDocument();
  });

  it("房间列表到达时骨架原地淡出，房间卡片同时出现在它之上", async () => {
    useWhoIsFakerStore.setState({ rooms: [], connected: true, lobbyReady: false });
    renderPage();
    const skeleton = screen.getByRole("status", { name: "正在加载房间列表" });

    act(() => useWhoIsFakerStore.setState({ rooms: mockRooms, lobbyReady: true }));

    // 交叉期间两者并存：骨架还在淡出，真实卡片已在同一格里、文档顺序在后（叠在骨架之上，点击落在卡片上）。
    const card = screen.getByText("测试房间一");
    expect(skeleton).toBeInTheDocument();
    expect(skeleton.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("status", { name: "正在加载房间列表" })).not.toBeInTheDocument());
    expect(screen.getByText("测试房间一")).toBeInTheDocument();
  });

  it("初次加载尚未完成握手同步时渲染骨架屏防御 FOES", () => {
    useWhoIsFakerStore.setState({ rooms: [], connected: false });
    renderPage();

    expect(screen.getByRole("status", { name: "正在加载房间列表" })).toBeInTheDocument();
    expect(screen.queryByText("暂无房间")).not.toBeInTheDocument();
  });

  it("正常渲染房间列表卡片，且列表项外壳具备实底不透明背景类", () => {
    useWhoIsFakerStore.setState({ rooms: mockRooms });
    renderPage();

    expect(screen.getByText("测试房间一")).toBeInTheDocument();
    expect(screen.getByText("8629")).toBeInTheDocument();
    expect(screen.getByText("等待中")).toBeInTheDocument();
    expect(screen.getByText("可旁观")).toBeInTheDocument();

    expect(screen.getByText("测试房间二")).toBeInTheDocument();
    expect(screen.getByText("9999")).toBeInTheDocument();
    expect(screen.getByText("游戏中")).toBeInTheDocument();
    expect(screen.getByText("禁止旁观")).toBeInTheDocument();

    const roomOne = screen.getByText("测试房间一").closest('[role="button"]');
    expect(roomOne).toHaveTextContent("4 人");
    expect(roomOne).toHaveTextContent("1 旁观");

    const roomTwo = screen.getByText("测试房间二").closest('[role="button"]');
    expect(roomTwo).toHaveTextContent("6 人");
    expect(roomTwo).toHaveTextContent("0 旁观");

    // 人数写成「4 人 · 1 旁观」一整段，等宽数字，不再给每个数字定宽右对齐。
    const counts = within(roomOne as HTMLElement).getByText(/4 人/);
    expect(counts).toHaveTextContent("4 人 · 1 旁观");
    expect(counts).toHaveClass("tabular-nums");

    // 验证外层卡片容器应用了 rounded-md 与 bg-card 实底类，杜绝透光穿透
    const roomOneName = screen.getByText("测试房间一");
    const cardElement = roomOneName.closest('[role="button"]');
    expect(cardElement).toBeInTheDocument();
    const motionWrapper = cardElement?.parentElement;
    expect(motionWrapper).toHaveClass("bg-card");
    expect(motionWrapper).toHaveClass("rounded-md");
  });

  it("用户名为空时创建与进房都就地拦下：标红输入框、聚焦并关联错误文案，不打开弹窗", () => {
    localStorage.removeItem("wif_username");
    useWhoIsFakerStore.setState({ rooms: mockRooms, connected: true, lobbyReady: true });
    const joinRoom = vi.fn();
    useWhoIsFakerStore.setState({ joinRoom, reconnectRoom: vi.fn().mockResolvedValue(false) });
    renderPage();

    const name = screen.getByRole("textbox", { name: "用户名" });
    expect(name).toHaveValue("");
    act(() => screen.getAllByRole("button", { name: "创建房间" })[0].click());
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveFocus();
    expect(name).toHaveAccessibleDescription("请先填写用户名");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    act(() => screen.getByRole("button", { name: /测试房间二/ }).click());
    expect(joinRoom).not.toHaveBeenCalled();

    // 一输入就撤下错误。
    fireEvent.change(name, { target: { value: "玩家" } });
    expect(name).not.toHaveAttribute("aria-invalid");
  });
});
