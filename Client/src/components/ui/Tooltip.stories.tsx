import type { Meta, StoryObj } from "@storybook/react-vite";
import { RefreshCw } from "lucide-react";
import { Button } from "./Button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./Tooltip";

const meta = {
  title: "基础控件/Tooltip",
  component: Tooltip,
  tags: ["overlay"],
} satisfies Meta<typeof Tooltip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {
  name: "展开",
  render: () => (
    <div className="flex h-32 w-64 items-end justify-center pb-4">
      <Tooltip open>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="刷新房间列表">
            <RefreshCw />
          </Button>
        </TooltipTrigger>
        <TooltipContent>刷新房间列表</TooltipContent>
      </Tooltip>
    </div>
  ),
};
