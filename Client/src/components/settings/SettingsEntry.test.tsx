import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { CLOUD_SYNC_STORAGE_KEY, getCloudSyncEnabled, setCloudSyncEnabled } from "@/lib/CloudSync";
import {
  getMcpNewRoomAllowed,
  MCP_NEW_ROOM_STORAGE_KEY,
  setMcpNewRoomAllowed,
} from "@/lib/McpConfig";
import {
  getSoundEnabled,
  getSoundVolume,
  setSoundEnabled,
  setSoundVolume,
  SOUND_STORAGE_KEY,
  SOUND_VOLUME_STORAGE_KEY,
} from "@/lib/SoundEffects";
import { setThemePreference, THEME_STORAGE_KEY } from "@/lib/Theme";
import type { McpGameId } from "@/lib/McpConfig";
import { useCEEStore } from "@/stores/UseCEEStore";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { SettingsEntry } from "./SettingsEntry";

const resetPreferences = () => {
  document.documentElement.classList.remove("dark");
  setThemePreference("system");
  setSoundEnabled(true);
  setSoundVolume(1);
  setMcpNewRoomAllowed(false);
  setCloudSyncEnabled(true);
  useWhoIsFakerStore.setState({ snapshot: null, privateState: null });
  useSonGuessrStore.setState({ snapshot: null, privateState: null });
  useCEEStore.setState({ snapshot: null, privateState: null });
};

beforeEach(resetPreferences);

const openSettings = async (game?: McpGameId) => {
  const user = userEvent.setup();
  render(<SettingsEntry game={game} />);
  await user.click(screen.getByRole("button", { name: "设置" }));
  return { user, dialog: await screen.findByRole("dialog") };
};

describe("SettingsEntry", () => {
  it("齿轮入口打开统一设置面板，四组偏好都在同一处", async () => {
    const { user, dialog } = await openSettings();
    expect(dialog).toHaveTextContent("设置");
    expect(
      within(dialog).getByRole("switch", { name: "允许 MCP 接入本会话" })
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("radiogroup", { name: "主题" })).toBeInTheDocument();
    expect(within(dialog).getByRole("switch", { name: "提示音" })).toBeInTheDocument();
    expect(within(dialog).getByRole("switch", { name: "启用云同步" })).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "连接详情" }));
    expect(dialog).toHaveTextContent("/api/mcp");
  });

  it("主题三档立即写入本地偏好", async () => {
    const { user, dialog } = await openSettings();
    const group = within(dialog).getByRole("radiogroup", { name: "主题" });
    await user.click(within(group).getByRole("radio", { name: "深色" }));

    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(within(group).getByRole("radio", { name: "深色" })).toBeChecked();
  });

  it("提示音开关与音量分别持久化", async () => {
    const { user, dialog } = await openSettings();
    const soundSwitch = within(dialog).getByRole("switch", { name: "提示音" });
    await user.click(soundSwitch);

    expect(getSoundEnabled()).toBe(false);
    expect(window.localStorage.getItem(SOUND_STORAGE_KEY)).toBe("0");
    expect(within(dialog).getByRole("slider", { name: "音量" })).toHaveAttribute("data-disabled");

    await user.click(soundSwitch);
    const slider = within(dialog).getByRole("slider", { name: "音量" });
    slider.focus();
    await user.keyboard("{ArrowLeft}");

    expect(getSoundVolume()).toBeCloseTo(0.95, 5);
    expect(window.localStorage.getItem(SOUND_VOLUME_STORAGE_KEY)).toBe("0.95");
  });

  it("MCP 本会话允许与云同步开关都持久化", async () => {
    const { user, dialog } = await openSettings();
    await user.click(within(dialog).getByRole("switch", { name: "允许 MCP 接入本会话" }));
    await user.click(within(dialog).getByRole("switch", { name: "启用云同步" }));

    expect(getMcpNewRoomAllowed()).toBe(true);
    expect(window.localStorage.getItem(MCP_NEW_ROOM_STORAGE_KEY)).toBe("1");
    expect(getCloudSyncEnabled()).toBe(false);
    expect(window.localStorage.getItem(CLOUD_SYNC_STORAGE_KEY)).toBe("0");
  });

  it("房间内只显示 MCP 连接信息，不重复建房默认开关", async () => {
    useWhoIsFakerStore.setState({
      snapshot: { settings: { allowAgents: true } } as never,
      privateState: { mcpControlled: false } as never,
    });
    const { dialog } = await openSettings("faker");

    expect(within(dialog).getByText("本房间已允许 MCP 接入")).toBeInTheDocument();
    expect(within(dialog).getByText(/尚未有 Agent 接管座位/)).toBeInTheDocument();
    expect(dialog).toHaveTextContent("/api/mcp");
    expect(
      within(dialog).queryByRole("switch", { name: "允许 MCP 接入本会话" })
    ).not.toBeInTheDocument();
  });

  it("Agent 接管座位后，房间内显示锁定状态", async () => {
    useSonGuessrStore.setState({
      snapshot: { settings: { allowAgents: true } } as never,
      privateState: { mcpControlled: true } as never,
    });
    const { dialog } = await openSettings("song");

    expect(within(dialog).getByText("Agent 已接入本座位")).toBeInTheDocument();
    expect(within(dialog).getByText(/你的手动操作已锁定/)).toBeInTheDocument();
  });

  it("房间未开启 MCP 且没有 Agent 接入时，MCP 分区整组不显示", async () => {
    useCEEStore.setState({
      snapshot: { settings: { allowAgents: false } } as never,
      privateState: { mcpControlled: false } as never,
    });
    const { dialog } = await openSettings("cee");

    expect(within(dialog).queryByText("MCP 连接")).not.toBeInTheDocument();
    expect(
      within(dialog).queryByRole("switch", { name: "允许 MCP 接入本会话" })
    ).not.toBeInTheDocument();
  });
});
