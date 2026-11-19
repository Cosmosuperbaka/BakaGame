import { useEffect, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { resetPageControl, setPageControl, type PageControlState } from "@/stores/UsePageControl";
import { McpPairingPanel } from "./McpPairingPanel";

/** 按故事把接管状态摆好，离开故事时复位，不串到下一个故事。 */
function WithControl({ state, children }: { state: PageControlState; children: ReactNode }) {
  useEffect(() => {
    setPageControl(state);
    return resetPageControl;
  }, [state]);
  return <div className="w-[26rem] max-w-full rounded-md border bg-card p-4">{children}</div>;
}

const OPEN: PageControlState = {
  status: "open",
  code: "K7P2-9QXM",
  expiresAt: Date.now() + 60 * 60 * 1000,
};
const CONTROLLED: PageControlState = { status: "controlled", agentName: "BakaAgent" };
const OFF: PageControlState = { status: "off" };

const meta = {
  title: "公共组件/McpPairingPanel",
  component: McpPairingPanel,
} satisfies Meta<typeof McpPairingPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Off: Story = {
  name: "关闭",
  render: () => (
    <WithControl state={OFF}>
      <McpPairingPanel />
    </WithControl>
  ),
};

/** 生成了配对码：码块是主色淡底，两枚 ghost 小按钮复制码或整段指令。 */
export const Paired: Story = {
  name: "已生成配对码",
  render: () => (
    <WithControl state={OPEN}>
      <McpPairingPanel />
    </WithControl>
  ),
};

export const Controlled: Story = {
  name: "被接管中",
  render: () => (
    <WithControl state={CONTROLLED}>
      <McpPairingPanel />
    </WithControl>
  ),
};

/** 当前页面不能交出去（如排位局）：开关禁用，说明换成原因。 */
export const Blocked: Story = {
  name: "不可交出",
  render: () => (
    <WithControl state={OFF}>
      <McpPairingPanel blockedReason="排位对局中不能交给 Agent，结束后再开。" />
    </WithControl>
  ),
};
