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
    useWhoIsFakerStore.setState({ rooms: [], connected: true });
    renderPage();

    expect(screen.getByText("暂无房间，点击上方按钮创建一个吧")).toBeInTheDocument();
  });

  it("初次加载尚未完成握手同步时渲染骨架屏防御 FOES", () => {
    useWhoIsFakerStore.setState({ rooms: [], connected: false });
    renderPage();

    expect(screen.getByRole("status", { name: "正在加载房间列表" })).toBeInTheDocument();
    expect(screen.queryByText("暂无房间，点击上方按钮创建一个吧")).not.toBeInTheDocument();
  });

  it("正常渲染房间列表卡片，且列表项外壳具备实底不透明背景类", () => {
    useWhoIsFakerStore.setState({ rooms: mockRooms });
    renderPage();

    expect(screen.getByText("测试房间一")).toBeInTheDocument();
    expect(screen.getByText("8629")).toBeInTheDocument();
    expect(screen.getByText("等待中")).toBeInTheDocument();
    expect(screen.getByText("可观战")).toBeInTheDocument();

    expect(screen.getByText("测试房间二")).toBeInTheDocument();
    expect(screen.getByText("9999")).toBeInTheDocument();
    expect(screen.getByText("游戏中")).toBeInTheDocument();
    expect(screen.getByText("禁观战")).toBeInTheDocument();

    const roomOne = screen.getByText("测试房间一").closest('[role="button"]');
    expect(roomOne).toHaveTextContent("4玩家");
    expect(roomOne).toHaveTextContent("1旁观");

    const roomTwo = screen.getByText("测试房间二").closest('[role="button"]');
    expect(roomTwo).toHaveTextContent("6玩家");
    expect(roomTwo).toHaveTextContent("0旁观");

    const digitElements = screen.getAllByText(/^[0-9]+$/);
    for (const digit of digitElements) {
      if (digit.textContent === "8629" || digit.textContent === "9999" || digit.textContent === "2") {
        continue;
      }
      expect(digit).toHaveClass("w-[2ch]");
      expect(digit).toHaveClass("text-right");
      expect(digit).toHaveClass("tabular-nums");
    }

    // 验证外层卡片容器应用了 rounded-md 与 bg-card 实底类，杜绝透光穿透
    const roomOneName = screen.getByText("测试房间一");
    const cardElement = roomOneName.closest('[role="button"]');
    expect(cardElement).toBeInTheDocument();
    const motionWrapper = cardElement?.parentElement;
    expect(motionWrapper).toHaveClass("bg-card");
    expect(motionWrapper).toHaveClass("rounded-md");
  });
});
