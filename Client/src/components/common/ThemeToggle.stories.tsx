import type { Meta, StoryObj } from "@storybook/react-vite";
import { setThemePreference, type ThemePreference } from "@/lib/Theme";
import { ThemeToggle } from "./ThemeToggle";

/**
 * 组件无 props，档位由 `lib/Theme` 的模块状态决定：
 * 故事按档位各渲染一枚触发按钮，点开即可核对浮层里三档的图标列与文字是否对齐。
 */
const meta = {
  title: "公共组件/ThemeToggle",
  component: ThemeToggle,
  decorators: [
    (Story) => (
      <div className="flex items-center justify-end rounded-md border bg-panel p-2">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ThemeToggle>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = { name: "调试", tags: ["no-shot"] };

const CASES: readonly { name: string; preference: ThemePreference }[] = [
  { name: "浅色", preference: "light" },
  { name: "深色", preference: "dark" },
  { name: "跟随系统", preference: "system" },
];

/** 三档并排：触发图标各不相同，浮层里的选中块落在各自对应的行上。 */
export const AllStates: Story = {
  name: "全部状态",
  render: () => (
    <div className="flex flex-col gap-2">
      {CASES.map(({ name, preference }) => (
        <div key={name} className="flex items-center justify-end gap-2">
          <p className="font-sans text-2xs text-muted-foreground">{name}</p>
          <button
            type="button"
            className="rounded-md px-2 py-1 text-xs underline-offset-4 hover:underline"
            onClick={() => setThemePreference(preference)}
          >
            设为当前
          </button>
          <ThemeToggle />
        </div>
      ))}
    </div>
  ),
};
