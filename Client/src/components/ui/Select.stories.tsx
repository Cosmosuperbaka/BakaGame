import type { Meta, StoryObj } from "@storybook/react-vite";
import { screen } from "storybook/test";
import { Label } from "./Label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./Select";

const meta = {
  title: "基础控件/Select",
  component: Select,
} satisfies Meta<typeof Select>;

export default meta;
type Story = StoryObj<typeof meta>;

const TEAM_OPTIONS = [
  { value: "solo", label: "个人游玩" },
  ...Array.from({ length: 8 }, (_, index) => ({ value: String(index + 1), label: `第 ${index + 1} 队` })),
];

function TeamSelect({ defaultValue = "solo", disabled = false }: { defaultValue?: string; disabled?: boolean }) {
  return (
    <div className="w-64 space-y-2">
      <Label htmlFor="story-team-select">我的队伍</Label>
      <Select defaultValue={defaultValue} disabled={disabled}>
        <SelectTrigger id="story-team-select">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {TEAM_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export const Closed: Story = {
  name: "收起",
  render: () => <TeamSelect />,
};

export const Disabled: Story = {
  name: "禁用",
  render: () => <TeamSelect defaultValue="2" disabled />,
};

export const Open: Story = {
  name: "展开",
  tags: ["overlay"],
  render: () => <TeamSelect defaultValue="2" />,
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("combobox", { name: "我的队伍" }));
    await screen.findByRole("listbox");
  },
};
