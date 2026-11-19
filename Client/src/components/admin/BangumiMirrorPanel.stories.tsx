import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  MIRROR_DEGRADED,
  MIRROR_HEALTHY,
  MIRROR_READER,
  MIRROR_STALE,
} from "@/stories/fixtures/BangumiMirror";
import { BangumiMirrorView } from "./BangumiMirrorPanel";

const meta = {
  title: "Admin/BangumiMirrorPanel",
  component: BangumiMirrorView,
} satisfies Meta<typeof BangumiMirrorView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Healthy: Story = { args: { status: MIRROR_HEALTHY } };
export const Stale: Story = { args: { status: MIRROR_STALE } };
export const Degraded: Story = { args: { status: MIRROR_DEGRADED } };
export const ReadOnlyShard: Story = { args: { status: MIRROR_READER } };
