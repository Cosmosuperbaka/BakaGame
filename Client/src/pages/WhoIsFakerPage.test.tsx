import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import type { RoomSummary } from "@/types";
import WhoIsFakerPage from "./WhoIsFakerPage";

const initialStoreState = useWhoIsFakerStore.getState();

const mockRooms: RoomSummary[] = [
  {
    roomId: "8629",
    name: "测试房间一",
    phase: "waiting",
    playerCount: 4,
    onlineCount: 2,
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

  it("当房间列表为空时渲染空状态提示", () => {
    useWhoIsFakerStore.setState({ rooms: [] });
    renderPage();

    expect(screen.getByText("暂无房间，点击上方按钮创建一个吧")).toBeInTheDocument();
  });

  it("正常渲染房间列表卡片，且列表项外壳具备实底不透明背景类", () => {
    useWhoIsFakerStore.setState({ rooms: mockRooms });
    renderPage();

    expect(screen.getByText("测试房间一")).toBeInTheDocument();
    expect(screen.getByText("8629")).toBeInTheDocument();
    expect(screen.getByText("2/4")).toBeInTheDocument();

    expect(screen.getByText("测试房间二")).toBeInTheDocument();
    expect(screen.getByText("9999")).toBeInTheDocument();
    expect(screen.getByText("6/6")).toBeInTheDocument();

    // 验证外层卡片容器应用了 rounded-md 与 bg-card 实底类，杜绝透光穿透
    const roomOneName = screen.getByText("测试房间一");
    const cardElement = roomOneName.closest('[role="button"]');
    expect(cardElement).toBeInTheDocument();
    const motionWrapper = cardElement?.parentElement;
    expect(motionWrapper).toHaveClass("bg-card");
    expect(motionWrapper).toHaveClass("rounded-md");
  });
});
