import type { Meta, StoryObj } from "@storybook/react-vite";
import { Input } from "./Input";
import { Label } from "./Label";
import { Textarea } from "./Textarea";

const meta = {
  title: "基础控件/Input",
  component: Input,
  args: { placeholder: "输入用户名" },
} satisfies Meta<typeof Input>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = { name: "调试", tags: ["no-shot"] };

export const Empty: Story = {
  name: "默认",
  render: () => (
    <div className="w-80 space-y-2">
      <Label htmlFor="story-input-username">用户名</Label>
      <Input id="story-input-username" placeholder="输入用户名" maxLength={20} />
    </div>
  ),
};

export const Filled: Story = {
  name: "已填写",
  render: () => (
    <div className="w-80 space-y-2">
      <Label htmlFor="story-input-room-name">房间名称</Label>
      <Input
        id="story-input-room-name"
        defaultValue="海豹的房间"
        placeholder="输入房间名称"
        className="h-10"
      />
    </div>
  ),
};

export const Disabled: Story = {
  name: "禁用",
  render: () => (
    <div className="w-80 space-y-2">
      <Label htmlFor="story-input-disabled">房间名称</Label>
      <Input
        id="story-input-disabled"
        defaultValue="小布丁的房间"
        placeholder="输入房间名称"
        disabled
        className="h-10"
      />
    </div>
  ),
};

export const Invalid: Story = {
  name: "校验失败",
  render: () => (
    <div className="w-80 space-y-2">
      <Label htmlFor="story-input-password">房间密码</Label>
      <Input
        id="story-input-password"
        type="password"
        placeholder="设置房间密码"
        aria-invalid="true"
        aria-describedby="story-input-password-error"
        className="h-10"
      />
      <p id="story-input-password-error" className="text-xs text-destructive">
        私密房间需要设置密码
      </p>
    </div>
  ),
};

/** 多行输入（反馈正文）：外框与 Input 同为 field-frame，只能纵向拉伸；禁用与校验失败与单行同口径。 */
export const Multiline: Story = {
  name: "多行输入",
  render: () => (
    <div className="w-80 space-y-4">
      <div className="space-y-2">
        <Label htmlFor="story-textarea">反馈内容</Label>
        <Textarea id="story-textarea" placeholder="说说遇到了什么问题" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="story-textarea-invalid">反馈内容</Label>
        <Textarea
          id="story-textarea-invalid"
          defaultValue="太短"
          aria-invalid="true"
          aria-describedby="story-textarea-invalid-error"
        />
        <p id="story-textarea-invalid-error" className="text-xs text-destructive">
          至少写 10 个字
        </p>
      </div>
      <Textarea aria-label="已提交的反馈" defaultValue="已提交，等待处理。" disabled />
    </div>
  ),
};
