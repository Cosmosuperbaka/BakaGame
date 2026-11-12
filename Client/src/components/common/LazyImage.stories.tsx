import type { Meta, StoryObj } from "@storybook/react-vite";
import { ImageOff, UserRound } from "lucide-react";
import { LazyImage } from "./LazyImage";

const never = () => new Promise<string | undefined>(() => {});

const meta = {
  title: "公共组件/LazyImage",
  component: LazyImage,
  args: {
    cacheKey: "story",
    request: never,
    fallback: <UserRound className="size-4" aria-hidden="true" />,
  },
} satisfies Meta<typeof LazyImage>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * 三种状态并排，尺寸取搜索候选（size-9）与答案卡封面（h-28 w-20）两档：
 * 已有地址直接显示；地址还在路上时是占位图标；图坏了退回同一个占位，不留破图。
 */
export const States: Story = {
  name: "已有图、加载中与失败",
  render: () => (
    <div className="flex items-end gap-6 rounded-md border bg-panel p-4">
      {[
        { label: "已有地址", key: "ok", initial: "/assets/Faker.png" },
        { label: "加载中", key: "pending", initial: undefined },
        {
          label: "加载失败",
          key: "broken", // 坏数据的 data: 地址：触发 onError 而不发网络请求，截图不带 404 噪声
          initial: "data:image/png;base64,AAAA",
        },
      ].map((item) => (
        <figure key={item.key} className="flex flex-col items-center gap-2">
          <div className="flex items-end gap-3">
            <LazyImage
              cacheKey={`story-${item.key}-s`}
              initial={item.initial}
              request={never}
              className="size-9"
              fallback={<UserRound className="size-4" aria-hidden="true" />}
            />
            <LazyImage
              cacheKey={`story-${item.key}-l`}
              initial={item.initial}
              request={never}
              className="h-28 w-20"
              fallback={<ImageOff className="size-5" aria-hidden="true" />}
            />
          </div>
          <figcaption className="text-xs text-muted-foreground">{item.label}</figcaption>
        </figure>
      ))}
    </div>
  ),
};
