import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetPageControl, setPageControl } from "@/stores/UsePageControl";
import { McpSettingsSection } from "./McpSettingsSection";

/** 展开折叠组：收起时组内字段根本不挂载。 */
const openSection = () => fireEvent.click(screen.getByRole("button", { name: "MCP 设置" }));

describe("MCP 设置组", () => {
  afterEach(() => {
    resetPageControl();
  });

  it("房主点开关交给调用方保存，在途时禁用，落定后解锁", async () => {
    let settle: () => void = () => {};
    const onChangeAllowAgents = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        })
    );
    render(
      <McpSettingsSection allowAgents={false} isHost onChangeAllowAgents={onChangeAllowAgents} />
    );
    openSection();
    const toggle = screen.getByRole("switch", { name: "允许 MCP 接入" });
    fireEvent.click(toggle);

    expect(onChangeAllowAgents).toHaveBeenCalledExactlyOnceWith(true);
    expect(toggle).toBeDisabled();
    // 在途时再点不会重复保存。
    fireEvent.click(toggle);
    expect(onChangeAllowAgents).toHaveBeenCalledTimes(1);

    await act(async () => {
      settle();
    });
    expect(toggle).toBeEnabled();
  });

  it("保存失败原样显示服务端文案：协议错误是普通对象，不走 ORPCError 那条兜底", async () => {
    const onChangeAllowAgents = vi
      .fn()
      .mockRejectedValueOnce({ code: "NOT_HOST", message: "只有房主可以这样做" })
      .mockResolvedValue(undefined);
    render(
      <McpSettingsSection allowAgents={false} isHost onChangeAllowAgents={onChangeAllowAgents} />
    );
    openSection();
    const toggle = screen.getByRole("switch", { name: "允许 MCP 接入" });
    fireEvent.click(toggle);

    expect(await screen.findByRole("alert")).toHaveTextContent("只有房主可以这样做");
    expect(toggle).toBeEnabled();
    fireEvent.click(toggle);
    await waitFor(() => expect(onChangeAllowAgents).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("失败没有文案时落兜底提示", async () => {
    const onChangeAllowAgents = vi.fn().mockRejectedValue({ code: "NOT_HOST" });
    render(
      <McpSettingsSection allowAgents={false} isHost onChangeAllowAgents={onChangeAllowAgents} />
    );
    openSection();
    fireEvent.click(screen.getByRole("switch", { name: "允许 MCP 接入" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("保存 MCP 设置失败");
  });

  it("非房主只有一行说明，没有房间开关；配对入口照常给出", () => {
    const onChangeAllowAgents = vi.fn();
    render(
      <McpSettingsSection
        allowAgents={false}
        isHost={false}
        onChangeAllowAgents={onChangeAllowAgents}
      />
    );
    openSection();
    expect(screen.getByText("房主尚未开启 MCP 接入。")).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "允许 MCP 接入" })).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "交给 Agent 操作" })).toBeDisabled();
    expect(onChangeAllowAgents).not.toHaveBeenCalled();
  });

  it("摘要同时报房间开关与本机接管状态", () => {
    setPageControl({ status: "controlled", agentName: "小助手" });
    render(<McpSettingsSection allowAgents isHost onChangeAllowAgents={vi.fn()} />);
    expect(screen.getByRole("button", { name: "MCP 设置" })).toHaveAccessibleDescription(
      "MCP 可用 · Agent 操作中"
    );
  });
});
