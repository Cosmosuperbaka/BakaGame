import type { Meta, StoryObj } from "@storybook/react-vite";
import { dropFocus } from "@/stories/PlayHelpers";
import {
  emptyStatusFixture,
  installFailingStatusFixture,
  installStatusFixture,
  statusFixture,
} from "@/stories/fixtures/Status";
import StatusPage from "./StatusPage";

/**
 * 公开服务状态页。接口与实时通道都由 fixture 顶替：接口晚一拍回来，
 * 看得到占位桩的呼吸与条带自左向右的显影；悬停条格看浮层在格子之间滑动。
 *
 * 实时快照经假 WebSocket 晚约 200ms 推来：每个有数据的故事都在 play 里等主卡标题落定再截图，
 * 否则截图会停在「正在读取服务状态…」，与故事名不符。
 */
const meta = {
  title: "页面/服务状态",
  component: StatusPage,
  tags: ["page"],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof StatusPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 页面自己的纵向滚动容器：把某个标题滚到视口上缘附近（只滚这一层，不连带外层）。 */
function scrollPageTo(heading: HTMLElement) {
  let node = heading.parentElement;
  while (node && getComputedStyle(node).overflowY !== "auto") node = node.parentElement;
  if (!node) return;
  node.scrollTop += heading.getBoundingClientRect().top - node.getBoundingClientRect().top - 24;
}

export const Healthy: Story = {
  name: "全部正常",
  beforeEach: () => installStatusFixture(statusFixture("healthy")),
  play: async ({ canvas }) => {
    await canvas.findByRole("heading", { name: "所有系统运行正常" });
  },
};

/** 两项异常：QQ音乐的进行中故障与搜索索引的维护窗口同时压在条带上。 */
export const Incident: Story = {
  name: "部分异常与进行中的事件",
  beforeEach: () => installStatusFixture(statusFixture("incident")),
  play: async ({ canvas }) => {
    await canvas.findByRole("heading", { name: "2 项服务异常" });
  },
};

/** 同一场景滚到页尾：进行中的故障卡、维护卡与已结束的时间线。 */
export const IncidentEvents: Story = {
  name: "事件与维护",
  beforeEach: () => installStatusFixture(statusFixture("incident")),
  play: async ({ canvas }) => {
    await canvas.findByRole("heading", { name: "2 项服务异常" });
    await canvas.findByText("QQ音乐接口请求超时");
    scrollPageTo(canvas.getByRole("heading", { name: "事件与维护" }));
  },
};

/** 上游接口全线与搜索索引同时故障：主卡点名六项，条带末段成片红格。 */
export const Outage: Story = {
  name: "大面积故障",
  beforeEach: () => installStatusFixture(statusFixture("outage")),
  play: async ({ canvas }) => {
    await canvas.findByRole("heading", { name: "6 项服务异常" });
  },
};

/** 前端与四个上游都没有监测结论：不写「所有系统正常」，可用率只算有结论的组件。 */
export const Unmonitored: Story = {
  name: "部分组件未接入监测",
  beforeEach: () => installStatusFixture(statusFixture("unmonitored")),
  play: async ({ canvas }) => {
    await canvas.findByRole("heading", { name: "已监测的服务运行正常" });
  },
};

/** 切到近 30 天：日格、平均延迟（数字前标「平均」）与「30 天前 / 今天」轴标。 */
export const Month: Story = {
  name: "近 30 天",
  beforeEach: () => installStatusFixture(statusFixture("incident")),
  play: async ({ canvas, userEvent }) => {
    await canvas.findByRole("heading", { name: "2 项服务异常" });
    await userEvent.click(canvas.getByRole("radio", { name: "近 30 天" }));
    await canvas.findAllByText("30 天前");
    // 分段控件是原生单选：合成点击后焦点留在输入上，会画出键盘焦点环，真实鼠标点击不会。
    (document.activeElement as HTMLElement | null)?.blur();
    dropFocus();
  },
};

/** 刚上线还没有样本：条带全是矮桩，可用率与延迟读作「—」，事件区写「近 30 天没有」。 */
export const NoHistory: Story = {
  name: "暂无历史数据",
  beforeEach: () => installStatusFixture(emptyStatusFixture()),
  play: async ({ canvas }) => {
    await canvas.findByRole("heading", { name: "暂时无法确认服务状态" });
  },
};

/** 三个状态接口都读失败、实时通道正常：条带静止在矮桩（不冒充还在加载），事件区说明读不到。 */
export const LoadFailed: Story = {
  name: "历史数据读取失败",
  beforeEach: () => installFailingStatusFixture(statusFixture("healthy").snapshot),
  play: async ({ canvas }) => {
    await canvas.findByRole("heading", { name: "所有系统运行正常" });
    await canvas.findByText("事件记录暂时读不到，稍后会自动重试。");
    scrollPageTo(canvas.getByRole("heading", { name: "事件与维护" }));
  },
};

/** 实时通道一直连不上（挡 WebSocket 的网络）：几秒后回落到状态查询接口，主卡与徽章照常有结论。 */
export const LiveUnavailable: Story = {
  name: "实时通道不通 · 回落接口",
  beforeEach: () => installStatusFixture(statusFixture("incident"), 46, { live: false }),
  play: async ({ canvas }) => {
    await canvas.findByRole("heading", { name: "2 项服务异常" }, { timeout: 12_000 });
  },
};

/** 实时通道与状态接口都读不到：主卡说明读不到，而不是一直写「正在读取」。 */
export const SnapshotUnavailable: Story = {
  name: "实时通道与接口都不通",
  beforeEach: () => installFailingStatusFixture(statusFixture("healthy").snapshot, { live: false }),
  play: async ({ canvas }) => {
    await canvas.findByRole("heading", { name: "暂时读不到服务状态" }, { timeout: 12_000 });
  },
};

export const Loading: Story = {
  name: "读取中",
  beforeEach: () => installStatusFixture(null),
};
