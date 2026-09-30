import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { Eye, Globe, Users } from "lucide-react";
import { SettingSelect, SettingStepper, SettingSwitchRow } from "./SettingFields";

const meta = {
  title: "公共组件/SettingFields",
  component: SettingSwitchRow,
  args: { label: "允许旁观", checked: true, onCheckedChange: fn() },
  decorators: [
    (Story) => (
      <div className="w-[28rem] rounded-md border bg-panel p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SettingSwitchRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = { name: "调试", tags: ["no-shot"] };

/** 三个游戏设置面板里的开关行：带图标、带说明，以及人数不足时禁用的角色开关。 */
export const SwitchRows: Story = {
  name: "开关行",
  render: (args) => (
    <div className="space-y-4">
      <SettingSwitchRow label="私密房间" icon={Globe} checked={false} onCheckedChange={args.onCheckedChange} />
      <SettingSwitchRow label="允许旁观" icon={Users} checked onCheckedChange={args.onCheckedChange} />
      <SettingSwitchRow label="死亡时揭露身份" icon={Eye} checked onCheckedChange={args.onCheckedChange} />
      <SettingSwitchRow label="血战模式" description="有人猜中后继续，直到所有人结束。" checked={false} onCheckedChange={args.onCheckedChange} />
      <SettingSwitchRow label="天使" description="8 人开启" checked={false} disabled onCheckedChange={args.onCheckedChange} />
    </div>
  ),
};

/** 数值步进：到达上下限时对应按钮禁用，单位接在标签后；目录模式下年份与热度范围整行禁用。 */
export const Steppers: Story = {
  name: "数值步进",
  render: () => (
    <div className="space-y-4">
      <SettingStepper label="卧底人数" description="上限 3" value={3} minimum={1} maximum={3} onChange={fn()} />
      <SettingStepper label="每次行动限时" description="设为 0 表示不限行动时间。" unit="秒" value={0} minimum={0} maximum={120} step={10} onChange={fn()} />
      <SettingStepper label="猜测次数" value={10} minimum={1} maximum={100} onChange={fn()} />
      <SettingStepper label="起始年份" value={2005} minimum={1900} maximum={2200} disabled onChange={fn()} />
    </div>
  ),
};

/** 下拉选择：「不限」映射为空值；没有候选时禁用，并在框内说明原因。 */
export const Selects: Story = {
  name: "下拉选择",
  render: () => (
    <div className="space-y-4">
      <SettingSelect
        label="作品来源"
        value=""
        options={[{ value: "", label: "全部来源" }, ...["原创", "漫画改", "游戏改", "小说改"].map((value) => ({ value, label: value }))]}
        onChange={fn()}
      />
      <SettingSelect label="指定出题人" value="" options={[{ value: "", label: "暂无可选出题人" }]} disabled onChange={fn()} />
    </div>
  ),
};
