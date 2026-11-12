import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/Button";
import {
  clearAgentFocus,
  clearPageNotice,
  resetPageControl,
  setAgentFocus,
  setPageControl,
  showPageNotice,
} from "@/stores/UsePageControl";
import { AgentTakeoverLayer } from "./AgentTakeoverLayer";

const useReset = () =>
  useEffect(
    () => () => {
      resetPageControl();
      clearAgentFocus();
      clearPageNotice();
    },
    []
  );

/** 接管中：焦点框框住「开始游戏」，状态条贴着操作区，底部是收回入口。 */
function Operating({ reconnecting = false }: { reconnecting?: boolean }) {
  const target = useRef<HTMLButtonElement | null>(null);
  useReset();
  useEffect(() => {
    setPageControl({ status: "controlled", agentName: "BakaAgent", reconnecting });
    if (target.current)
      setAgentFocus({ action: "click", element: target.current, label: "开始游戏" });
  }, [reconnecting]);
  return (
    <div className="flex h-96 items-center justify-center">
      <Button ref={target}>开始游戏</Button>
      <AgentTakeoverLayer />
    </div>
  );
}

function Ended() {
  useReset();
  useEffect(() => showPageNotice("BakaAgent 已断开，页面已解锁"), []);
  return <AgentTakeoverLayer />;
}

const meta = {
  title: "公共组件/标签页接管",
  component: AgentTakeoverLayer,
  // 状态条与结束提示经 Portal 固定在视口底边：按整页截取，否则只拍到故事根元素（结束提示时根元素为空，截图超时）。
  tags: ["overlay"],
} satisfies Meta<typeof AgentTakeoverLayer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Controlled: Story = { name: "接管中", render: () => <Operating /> };

export const Reconnecting: Story = {
  name: "连接中断",
  render: () => <Operating reconnecting />,
};

export const Notice: Story = { name: "接管结束", render: () => <Ended /> };
