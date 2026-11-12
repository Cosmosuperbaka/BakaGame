import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { Eye, Filter, Globe, Music, Users } from "lucide-react";
import {
  SettingReveal,
  SettingScaleSlider,
  SettingSegmented,
  SettingSelect,
  SettingsFields,
  SettingsReadOnly,
  SettingsSection,
  SettingStepper,
  SettingSwitchRow,
  SettingTextField,
  SettingToggleChips,
  SettingValue,
  SettingYearRange,
} from "./SettingFields";

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
      <SettingSwitchRow
        label="私密房间"
        icon={Globe}
        checked={false}
        onCheckedChange={args.onCheckedChange}
      />
      <SettingSwitchRow
        label="允许旁观"
        icon={Users}
        checked
        onCheckedChange={args.onCheckedChange}
      />
      <SettingSwitchRow
        label="死亡时揭露身份"
        icon={Eye}
        checked
        onCheckedChange={args.onCheckedChange}
      />
      <SettingSwitchRow
        label="血战模式"
        description="有人猜中后继续，直到所有人结束。"
        checked={false}
        onCheckedChange={args.onCheckedChange}
      />
      <SettingSwitchRow
        label="天使"
        description="8 人开启"
        checked={false}
        disabled
        onCheckedChange={args.onCheckedChange}
      />
    </div>
  ),
};

/** 数值步进：到达上下限时对应按钮禁用，单位接在标签后；目录模式下年份与热度范围整行禁用。 */
export const Steppers: Story = {
  name: "数值步进",
  render: () => (
    <div className="space-y-4">
      <SettingStepper
        label="卧底人数"
        description="上限 3"
        value={3}
        minimum={1}
        maximum={3}
        onChange={fn()}
      />
      <SettingStepper
        label="每次行动限时"
        description="设为 0 表示不限行动时间。"
        unit="秒"
        value={0}
        minimum={0}
        maximum={120}
        step={10}
        onChange={fn()}
      />
      <SettingStepper label="猜测次数" value={10} minimum={1} maximum={100} onChange={fn()} />
      <SettingStepper
        label="起始年份"
        value={2005}
        minimum={1900}
        maximum={2200}
        disabled
        onChange={fn()}
      />
    </div>
  ),
};

/**
 * 窄容器（14rem）：标签列至少 10rem，加上间距与 8rem 的凹槽放不下一行，步进器整组折到标签下方靠右。
 * 虚线框标出容器边界，靠右是对着它的右缘，而不是对着外面的故事卡片。
 */
export const SteppersNarrow: Story = {
  name: "数值步进 · 窄容器",
  decorators: [
    (Story) => (
      <div className="w-56 rounded-md border border-dashed p-2">
        <Story />
      </div>
    ),
  ],
  render: () => (
    <div className="space-y-4">
      <SettingStepper label="猜测次数" value={10} minimum={1} maximum={100} onChange={fn()} />
      <SettingStepper label="每部候选角色数" value={6} minimum={1} maximum={100} onChange={fn()} />
      <SettingStepper
        label="每次行动限时"
        description="设为 0 表示不限行动时间。"
        unit="秒"
        value={60}
        minimum={0}
        maximum={120}
        step={10}
        onChange={fn()}
      />
    </div>
  ),
};

/** 文本输入：已有值的房间名称，以及尚未填写、只露出占位提示的房间密码。 */
export const TextFields: Story = {
  name: "文本输入",
  render: () => (
    <div className="space-y-4">
      <SettingTextField
        label="房间名称"
        value="周五夜听歌会"
        placeholder="输入房间名称"
        onChange={fn()}
      />
      <SettingTextField
        label="房间密码"
        type="password"
        value=""
        placeholder="设置房间密码"
        onChange={fn()}
      />
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
        options={[
          { value: "", label: "全部来源" },
          ...["原创", "漫画改", "游戏改", "小说改"].map((value) => ({ value, label: value })),
        ]}
        onChange={fn()}
      />
      <SettingSelect
        label="指定出题人"
        value=""
        options={[{ value: "", label: "暂无可选出题人" }]}
        disabled
        onChange={fn()}
      />
    </div>
  ),
};

