import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import type { SonGuessrRoomSummary } from "@bakagame/shared";
import SonGuessrPage from "./SonGuessrPage";

const initialStoreState = useSonGuessrStore.getState();

const mockRooms: SonGuessrRoomSummary[] = [
  {
    roomId: "8629",
    name: "绫地喰喰的房间",
    phase: "playing",
    questionType: "anime",
    playerCount: 2,
    spectatorCount: 3,
    onlineCount: 5,
    visibility: "public",
    hasPassword: true,
    allowSpectators: true,
  },
  {
    roomId: "1234",
    name: "日常听歌房",
    phase: "waiting",
    questionType: "song",
    playerCount: 5,
    spectatorCount: 0,
    onlineCount: 5,
    visibility: "public",
    hasPassword: false,
    allowSpectators: false,
  },
];

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/songuessr"]}>
      <Routes>
        <Route path="/songuessr" element={<SonGuessrPage />} />
        <Route path="/songuessr/room/:id" element={<div data-testid="room-target" />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("SonGuessrPage 房间列表渲染与卡片隔离", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSonGuessrStore.setState(initialStoreState, true);
  });

  afterEach(() => {
    useSonGuessrStore.setState(initialStoreState, true);
  });

  it("当房间列表为空且已连接时渲染空状态提示", () => {
    useSonGuessrStore.setState({ rooms: [], connected: true, lobbyReady: true });
    renderPage();

    const empty = screen.getByText("暂无房间").closest('[role="status"]');
    expect(empty).not.toBeNull();
    // 创建入口只有标题行一个，空状态里不再重复放按钮。
    expect(within(empty as HTMLElement).queryByRole("button")).toBeNull();
    expect(screen.getAllByRole("button", { name: "创建房间" })).toHaveLength(1);
  });

  it("已连接但首个房间列表未到时仍显示骨架屏", () => {
    useSonGuessrStore.setState({ rooms: [], connected: true, lobbyReady: false });
    renderPage();

    expect(screen.getByRole("status", { name: "正在加载房间列表" })).toBeInTheDocument();
    expect(screen.queryByText("暂无房间")).not.toBeInTheDocument();
  });

  it("初次加载尚未完成握手同步时渲染骨架屏防御 FOES", () => {
    useSonGuessrStore.setState({ rooms: [], connected: false });
    renderPage();

    expect(screen.getByRole("status", { name: "正在加载房间列表" })).toBeInTheDocument();
    expect(screen.queryByText("暂无房间")).not.toBeInTheDocument();
  });

  it("按房间展示阶段、人数、观战与密码语义", () => {
    useSonGuessrStore.setState({ rooms: mockRooms });
    renderPage();

    expect(screen.getByText("绫地喰喰的房间")).toBeInTheDocument();
    expect(screen.getByText("8629")).toBeInTheDocument();
    expect(screen.getByText("游戏中")).toBeInTheDocument();
    expect(screen.getByText("可旁观")).toBeInTheDocument();

    expect(screen.getByText("日常听歌房")).toBeInTheDocument();
    expect(screen.getByText("1234")).toBeInTheDocument();
    expect(screen.getByText("等待中")).toBeInTheDocument();
    expect(screen.getByText("禁止旁观")).toBeInTheDocument();

    const roomOne = screen.getByText("绫地喰喰的房间").closest('[role="button"]');
    expect(roomOne).toHaveTextContent("2 人");
    expect(roomOne).toHaveTextContent("3 旁观");

    const roomTwo = screen.getByText("日常听歌房").closest('[role="button"]');
    expect(roomTwo).toHaveTextContent("5 人");
    expect(roomTwo).toHaveTextContent("0 旁观");

    const first = screen.getByRole("button", { name: /绫地喰喰的房间/ });
    const second = screen.getByRole("button", { name: /日常听歌房/ });
    expect(within(first).getByText("听歌识番")).toBeInTheDocument();
    // 默认题型不挂标签，只有听歌识番的房间带。
    expect(within(second).queryByText("听歌识曲")).not.toBeInTheDocument();
    expect(within(first).getByLabelText("需要密码")).toBeInTheDocument();
    expect(within(second).queryByLabelText("需要密码")).not.toBeInTheDocument();
    expect(first).toHaveAttribute("tabindex", "0");
    expect(second).toHaveAttribute("tabindex", "0");
    expect(first).not.toHaveAttribute("aria-disabled", "true");

  });
});
