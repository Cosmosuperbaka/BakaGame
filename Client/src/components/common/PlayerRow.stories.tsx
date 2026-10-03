import { useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { screen, userEvent, within } from "storybook/test";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { CCBMarks } from "@/components/ccb/CCBMarks";
import { dropFocus } from "@/stories/PlayHelpers";
import { STORY_PLAYERS } from "@/stories/fixtures/Common";
import { hostActions, PlayerRow } from "./PlayerRow";
import { PlayerStatusPill } from "./PlayerStatusPill";

const [host, me, peach, azumi, kanade, , longName] = STORY_PLAYERS;

/** 三个游戏在次行实际放的内容，用于核对同一行骨架承载不同信息的观感。 */
const SECOND_LINE_CASES: Array<{ name: string; badges: ReactNode; meta?: ReactNode; detail?: ReactNode }> = [
  { name: "谁是卧底 · 局内", badges: <PlayerStatusPill label="平民" tone="default" /> },
  { name: "猜歌 · 猜歌中", badges: <PlayerStatusPill label="猜歌" tone="warning" /> },
  {
    name: "CCB · 猜测中",
    badges: <PlayerStatusPill label="猜测中" tone="warning" />,
    meta: <span className="truncate font-sans text-2xs text-muted-foreground">2 队 · 3/10 次 · 已提交</span>,
    detail: <CCBMarks marks="❌💡❌" name={host.name} />,
  },
];

const meta = {
  title: "公共组件/PlayerRow",
  component: PlayerRow,
  args: { name: host.name, score: 12 },
  decorators: [
    (Story) => (
      <div className="w-[16rem] rounded-md border bg-panel p-2">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PlayerRow>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 行内各标记的组合：房主、本人、断线、人机、出局与长名字截断。 */
export const AllStates: Story = {
  name: "全部行内状态",
  render: () => (
    <div className="flex flex-col gap-px">
      <PlayerRow name={host.name} score={12} host badges={<PlayerStatusPill label="准备" tone="success" />} />
      <PlayerRow name={me.name} score={9} me host badges={<PlayerStatusPill label="猜歌" tone="warning" />} />
      <PlayerRow name={peach.name} score={15} eliminated badges={<PlayerStatusPill label="完成" tone="default" />} />
      <PlayerRow name={kanade.name} score={3} online={false} badges={<PlayerStatusPill label="等待" tone="default" />} />
      <PlayerRow name={azumi.name} score={6} bot badges={<PlayerStatusPill label="准备" tone="success" />} />
      <PlayerRow name={longName.name} score={0} badges={<PlayerStatusPill label="旁观" tone="default" />} />
    </div>
  ),
};

export const PerGameSecondLine: Story = {
  name: "各游戏的次行内容",
  render: () => (
    <div className="flex flex-col gap-3">
      {SECOND_LINE_CASES.map((game) => (
        <div key={game.name} className="flex flex-col gap-1">
          <p className="font-sans text-2xs text-muted-foreground">{game.name}</p>
          <PlayerRow name={host.name} score={12} host badges={game.badges} meta={game.meta} detail={game.detail} />
        </div>
      ))}
    </div>
  ),
};

/** 分数位数变化时右端不被长名字挤出。 */
export const ScoreWidths: Story = {
  name: "分数与长名字",
  render: () => (
    <div className="flex flex-col gap-px">
      {[0, 7, 42, 128, 9999].map((score) => (
        <PlayerRow
          key={score}
          name={longName.name}
          score={score}
          badges={<PlayerStatusPill label="猜测中" tone="warning" />}
        />
      ))}
    </div>
  ),
};

const manage = hostActions({ onTransferHost: () => {}, onKick: () => {} });

/** 有操作权限时整行是可聚焦的原生按钮，Enter 与空格都能打开浮层。 */
export const WithActions: Story = {
  name: "可操作行",
  render: () => <PlayerRow name={peach.name} score={15} actions={manage} />,
};

export const ActionPopover: Story = {
  name: "操作浮层",
  tags: ["overlay"],
  render: () => <PlayerRow name={peach.name} score={15} actions={manage} />,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: `${peach.name} 操作` }));
    await screen.findByRole("button", { name: /转移房主/ });
    dropFocus();
  },
};

/** 动作不可执行时保留在浮层里并禁用，而不是消失造成位置跳变。 */
export const DisabledActions: Story = {
  name: "动作禁用",
  render: () => (
    <PlayerRow
      name={azumi.name}
      score={6}
      actions={hostActions({ onTransferHost: () => {}, transferDisabled: true, onKick: () => {} })}
    />
  ),
};

/** 嵌入发言历史首栏时去掉行自身的进出场动画，交由外层表格统一处理。 */
export const Embedded: Story = {
  name: "嵌入表格首列",
  render: () => (
    <div className="flex flex-col gap-px">
      <PlayerRow name={host.name} score={12} host embedded badges={<PlayerStatusPill label="平民" tone="default" />} />
      <PlayerRow name={me.name} score={9} me embedded badges={<PlayerStatusPill label="平民" tone="default" />} />
    </div>
  ),
};

function ScoringRows() {
  const [scores, setScores] = useState([12, 9]);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-px">
        <PlayerRow name={host.name} score={scores[0]} host badges={<PlayerStatusPill label="猜中" tone="success" />} />
        <PlayerRow name={me.name} score={scores[1]} me badges={<PlayerStatusPill label="猜歌" tone="warning" />} />
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={() => setScores(([first, second]) => [first + 3, second])}>房主 +3</Button>
        <Button size="sm" variant="outline" onClick={() => setScores(([first, second]) => [first, second + 1])}>本人 +1</Button>
        <Button size="sm" variant="outline" onClick={() => setScores(([first, second]) => [first, second - 2])}>本人 -2</Button>
      </div>
    </div>
  );
}

/** 分数变化：逐位滚到新值，加分时在分数上方浮起「+N」。只供交互调试，截图拍不到过程。 */
export const Scoring: Story = {
  name: "得分变化",
  tags: ["no-shot"],
  render: () => <ScoringRows />,
};

/** 与附加徽章并排：徽章槽不限制数量，由各游戏自行组合。 */
export const WithBadgeSlot: Story = {
  name: "与附加徽章并排",
  render: () => (
    <PlayerRow
      name={host.name}
      score={12}
      host
      badges={<>
        <PlayerStatusPill label="平民" tone="default" />
        <Badge variant="outline">原版</Badge>
      </>}
    />
  ),
};
