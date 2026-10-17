import type { Meta, StoryObj } from "@storybook/react-vite";
import type { CreditBrandId } from "@/lib/Credits";
import { CreditBrandMark, DependencyGlyph } from "./CreditsIcons";

/** 按页面上的分组展示全部品牌键，便于逐枚核对字形、颜色与尺寸。 */
const BRAND_GROUPS: readonly { title: string; brands: readonly CreditBrandId[] }[] = [
  {
    title: "AI 厂商",
    brands: ["deepseek", "zhipu", "openai", "google", "tencent", "anthropic", "alibaba"],
  },
  {
    title: "AI 模型家族",
    brands: ["glm", "gpt", "gemini", "claude", "hunyuan", "qwen"],
  },
  {
    title: "技术栈",
    brands: [
      "react",
      "typescript",
      "tailwindcss",
      "radixui",
      "framer",
      "zustand",
      "bun",
      "elysia",
      "drizzle",
      "mysql",
      "vite",
      "pnpm",
      "storybook",
      "vitest",
      "playwright",
      "sentry",
      "eslint",
      "githubactions",
    ],
  },
  {
    title: "依赖清单品牌",
    brands: [
      "applemusic",
      "betterauth",
      "fontawesome",
      "simpleicons",
      "reactrouter",
      "testinglibrary",
      "lucide",
      "zod",
      "socketdotio",
      "meilisearch",
    ],
  },
];

/** 依赖行图标：精确名、scope 兜底与无匹配回退各取一枚样例。 */
const DEPENDENCY_SAMPLES = ["react", "@radix-ui/react-dialog", "@playwright/test", "zustand", "elysia", "left-pad"];

function BrandGallery() {
  return (
    <div className="grid w-fit gap-5 p-4">
      {BRAND_GROUPS.map((group) => (
        <section key={group.title}>
          <h2 className="text-sm font-semibold">{group.title}</h2>
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-3">
            {group.brands.map((brand) => (
              <li key={brand} className="flex w-24 items-center gap-2 text-muted-foreground">
                <CreditBrandMark brand={brand} className="size-5" />
                <span className="truncate font-mono text-xs">{brand}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <section>
        <h2 className="text-sm font-semibold">尺寸随调用处</h2>
        <ul className="mt-2 flex items-end gap-3 text-muted-foreground">
          {(["size-3", "size-4", "size-5", "size-6"] as const).map((size) => (
            <li key={size} className="flex flex-col items-center gap-1">
              <CreditBrandMark brand="deepseek" className={size} />
              <span className="font-mono text-2xs">{size}</span>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2 className="text-sm font-semibold">依赖行图标</h2>
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-3">
          {DEPENDENCY_SAMPLES.map((packageName) => (
            <li key={packageName} className="flex w-56 items-center gap-2 text-muted-foreground">
              <DependencyGlyph packageName={packageName} />
              <span className="truncate font-mono text-xs">{packageName}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

const meta = {
  title: "页面/开源致谢/品牌图标",
  component: CreditBrandMark,
  args: { brand: "deepseek" },
  render: () => <BrandGallery />,
} satisfies Meta<typeof CreditBrandMark>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AllBrands: Story = {
  name: "全部品牌",
};
