import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { fromNow } from "@/stories/fixtures/Common";
import {
  presetWifRoom,
  WIF_STAGE_FRAME,
  wifPrivate,
  wifSnapshot,
} from "@/stories/fixtures/WhoIsFaker";
import { PhaseTimerControl } from "./PhaseTimerControl";

/**
 * 倒计时读真实时钟，`endsAt` 必须在故事运行时计算。
 * 取整到秒避免同一张截图两次运行差 1 秒。
 */
const endingIn = (seconds: number) => fromNow(seconds * 1000);

const meta = {
  title: "谁是卧底/PhaseTimerControl",
  component: PhaseTimerControl,
  args: { onTimeout: fn() },
  decorators: [(Story) => <div className={`${WIF_STAGE_FRAME} mx-auto`}><Story /></div>],
} satisfies Meta<typeof PhaseTimerControl>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 主持人未开启倒计时时的控制栏。 */
export const HostControl: Story = {
  name: "主持人 · 未开启",
  beforeEach: () => presetWifRoom(wifSnapshot("day2"), wifPrivate("host", "day2")),
};

/** 倒计时进行中，剩余时间充裕。 */
export const Running: Story = {
  name: "进行中 · 剩余充裕",
  beforeEach: () => presetWifRoom(
    wifSnapshot("day2", {
      status: { ...wifSnapshot("day2").status, phaseTimer: { durationSeconds: 180, endsAt: endingIn(142), phase: "description" } },
    }),
    wifPrivate("me", "day2"),
  ),
};

/** 剩余不足 30 秒：转入琥珀色警示。 */
export const Warning: Story = {
  name: "进行中 · 剩余不足 30 秒",
  beforeEach: () => presetWifRoom(
    wifSnapshot("day2", {
      status: { ...wifSnapshot("day2").status, phaseTimer: { durationSeconds: 60, endsAt: endingIn(24), phase: "description" } },
    }),
    wifPrivate("me", "day2"),
  ),
};

/** 剩余不足 10 秒：红色警示并带脉动图标。 */
export const Critical: Story = {
  name: "进行中 · 剩余不足 10 秒",
  beforeEach: () => presetWifRoom(
    wifSnapshot("day2", {
      status: { ...wifSnapshot("day2").status, phaseTimer: { durationSeconds: 60, endsAt: endingIn(6), phase: "description" } },
    }),
    wifPrivate("me", "day2"),
  ),
};

/** 投票阶段：出题人可随时取消倒计时。 */
export const HostRunning: Story = {
  name: "主持人 · 倒计时进行中",
  beforeEach: () => presetWifRoom(
    wifSnapshot("vote3", {
      status: { ...wifSnapshot("vote3").status, phaseTimer: { durationSeconds: 120, endsAt: endingIn(96), phase: "voting" } },
    }),
    wifPrivate("host", "vote3"),
  ),
};

/** 等待与出题阶段不支持倒计时，且非主持人看不到入口。 */
export const PlayerNoControl: Story = {
  name: "玩家 · 无控制权限",
  beforeEach: () => presetWifRoom(wifSnapshot("day2"), wifPrivate("me", "day2")),
};
