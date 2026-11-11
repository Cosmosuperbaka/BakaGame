import type { Meta, StoryObj } from "@storybook/react-vite";
import { installStatusFixture, statusFixture } from "@/stories/fixtures/Status";
import StatusPage from "./StatusPage";

/**
 * 公开服务状态页。接口与实时通道都由 fixture 顶替：接口晚一拍回来，
 * 看得到占位桩的呼吸与条带自左向右的显影；悬停条格看浮层在格子之间滑动。
 */
const meta = {
  title: "页面/服务状态",
  component: StatusPage,
  tags: ["page"],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof StatusPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Healthy: Story = {
  name: "全部正常",
  beforeEach: () => installStatusFixture(statusFixture("healthy")),
};

/** 两项异常：QQ音乐的进行中故障与搜索索引的维护窗口同时压在条带上。 */
export const Incident: Story = {
  name: "部分异常与进行中的事件",
  beforeEach: () => installStatusFixture(statusFixture("incident")),
};

/** 前端与四个上游都没有监测结论：不写「所有系统正常」，可用率只算有结论的组件。 */
export const Unmonitored: Story = {
  name: "部分组件未接入监测",
  beforeEach: () => installStatusFixture(statusFixture("unmonitored")),
};

export const Loading: Story = {
  name: "读取中",
  beforeEach: () => installStatusFixture(null),
};
