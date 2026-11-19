import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SONG_PEOPLE, songPlayer, songSnapshot } from "@/stories/fixtures/SonGuessr";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import { SongWaitingPhase } from "./SongWaitingPhase";

const { host, me } = SONG_PEOPLE;
const run = vi.fn(async () => {});

const readyPlayers = () => [
  songPlayer(host, { isReady: true, isHost: true }),
  songPlayer(me, { isReady: true }),
];

/** 房主视角：两平台是并列可选项，任一可用就能开局，与文案一起断言。 */
describe("猜歌等待页开局条件", () => {
  it.each([
    ["只有网易云", { musicAccountReady: true, qqMusicAccountReady: false }, true],
    ["只有 QQ 音乐", { musicAccountReady: false, qqMusicAccountReady: true }, true],
    ["两平台都有", { musicAccountReady: true, qqMusicAccountReady: true }, true],
    ["两平台都无", { musicAccountReady: false, qqMusicAccountReady: false }, false],
  ])("房主 · %s", (_label, accounts, canStart) => {
    render(
      <SongWaitingPhase
        snapshot={songSnapshot({ players: readyPlayers(), ...accounts })}
        me={readyPlayers()[0]}
        isHost
        run={run}
      />
    );
    const button = screen.getByRole<HTMLButtonElement>("button", {
      name: canStart ? "开始游戏" : "请先登录网易云或 QQ 音乐账号",
    });
    expect(button.disabled).toBe(!canStart);
  });

  it("单人视角：只有 QQ 音乐也能开始", () => {
    render(
      <SongWaitingPhase
        snapshot={songSnapshot({ solo: true, musicAccountReady: false, qqMusicAccountReady: true })}
        isHost
        run={run}
      />
    );
    expect(screen.getByRole("button", { name: "开始游戏" })).toBeEnabled();
  });

  it("单人视角：两平台都无时提示登录网易云或 QQ 音乐", () => {
    render(
      <SongWaitingPhase
        snapshot={songSnapshot({
          solo: true,
          musicAccountReady: false,
          qqMusicAccountReady: false,
        })}
        isHost
        run={run}
      />
    );
    expect(screen.getByRole("button", { name: "请先登录网易云或 QQ 音乐账号" })).toBeDisabled();
  });
});

describe("猜歌等待页的设置草稿", () => {
  const initialStoreState = useSonGuessrStore.getState();

  afterEach(() => {
    useSonGuessrStore.setState(initialStoreState, true);
  });

  it("房主移交后新房主的草稿是服务端当前房名", () => {
    useSonGuessrStore.setState({ sendCommand: vi.fn().mockResolvedValue({}) });
    const view = render(
      <SongWaitingPhase
        snapshot={songSnapshot({ name: "进房时的房名", players: readyPlayers() })}
        me={readyPlayers()[1]}
        isHost={false}
        run={run}
      />
    );
    // 原房主改了房名，随后把房主移交给我。
    view.rerender(
      <SongWaitingPhase
        snapshot={songSnapshot({
          name: "改过的房名",
          hostPlayerId: me.id,
          players: readyPlayers(),
        })}
        me={songPlayer(me, { isReady: true, isHost: true })}
        isHost
        run={run}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "房间设置" }));
    expect(screen.getByRole("textbox", { name: "房间名称" })).toHaveValue("改过的房名");
  });
});

describe("猜歌等待页的 MCP 接入开关", () => {
  const initialStoreState = useSonGuessrStore.getState();
  const hostSnapshot = () => songSnapshot({ players: readyPlayers() });

  afterEach(() => {
    useSonGuessrStore.setState(initialStoreState, true);
  });

  it("房主开 MCP 接入：单独一条房间设置命令，只带这一项", async () => {
    const sendCommand = vi.fn().mockResolvedValue({});
    useSonGuessrStore.setState({ sendCommand });
    render(<SongWaitingPhase snapshot={hostSnapshot()} me={readyPlayers()[0]} isHost run={run} />);
    fireEvent.click(screen.getByRole("button", { name: "MCP 设置" }));
    fireEvent.click(screen.getByRole("switch", { name: "允许 MCP 接入" }));

    await waitFor(() =>
      expect(sendCommand).toHaveBeenCalledExactlyOnceWith("song.room.updateSettings", {
        allowAgents: true,
      })
    );
  });

  it("单人房同样能开 MCP 接入", async () => {
    const sendCommand = vi.fn().mockResolvedValue({});
    useSonGuessrStore.setState({ sendCommand });
    render(<SongWaitingPhase snapshot={songSnapshot({ solo: true })} isHost run={run} />);
    fireEvent.click(screen.getByRole("button", { name: "MCP 设置" }));
    fireEvent.click(screen.getByRole("switch", { name: "允许 MCP 接入" }));

    await waitFor(() =>
      expect(sendCommand).toHaveBeenCalledExactlyOnceWith("song.room.updateSettings", {
        allowAgents: true,
      })
    );
  });

  it("MCP 接入保存失败：原样显示服务端文案，开关解锁后可重试", async () => {
    const sendCommand = vi
      .fn()
      .mockRejectedValueOnce({ code: "NOT_HOST", message: "只有房主可以这样做" })
      .mockResolvedValue({});
    useSonGuessrStore.setState({ sendCommand });
    render(<SongWaitingPhase snapshot={hostSnapshot()} me={readyPlayers()[0]} isHost run={run} />);
    fireEvent.click(screen.getByRole("button", { name: "MCP 设置" }));
    const toggle = screen.getByRole("switch", { name: "允许 MCP 接入" });
    fireEvent.click(toggle);

    expect(await screen.findByRole("alert")).toHaveTextContent("只有房主可以这样做");
    expect(toggle).toBeEnabled();
    fireEvent.click(toggle);
    await waitFor(() => expect(sendCommand).toHaveBeenCalledTimes(2));
  });

  it("非房主只看到 MCP 开关的说明，没有可点的开关", () => {
    render(
      <SongWaitingPhase snapshot={hostSnapshot()} me={readyPlayers()[1]} isHost={false} run={run} />
    );
    fireEvent.click(screen.getByRole("button", { name: "MCP 设置" }));
    expect(screen.getByText("房主尚未开启 MCP 接入。")).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "允许 MCP 接入" })).not.toBeInTheDocument();
  });
});
