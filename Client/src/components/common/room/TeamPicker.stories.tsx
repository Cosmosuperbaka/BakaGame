import { useState, type ComponentProps } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { TeamPicker } from "./TeamPicker";

const PLAYERS = [
  { id: "me", name: "海豹", team: 2 },
  { id: "peach", name: "桃子", team: 2 },
  { id: "host", name: "小布丁", team: 1 },
  { id: "azumi", name: "阿澄", team: 1 },
  { id: "kanade", name: "Kanade", team: 3 },
  { id: "long", name: "名称很长的玩家用于测试截断", team: 3 },
  { id: "solo-a", name: "独自玩的人", team: null },
];

/** 带本地状态的演示：真实页面由服务端快照回写，这里在点击后立即把本人移到所选队伍。 */
function Interactive(props: ComponentProps<typeof TeamPicker>) {
  const [players, setPlayers] = useState(props.players);
  return (
    <TeamPicker
      {...props}
      players={players}
      onPick={(team) => {
        setPlayers((current) =>
          current.map((player) => (player.id === props.selfId ? { ...player, team } : player))
        );
        props.onPick(team);
      }}
    />
  );
}

const meta = {
  title: "公共组件/TeamPicker",
  component: TeamPicker,
  render: (args) => <Interactive {...args} />,
  args: {
    players: PLAYERS,
    selfId: "me",
    switching: false,
    hint: "同队共享次数与猜测",
    onPick: fn(),
  },
  decorators: [
    (Story) => (
      <div className="w-[28rem] max-w-full rounded-md border bg-panel p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TeamPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 本人已在 2 队：我方占满一行并列出全部队员，其余队伍作为对手排在下方，个人游玩单独一行。 */
export const InTeam: Story = { name: "已入队" };

/** 本人未入队：个人游玩占据我方大卡，八支队伍全部作为对手，个人选项不再重复出现。 */
export const Solo: Story = {
  name: "个人游玩",
  args: {
    players: PLAYERS.map((player) => (player.id === "me" ? { ...player, team: null } : player)),
  },
};

/** 换队请求进行中：整组禁用并显示等待光标，避免连点发出交错请求。 */
export const Switching: Story = { name: "换队中", args: { switching: true } };
