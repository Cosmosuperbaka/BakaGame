import { render, screen } from "@testing-library/react";
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
    playerCount: 2,
    spectatorCount: 3,
    onlineCount: 5,
    maxPlayers: 8,
    visibility: "public",
    hasPassword: true,
    allowSpectators: true,
  },
  {
    roomId: "1234",
    name: "日常听歌房",
    phase: "waiting",
    playerCount: 5,
    spectatorCount: 0,
    onlineCount: 5,
    maxPlayers: 8,
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

  it("当房间列表为空时渲染空状态提示", () => {
    useSonGuessrStore.setState({ rooms: [] });
    renderPage();

    expect(screen.getByText("暂无房间，点击上方按钮创建一个吧")).toBeInTheDocument();
  });

  it("正常渲染房间列表卡片，且列表项外壳具备实底不透明背景类", () => {
    useSonGuessrStore.setState({ rooms: mockRooms });
    renderPage();

    expect(screen.getByText("绫地喰喰的房间")).toBeInTheDocument();
    expect(screen.getByText("8629")).toBeInTheDocument();
    expect(screen.getByText("2玩家 3观战")).toBeInTheDocument();
    expect(screen.getByText("游戏中")).toBeInTheDocument();
    expect(screen.getByText("可观战")).toBeInTheDocument();

    expect(screen.getByText("日常听歌房")).toBeInTheDocument();
    expect(screen.getByText("1234")).toBeInTheDocument();
    expect(screen.getByText("5玩家")).toBeInTheDocument();
    expect(screen.queryByText(/0观战/)).not.toBeInTheDocument();
    expect(screen.getByText("等待中")).toBeInTheDocument();
    expect(screen.getByText("禁观战")).toBeInTheDocument();

    // 验证外层卡片容器应用了 rounded-md 与 bg-card 实底类，杜绝透光穿透
    const roomOneName = screen.getByText("绫地喰喰的房间");
    const cardElement = roomOneName.closest('[role="button"]');
    expect(cardElement).toBeInTheDocument();
    const motionWrapper = cardElement?.parentElement;
    expect(motionWrapper).toHaveClass("bg-card");
    expect(motionWrapper).toHaveClass("rounded-md");
  });
});
