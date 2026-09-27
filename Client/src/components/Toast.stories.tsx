import type { Meta, StoryObj } from "@storybook/react-vite";
import { presetCCB, presetSonGuessr, presetWhoIsFaker } from "@/stories/StorePresets";
import { SERVER_SHUTDOWN_MESSAGE } from "@/types";
import { CCBToastContainer, SonGuessrToastContainer, ToastContainer } from "./Toast";

const meta = {
  title: "公共组件/Toast",
  component: ToastContainer,
  tags: ["overlay"],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ToastContainer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AllTypes: Story = {
  name: "提示、成功与错误",
  beforeEach: () => {
    presetWhoIsFaker({
      toasts: [
        { id: 1, text: "有玩家掉线，等待出题人处理", type: "info" },
        { id: 2, text: "房间链接已复制", type: "success" },
        { id: 3, text: "房间即将因超时关闭", type: "error" },
      ],
    });
  },
};

export const LongText: Story = {
  name: "长文本",
  beforeEach: () => {
    presetWhoIsFaker({ toasts: [{ id: 1, text: SERVER_SHUTDOWN_MESSAGE, type: "error" }] });
  },
};

export const SonGuessr: Story = {
  name: "猜歌提示",
  beforeEach: () => {
    presetSonGuessr({ notice: { text: "网易云登录状态已失效，请重新扫码登录", type: "error" } });
  },
  render: () => <SonGuessrToastContainer />,
};

export const CCB: Story = {
  name: "CCB 提示",
  beforeEach: () => {
    presetCCB({ notice: { text: "设置已保存", type: "success" } });
  },
  render: () => <CCBToastContainer />,
};
