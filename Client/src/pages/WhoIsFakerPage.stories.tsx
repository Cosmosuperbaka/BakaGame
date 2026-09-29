import type { Meta, StoryObj } from "@storybook/react-vite";
import { screen, userEvent, within } from "storybook/test";
import { dropFocus } from "@/stories/PlayHelpers";
import { presetWhoIsFaker } from "@/stories/StorePresets";
import { seedWifUsername, WIF_LOBBY_ROOMS, WIF_PEOPLE } from "@/stories/fixtures/WhoIsFaker";
import WhoIsFakerPage from "./WhoIsFakerPage";

const meta = {
  title: "页面/谁是卧底大厅",
  component: WhoIsFakerPage,
  tags: ["page"],
  parameters: { layout: "fullscreen", router: { route: "/whoisfaker" } },
  beforeEach: () => seedWifUsername(WIF_PEOPLE.me.name),
} satisfies Meta<typeof WhoIsFakerPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
  name: "加载中",
  beforeEach: () => presetWhoIsFaker({ connected: false, rooms: [] }),
};

export const Empty: Story = {
  name: "空列表",
  beforeEach: () => presetWhoIsFaker({ connected: true, lobbyReady: true, rooms: [] }),
};

export const RoomList: Story = {
  name: "房间列表",
  beforeEach: () => presetWhoIsFaker({ connected: true, lobbyReady: true, rooms: WIF_LOBBY_ROOMS }),
};

export const NoUsername: Story = {
  name: "未设置用户名",
  beforeEach: () => {
    presetWhoIsFaker({ connected: true, lobbyReady: true, rooms: WIF_LOBBY_ROOMS });
    return seedWifUsername("");
  },
};

export const PasswordDialog: Story = {
  name: "输入房间密码",
  tags: ["!page", "overlay"],
  beforeEach: () => presetWhoIsFaker({ connected: true, lobbyReady: true, rooms: WIF_LOBBY_ROOMS }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /深夜卧底局/ }));
    await screen.findByRole("dialog", { name: "输入房间密码" });
    dropFocus();
  },
};
