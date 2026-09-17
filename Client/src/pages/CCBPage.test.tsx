import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCCBStore } from "@/stores/UseCCBStore";
import type { CCBRoomSummary } from "@bakagame/shared";
import CCBPage from "./CCBPage";

const initialStoreState = useCCBStore.getState();

const mockRooms: CCBRoomSummary[] = [
  {
    roomId: "8629",
    name: "二刺猿测试房一",
    phase: "guessing",
    playerCount: 3,
    spectatorCount: 2,
    onlineCount: 5,
    visibility: "public",
    hasPassword: true,
    allowSpectators: true,
  },
  {
    roomId: "6666",
    name: "二刺猿测试房二",
    phase: "waiting",
    playerCount: 4,
    spectatorCount: 0,
    onlineCount: 4,
    visibility: "public",
    hasPassword: false,
    allowSpectators: false,
  },
];

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/ccb"]}>
      <Routes>
        <Route path="/ccb" element={<CCBPage />} />
        <Route path="/ccb/room/:id" element={<div data-testid="room-target" />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("CCBPage 房间列表渲染与卡片隔离", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCCBStore.setState(initialStoreState, true);
  });

  afterEach(() => {
    useCCBStore.setState(initialStoreState, true);
  });

  it("当房间列表为空且已连接时渲染空状态提示", () => {
    useCCBStore.setState({ rooms: [], connected: true });
    renderPage();

    expect(screen.getByText("暂无房间，点击上方按钮创建一个吧")).toBeInTheDocument();
  });

  it("初次加载尚未完成握手同步时渲染骨架屏防御 FOES", () => {
    useCCBStore.setState({ rooms: [], connected: false });
    renderPage();

    expect(screen.getByRole("status", { name: "正在加载房间列表" })).toBeInTheDocument();
    expect(screen.queryByText("暂无房间，点击上方按钮创建一个吧")).not.toBeInTheDocument();
  });

  it("正常渲染房间列表卡片，且列表项外壳具备实底不透明背景类", () => {
    useCCBStore.setState({ rooms: mockRooms });
    renderPage();

    expect(screen.getByText("二刺猿测试房一")).toBeInTheDocument();
    expect(screen.getByText("8629")).toBeInTheDocument();
    expect(screen.getByText("游戏中")).toBeInTheDocument();
    expect(screen.getByText("可观战")).toBeInTheDocument();

    expect(screen.getByText("二刺猿测试房二")).toBeInTheDocument();
    expect(screen.getByText("6666")).toBeInTheDocument();
    expect(screen.getByText("等待中")).toBeInTheDocument();
    expect(screen.getByText("禁观战")).toBeInTheDocument();

    const roomOne = screen.getByText("二刺猿测试房一").closest('[role="button"]');
    expect(roomOne).toHaveTextContent("3玩家");
    expect(roomOne).toHaveTextContent("2旁观");

    const roomTwo = screen.getByText("二刺猿测试房二").closest('[role="button"]');
    expect(roomTwo).toHaveTextContent("4玩家");
    expect(roomTwo).toHaveTextContent("0旁观");

    const digitElements = screen.getAllByText(/^[0-9]+$/);
    for (const digit of digitElements) {
      if (digit.textContent === "8629" || digit.textContent === "6666" || digit.textContent === "2") {
        continue;
      }
      expect(digit).toHaveClass("w-[2ch]");
      expect(digit).toHaveClass("text-right");
      expect(digit).toHaveClass("tabular-nums");
    }

    const roomOneName = screen.getByText("二刺猿测试房一");
    const cardElement = roomOneName.closest('[role="button"]');
    expect(cardElement).toBeInTheDocument();
    const motionWrapper = cardElement?.parentElement;
    expect(motionWrapper).toHaveClass("bg-card");
    expect(motionWrapper).toHaveClass("rounded-md");
  });
});
