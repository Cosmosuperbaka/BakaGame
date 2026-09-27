import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn, userEvent, within } from "storybook/test";
import { dropFocus } from "@/stories/PlayHelpers";
import { noPending, pendingOn, songBot, songSnapshot, waitingPlayers } from "@/stories/fixtures/SonGuessr";
import { ROOM_ID_TEST_MODE } from "@/types";
import { SongTestController } from "./SongTestController";

const testSnapshot = (bots: number) => songSnapshot({
  roomId: ROOM_ID_TEST_MODE,
  name: "Songuessr 测试房",
  testMode: true,
  players: [...waitingPlayers(), ...["A", "B", "C"].slice(0, bots).map((suffix) => songBot(suffix))],
});

// 控制器绝对定位在游戏区右下角，取景为一块游戏区面板。
const meta = {
  title: "猜歌/SongTestController",
  component: SongTestController,
  args: { snapshot: testSnapshot(2), run: fn(async () => {}), isPending: noPending },
  decorators: [(Story) => <div className="relative h-72 w-[36rem] overflow-hidden rounded-md border bg-panel"><Story /></div>],
} satisfies Meta<typeof SongTestController>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithBots: Story = { name: "展开 · 已添加人机" };

export const NoBots: Story = { name: "展开 · 没有人机", args: { snapshot: testSnapshot(0) } };

export const Adding: Story = {
  name: "正在添加人机",
  args: { isPending: pendingOn("song.test.addBot") },
};

export const Collapsed: Story = {
  name: "收起",
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: /测试控制器/ }));
    dropFocus();
  },
};
