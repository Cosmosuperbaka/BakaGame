import type { Meta, StoryObj } from "@storybook/react-vite";
import { Label } from "./Label";
import { Switch } from "./Switch";

const meta = {
  title: "基础控件/Switch",
  component: Switch,
  args: { "aria-label": "允许旁观" },
} satisfies Meta<typeof Switch>;

export default meta;
type Story = StoryObj<typeof meta>;

function SettingRow({
  id,
  label,
  hint,
  defaultChecked,
  disabled,
}: {
  id: string;
  label: string;
  hint?: string;
  defaultChecked?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <Label htmlFor={id} className="text-sm">
          {label}
        </Label>
        {hint ? <p className="mt-1 text-2xs text-muted-foreground">{hint}</p> : null}
      </div>
      <Switch id={id} defaultChecked={defaultChecked} disabled={disabled} />
    </div>
  );
}

export const Playground: Story = { name: "调试", tags: ["no-shot"] };

export const OnOff: Story = {
  name: "开启与关闭",
  render: () => (
    <div className="w-80 space-y-5">
      <SettingRow id="story-switch-private" label="私密房间" />
      <SettingRow id="story-switch-spectators" label="允许旁观" defaultChecked />
    </div>
  ),
};

export const Disabled: Story = {
  name: "禁用",
  render: () => (
    <div className="w-80 space-y-5">
      <SettingRow
        id="story-switch-blood"
        label="血战模式"
        hint="首位答对获得正式玩家数分，之后每位答对者依次少 1 分。"
        disabled
      />
      <SettingRow id="story-switch-lyrics" label="显示歌词" hint="关闭后只播放音乐，不显示歌词提示。" defaultChecked disabled />
    </div>
  ),
};
