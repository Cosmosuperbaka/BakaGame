import type { Meta, StoryObj } from "@storybook/react-vite";
import { screen, within } from "storybook/test";
import { dropFocus } from "@/stories/PlayHelpers";
import { ADMIN_GAMES, adminPanelFrame, installAdmin } from "@/stories/fixtures/Admin";
import { GamesPanel } from "./GamesPanel";

/** 对局记录：游戏与房间号筛选、列表、分页，详情弹窗（玩家表、回合、关键事件）。 */
const meta = {
  title: "Admin/GamesPanel",
  component: GamesPanel,
  tags: ["overlay"],
  decorators: [adminPanelFrame],
} satisfies Meta<typeof GamesPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

const ready = () => screen.findByText(ADMIN_GAMES[0].roomId);

export const WithData: Story = {
  name: "有数据",
  beforeEach: () => installAdmin(),
  play: async () => {
    await ready();
  },
};

/** 房间号已填、没有匹配。 */
export const NoMatch: Story = {
  name: "房间号无结果",
  beforeEach: () => installAdmin(),
  play: async ({ userEvent }) => {
    await ready();
    await userEvent.type(screen.getByLabelText("房间号"), "R00000");
    await screen.findByText("没有符合条件的对局");
    dropFocus();
  },
};

export const Loading: Story = {
  name: "加载中",
  beforeEach: () => installAdmin({ "admin/games/list": "pending" }),
};

export const Failed: Story = {
  name: "读取失败",
  beforeEach: () => installAdmin({ "admin/games/list": "error" }),
  play: async () => {
    await screen.findByText("对局记录加载失败");
  },
};

/** 详情：12 人玩家表、6 个回合（展开第一个）、30 条关键事件。 */
export const Detail: Story = {
  name: "详情",
  beforeEach: () => installAdmin(),
  play: async ({ userEvent }) => {
    await userEvent.click(await ready());
    const dialog = within(await screen.findByRole("dialog"));
    await userEvent.click(await dialog.findByText(/^第 1 回合 ·/));
    dropFocus();
  },
};

export const DetailLoading: Story = {
  name: "详情 · 加载中",
  beforeEach: () => installAdmin({ "admin/games/get": "pending" }),
  play: async ({ userEvent }) => {
    await userEvent.click(await ready());
    await screen.findByRole("dialog");
    dropFocus();
  },
};
