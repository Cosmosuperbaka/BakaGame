import type { Meta, StoryObj } from "@storybook/react-vite";
import { CEEBangumiRichText } from "./CEEBangumiRichText";

const meta = {
  title: "公共组件/BangumiRichText",
  component: CEEBangumiRichText,
  args: {
    className: "text-sm leading-relaxed",
    text: [
      "[size=20]角色简介[/size]",
      "下北泽高中二年级学生，[b]结束乐队[/b]的鼓手兼队长，[i]很会照顾人[/i]，[u]调和气氛[/u]。",
      "[s]曾经想当偶像[/s] 出处见 [url=https://example.com/wiki]维基[/url]，配置写作 [code]STARRY[/code]。",
      "[mask]剧透：组乐队是为了姐姐。[/mask]",
      "[quote]「我想看到大家一起站在舞台上的样子。」[/quote]",
      "[center]—— 居中落款 ——[/center]",
      "[size=9]注：资料来自 Bangumi。[/size] 未识别的 [jack] 原样保留。",
    ].join("\n"),
  },
  decorators: [
    (Story) => (
      <div className="w-96 rounded-md bg-muted p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CEEBangumiRichText>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Bangumi 维基实际用到的标记：放大、加粗、斜体、下划线、删除线、链接、代码、剧透、引用、居中与缩小。 */
export const AllMarkup: Story = { name: "全部标记" };
