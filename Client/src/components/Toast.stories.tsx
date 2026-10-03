import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ToastItem } from "./Toast";
import { SERVER_SHUTDOWN_MESSAGE } from "@/types";
import { ToastViewport } from "./Toast";

const meta = {
  title: "公共组件/Toast",
  component: ToastViewport,
  args: { toasts: [] },
  tags: ["overlay"],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ToastViewport>;

export default meta;
type Story = StoryObj<typeof meta>;

const ALL_TYPES: ToastItem[] = [
  { id: 1, text: "有玩家掉线，等待出题人处理", type: "info" },
  { id: 2, text: "房间链接已复制", type: "success" },
  { id: 3, text: "房间即将因超时关闭", type: "error" },
];

export const AllTypes: Story = {
  name: "提示、成功与错误",
  args: { toasts: ALL_TYPES },
};

// 提示浮在页面内容之上，身后可能是本人的主色气泡、正文或页面底。
// 用三种颜色的竖条垫底，截图里能直接看出文字对比度是否随身后内容变化。
export const OverContent: Story = {
  name: "盖在内容上",
  args: { toasts: ALL_TYPES },
  render: () => (
    <>
      <div
        aria-hidden="true"
        className="fixed inset-0"
        style={{
          backgroundImage:
            "repeating-linear-gradient(90deg, var(--primary) 0 48px, var(--foreground) 48px 96px, var(--background) 96px 144px)",
        }}
      />
      <ToastViewport toasts={ALL_TYPES} />
    </>
  ),
};

export const LongText: Story = {
  name: "长文本",
  args: { toasts: [{ id: 1, text: SERVER_SHUTDOWN_MESSAGE, type: "error" }] },
};

export const SonGuessr: Story = {
  name: "猜歌提示",
  args: { toasts: [{ id: "song-notice", text: "网易云登录状态已失效，请重新扫码登录", type: "error" }] },
};

export const CCB: Story = {
  name: "CCB 提示",
  args: { toasts: [{ id: "ccb-notice", text: "设置已保存", type: "success" }] },
};
