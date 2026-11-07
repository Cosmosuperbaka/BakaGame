import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { CLOUD_SYNC_STORAGE_KEY, getCloudSyncEnabled, setCloudSyncEnabled } from "@/lib/CloudSync";
import { setPageControl } from "@/stores/UsePageControl";
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
  setPageControl({ status: "off" });
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
    expect(within(dialog).getByRole("switch", { name: "交给 Agent 操作" })).toBeInTheDocument();
    expect(within(dialog).getByRole("radiogroup", { name: "主题" })).toBeInTheDocument();
    expect(within(dialog).getByRole("switch", { name: "提示音" })).toBeInTheDocument();
    expect(within(dialog).getByRole("switch", { name: "启用云同步" })).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "连接信息" }));
    expect(dialog).toHaveTextContent("/api/mcp");
    expect(dialog).toHaveTextContent("站点连接");
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

  it("开启接管后展示一次性配对码与交给 Agent 的指令", async () => {
    setPageControl({ status: "open", code: "ABCD2345", expiresAt: Date.now() + 60_000 });
    const { dialog } = await openSettings();

    expect(within(dialog).getByText("ABCD2345")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "复制码" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "复制指令" })).toBeInTheDocument();
    // 接管开关不是本地偏好：配对本就该一次一码，刷新即失效。
    expect(window.localStorage.getItem("bakagame:mcp-link")).toBeNull();
  });

  it("云同步开关持久化", async () => {
    const { user, dialog } = await openSettings();
    await user.click(within(dialog).getByRole("switch", { name: "启用云同步" }));

    expect(getCloudSyncEnabled()).toBe(false);
    expect(window.localStorage.getItem(CLOUD_SYNC_STORAGE_KEY)).toBe("0");
  });

  it("房间内与任何页面是同一块配对入口；房主开了 MCP 才能交给 Agent", async () => {
    useWhoIsFakerStore.setState({
      snapshot: { settings: { allowAgents: true } } as never,
    });
    const { dialog } = await openSettings("faker");
    expect(within(dialog).getByRole("switch", { name: "交给 Agent 操作" })).toBeEnabled();
    expect(dialog).not.toHaveTextContent("会话凭证");
  });

  it("房间没开 MCP 时说明原因，开关不可用", async () => {
    useWhoIsFakerStore.setState({
      snapshot: { settings: { allowAgents: false } } as never,
    });
    const { dialog } = await openSettings("faker");
    expect(within(dialog).getByRole("switch", { name: /交给 Agent 操作/ })).toBeDisabled();
    expect(dialog).toHaveTextContent("本房间未开启 MCP");
  });

  it("配对码区块对 Agent 不可见，配对成功后设置面板自动收起", async () => {
    setPageControl({ status: "open", code: "ABCD2345", expiresAt: Date.now() + 60_000 });
    const { dialog } = await openSettings();
    expect(within(dialog).getByText("ABCD2345").closest("[data-agent-sensitive]")).not.toBeNull();
    act(() => setPageControl({ status: "controlled", agentName: "BakaAgent" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
