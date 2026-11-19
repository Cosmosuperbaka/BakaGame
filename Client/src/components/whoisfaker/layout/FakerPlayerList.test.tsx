import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicPlayerView } from "@bakagame/shared";
import { PLAYER_COLUMN_WIDTH } from "@/components/common/PlayerListLayout";
import { WIF_PEOPLE, waitingPlayers } from "@/stories/fixtures/WhoIsFaker";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { FakerPlayerList } from "./FakerPlayerList";
import { buildKnownRoleMap, resolveStatus } from "./FakerPlayerPresentation";
import {
  COMPACT_PLAYER_COLUMN_WIDTH,
  SPEECH_COLUMN_MIN_WIDTH,
  speechGridTemplate,
} from "./FakerPlayerListLayout";

const createPlayer = (overrides: Partial<PublicPlayerView> = {}): PublicPlayerView => ({
  id: "player-1",
  name: "玩家",
  score: 0,
  membership: "active",
  online: true,
  isReady: false,
  isBot: false,
  isHost: false,
  roundStatus: "alive",
  ...overrides,
});

describe("player list presentation", () => {
  it("keeps the player column fixed when history has no description columns", () => {
    expect(speechGridTemplate(0)).toBe(PLAYER_COLUMN_WIDTH);
    expect(speechGridTemplate(1)).toBe(
      `${PLAYER_COLUMN_WIDTH} repeat(1, minmax(${SPEECH_COLUMN_MIN_WIDTH}, max-content))`
    );
    // 移动端面板换成窄玩家列，发言列下限不变
    expect(speechGridTemplate(2, COMPACT_PLAYER_COLUMN_WIDTH)).toMatch(
      new RegExp(`^${COMPACT_PLAYER_COLUMN_WIDTH} `)
    );
  });

  it("uses the server-revealed role for eliminated players", () => {
    const deadPlayer = createPlayer({
      roundStatus: "dead",
      revealedRole: "undercover",
    });

    expect(buildKnownRoleMap([deadPlayer]).get(deadPlayer.id)).toBe("undercover");
  });

  it("leaves the leading badge slot empty for eliminated players", () => {
    // 出局改用名字之后的骷髅图标表达，行首不再占一枚徽章。
    const deadPlayer = createPlayer({ roundStatus: "dead", revealedRole: "civilian" });

    expect(resolveStatus(deadPlayer, false, false)).toBeNull();
  });

  it("keeps the questioner badge even after elimination checks", () => {
    const questioner = createPlayer({ roundStatus: "questioner" });

    expect(resolveStatus(questioner, false, false)).toEqual({ label: "主持", tone: "questioner" });
  });

  it("never renders readiness for spectators", () => {
    const spectator = createPlayer({
      membership: "spectator",
      roundStatus: "spectator",
      isReady: true,
    });

    expect(resolveStatus(spectator, true, false)).toEqual({
      label: "旁观",
      tone: "default",
    });
    expect(resolveStatus(spectator, true, true)).toBeNull();
  });
});

const originalSendCommand = useWhoIsFakerStore.getState().sendCommand;
const originalShowToast = useWhoIsFakerStore.getState().showToast;

const renderHost = () =>
  render(
    <FakerPlayerList
      players={waitingPlayers()}
      hostPlayerId={WIF_PEOPLE.host.id}
      myPlayerId={WIF_PEOPLE.host.id}
      isHost
      phase="waiting"
      allowSpectators
      roleConfig={{ undercoverCount: 2, hasAngel: true, hasBlank: true }}
      playerMarks={{}}
      onMarkChange={vi.fn()}
    />
  );

