import type { ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ROLE_LABELS } from "@/config/WhoIsFakerPresentation";
import { cn } from "@/lib/Utils";
import type { WhoIsFakerRole } from "@/types";
import { RoleBadge } from "./RoleBadge";

const meta = {
  title: "谁是卧底/RoleBadge",
  component: RoleBadge,
  args: { role: "undercover" },
} satisfies Meta<typeof RoleBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = { name: "调试", tags: ["no-shot"] };

const ROLES = Object.keys(ROLE_LABELS) as WhoIsFakerRole[];

function Row({ label, muted = false, children }: { label: string; muted?: boolean; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-16 shrink-0 text-xs text-muted-foreground">{label}</span>
      <div className={cn("flex items-center gap-2 rounded-md px-2 py-1.5", muted && "bg-muted")}>{children}</div>
    </div>
  );
}

/**
 * 同一套徽章在三种所在面上的样子：玩家栏面板上的真实身份、本人预测的淡色块，
 * 以及出题人预览卡片与结算表这类 `bg-muted` 实色块上的 `inset`。
 */
export const Surfaces: Story = {
  name: "全部身份与所在面",
  render: () => (
    <div className="flex w-fit flex-col gap-2 rounded-md border bg-panel p-4">
      <Row label="真实身份">
        {ROLES.map((role) => <RoleBadge key={role} role={role} />)}
      </Row>
      <Row label="本人预测">
        {ROLES.map((role) => <RoleBadge key={role} role={role} predicted />)}
      </Row>
      <Row label="实色块内" muted>
        {ROLES.map((role) => <RoleBadge key={role} role={role} inset />)}
      </Row>
    </div>
  ),
};
