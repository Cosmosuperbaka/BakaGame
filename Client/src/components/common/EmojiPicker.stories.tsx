import { useState, type ComponentProps } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { loadStickerPacks } from "@/lib/Stickers";
import { EmojiPicker } from "./EmojiPicker";

const meta = {
  title: "公共组件/EmojiPicker",
  component: EmojiPicker,
  args: {
    open: true,
    activeTab: 0,
    onTabChange: fn(),
    onSelect: fn(),
    onClose: fn(),
  },
  // 清单在打开后异步载入：等标签栏出现再截图，避免拍到载入中的占位。
  play: async ({ canvas }) => {
    await canvas.findByRole("tablist", { name: "表情包分类" }, { timeout: 10_000 });
  },
} satisfies Meta<typeof EmojiPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * activeTab 只作初始值，之后由内部状态接管，点击标签可以切换。
 * 选择器以 bottom-full 向上展开，这里留出上方空间，让整块浮层落在截图范围内。
 */
function PickerDemo({ activeTab: initialTab, onTabChange, ...props }: ComponentProps<typeof EmojiPicker>) {
  const [activeTab, setActiveTab] = useState(initialTab);
  return (
    <div className="w-80 pt-[17rem]">
      <div className="relative">
        <EmojiPicker
          {...props}
          activeTab={activeTab}
          onTabChange={(index) => {
            setActiveTab(index);
            onTabChange(index);
          }}
        />
      </div>
    </div>
  );
}

export const Open: Story = {
  name: "展开",
  render: (args) => <PickerDemo {...args} />,
};

export const AnimatedPack: Story = {
  name: "动图表情包",
  loaders: [
    async () => {
      const packs = await loadStickerPacks();
      return { animatedTab: Math.max(0, packs.findIndex((pack) => pack.animated)) };
    },
  ],
  render: (args, { loaded }) => (
    <PickerDemo {...args} activeTab={(loaded as { animatedTab: number }).animatedTab} />
  ),
};
