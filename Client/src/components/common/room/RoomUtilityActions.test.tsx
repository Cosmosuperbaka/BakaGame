import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { useAccountStore } from "@/stores/UseAccountStore";
import { RoomUtilityActions } from "./RoomUtilityActions";

const openSettings = async (agentsBlocked: boolean) => {
  useAccountStore.setState({ status: "guest", profile: null, unreadFeedback: 0 });
  const user = userEvent.setup();
  render(<RoomUtilityActions agentsBlocked={agentsBlocked} />);
  await user.click(screen.getByRole("button", { name: "设置" }));
  return screen.findByRole("dialog");
};

describe("RoomUtilityActions", () => {
  it("房间顶栏的反馈紧挨设置，顺序固定", () => {
    useAccountStore.setState({ status: "guest", profile: null, unreadFeedback: 0 });
    render(<RoomUtilityActions agentsBlocked={false} />);

    const feedback = screen.getByRole("button", { name: "反馈" });
    const settings = screen.getByRole("button", { name: "设置" });
    const row = settings.parentElement as HTMLElement;
    expect(feedback.parentElement).toBe(row);
    expect(Array.from(row.children).indexOf(feedback)).toBeLessThan(
      Array.from(row.children).indexOf(settings)
    );
  });

  it("房主没开 MCP 时，顶栏传进的限制让设置面板里的接管开关禁用并说明原因", async () => {
    const dialog = await openSettings(true);
    expect(within(dialog).getByRole("switch", { name: /交给 Agent 操作/ })).toBeDisabled();
    expect(dialog).toHaveTextContent("本房间未开启 MCP");
  });

  it("房主开了 MCP 时同一个开关可用，也不显示限制说明", async () => {
    const dialog = await openSettings(false);
    expect(within(dialog).getByRole("switch", { name: /交给 Agent 操作/ })).toBeEnabled();
    expect(dialog).not.toHaveTextContent("本房间未开启 MCP");
  });
});