const SONG_TYPES = [
  { value: "op", label: "OP" },
  { value: "ed", label: "ED" },
  { value: "insert", label: "插曲" },
  { value: "character", label: "角色歌" },
];
const HEAT_STOPS = [0, 100, 500, 1000, 3000, 5000, 10000, 30000];
const formatHeat = (value: number) => (value === 0 ? "不限" : `${value}`);

/** 分段单选、刻度滑动条、年份范围：三种凹槽控件与开关、步进器同一行排布，标签在左、控件在右。 */
export const Choices: Story = {
  name: "分段、刻度与年份范围",
  render: () => (
    <SettingsFields>
      <SettingSegmented
        label="出题方式"
        value="auto"
        options={[
          { value: "auto", label: "自动出题" },
          { value: "host", label: "房主出题" },
        ]}
        description="自动出题按下方的筛选条件抽题。"
        onValueChange={fn()}
      />
      <SettingScaleSlider
        label="热度门槛"
        description="只从收藏数高于门槛的角色里抽题。"
        value={1000}
        stops={HEAT_STOPS}
        majors={[0, 1000, 10000]}
        format={formatHeat}
        onChange={fn()}
      />
      <SettingYearRange label="作品年份" start={2010} end={2024} onChange={fn()} />
      <SettingYearRange
        label="番剧年份"
        start={undefined}
        end={2020}
        optional
        description="留空表示不限。"
        onChange={fn()}
      />
    </SettingsFields>
  ),
};

/** 多选胶囊：选中项主色浅底描边，未选项虚线；没全选时标签行右侧出现「全选」。 */
export const ToggleChips: Story = {
  name: "多选胶囊",
  render: () => (
    <SettingsFields>
      <SettingToggleChips
        label="歌曲类型"
        options={SONG_TYPES}
        selected={["op", "ed"]}
        onChange={fn()}
      />
      <SettingToggleChips
        label="全部选中"
        options={SONG_TYPES}
        selected={SONG_TYPES.map((option) => option.value)}
        onChange={fn()}
      />
    </SettingsFields>
  ),
};

/** 折叠组内的小节：小标题带图标，相邻小节之间一道分隔线；随开关出现的从属字段按高度展开。 */
export const Sections: Story = {
  name: "小节与从属字段",
  render: () => (
    <div>
      <SettingsSection title="歌曲" icon={Music}>
        <SettingSwitchRow label="显示歌词" checked onCheckedChange={fn()} />
        <SettingReveal open>
          <SettingStepper label="歌词行数" value={4} minimum={1} maximum={8} onChange={fn()} />
        </SettingReveal>
      </SettingsSection>
      <SettingsSection title="筛选" icon={Filter}>
        <SettingSelect
          label="作品来源"
          value=""
          options={[{ value: "", label: "全部来源" }]}
          onChange={fn()}
        />
      </SettingsSection>
    </div>
  ),
};

/** 非房主看到的同一份结构：控件换成右侧的取值文字，未设置与关闭项弱化。 */
export const ReadOnly: Story = {
  name: "只读",
  render: () => (
    <SettingsReadOnly readOnly>
      <SettingsFields>
        <SettingSwitchRow label="允许旁观" icon={Users} checked onCheckedChange={fn()} />
        <SettingSwitchRow label="私密房间" icon={Globe} checked={false} onCheckedChange={fn()} />
        <SettingStepper label="猜测次数" value={10} minimum={1} maximum={100} onChange={fn()} />
        <SettingTextField label="目录编号" value="" placeholder="输入目录编号" onChange={fn()} />
        <SettingSegmented
          label="出题方式"
          value="auto"
          options={[
            { value: "auto", label: "自动出题" },
            { value: "host", label: "房主出题" },
          ]}
          onValueChange={fn()}
        />
        <SettingScaleSlider
          label="热度门槛"
          value={0}
          stops={HEAT_STOPS}
          format={formatHeat}
          onChange={fn()}
        />
        <SettingYearRange label="作品年份" start={2010} end={2024} onChange={fn()} />
        <SettingToggleChips
          label="歌曲类型"
          options={SONG_TYPES}
          selected={["op"]}
          onChange={fn()}
        />
        <SettingValue label="歌单" value="周五夜听歌会 · 120 首" />
      </SettingsFields>
    </SettingsReadOnly>
  ),
};