describe("FakerPlayerList 房主操作指令", () => {
  afterEach(() => {
    useWhoIsFakerStore.setState({
      sendCommand: originalSendCommand,
      showToast: originalShowToast,
    });
  });

  it("踢出玩家发出 room.kick 并带目标玩家编号", async () => {
    const user = userEvent.setup();
    const sendCommand = vi.fn().mockResolvedValue({});
    useWhoIsFakerStore.setState({ sendCommand: sendCommand as never });
    renderHost();

    await user.click(screen.getByRole("button", { name: `${WIF_PEOPLE.me.name} 操作` }));
    await user.click(await screen.findByRole("button", { name: "踢出玩家" }));
    expect(sendCommand).toHaveBeenCalledWith("room.kick", { playerId: WIF_PEOPLE.me.id });
  });

  it("转移房主发出 room.transferHost 并带目标玩家编号", async () => {
    const user = userEvent.setup();
    const sendCommand = vi.fn().mockResolvedValue({});
    useWhoIsFakerStore.setState({ sendCommand: sendCommand as never });
    renderHost();

    await user.click(screen.getByRole("button", { name: `${WIF_PEOPLE.me.name} 操作` }));
    await user.click(await screen.findByRole("button", { name: "转移房主" }));
    expect(sendCommand).toHaveBeenCalledWith("room.transferHost", { playerId: WIF_PEOPLE.me.id });
  });

  it("加入旁观发出 player.setSpectator", async () => {
    const user = userEvent.setup();
    const sendCommand = vi.fn().mockResolvedValue({});
    useWhoIsFakerStore.setState({ sendCommand: sendCommand as never });
    renderHost();

    await user.click(screen.getByRole("button", { name: "加入旁观" }));
    expect(sendCommand).toHaveBeenCalledWith("player.setSpectator", { spectator: true });
  });

  it("命令失败时提示原因", async () => {
    const showToast = vi.fn();
    const sendCommand = vi
      .fn()
      .mockRejectedValueOnce({ code: "NOT_HOST", message: "只有房主可以操作" });
    useWhoIsFakerStore.setState({ sendCommand: sendCommand as never, showToast });
    renderHost();

    await act(async () => screen.getByRole("button", { name: "加入旁观" }).click());
    expect(showToast).toHaveBeenCalledWith("只有房主可以操作", "error");
  });

  it("命令在途时同一帧连点旁观切换只发一条", async () => {
    let finish!: () => void;
    const sendCommand = vi.fn(
      () =>
        new Promise<object>((resolve) => {
          finish = () => resolve({});
        })
    );
    useWhoIsFakerStore.setState({ sendCommand: sendCommand as never });
    renderHost();

    const toggle = screen.getByRole("button", { name: "加入旁观" });
    // 同一批事件里连点：重渲染之前按钮还没来得及禁用，只有锁挡得住第二下。
    act(() => {
      toggle.click();
      toggle.click();
    });
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(sendCommand).toHaveBeenCalledWith("player.setSpectator", { spectator: true });
    await act(async () => finish());
  });

  it("转移房主在途时，另一个目标的踢出与旁观切换都置灰，返回后恢复可用", async () => {
    const user = userEvent.setup();
    let finish!: () => void;
    const sendCommand = vi.fn(
      () =>
        new Promise<object>((resolve) => {
          finish = () => resolve({});
        })
    );
    useWhoIsFakerStore.setState({ sendCommand: sendCommand as never });
    renderHost();

    await user.click(screen.getByRole("button", { name: `${WIF_PEOPLE.me.name} 操作` }));
    await user.click(await screen.findByRole("button", { name: "转移房主" }));
    expect(sendCommand).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: `${WIF_PEOPLE.peach.name} 操作` }));
    const kick = await screen.findByRole("button", { name: "踢出玩家" });
    expect(kick).toBeDisabled();
    expect(screen.getByRole("button", { name: "加入旁观" })).toBeDisabled();
    expect(sendCommand).toHaveBeenCalledTimes(1);

    await act(async () => finish());
    expect(screen.getByRole("button", { name: "加入旁观" })).toBeEnabled();
  });

  it("命令失败后释放锁，下一次照常发出", async () => {
    const showToast = vi.fn();
    const sendCommand = vi
      .fn()
      .mockRejectedValueOnce({ code: "NOT_HOST", message: "只有房主可以操作" })
      .mockResolvedValue({});
    useWhoIsFakerStore.setState({ sendCommand: sendCommand as never, showToast });
    renderHost();

    await act(async () => screen.getByRole("button", { name: "加入旁观" }).click());
    expect(showToast).toHaveBeenCalledWith("只有房主可以操作", "error");

    await act(async () => screen.getByRole("button", { name: "加入旁观" }).click());
    expect(sendCommand).toHaveBeenCalledTimes(2);
  });
});
