import type { Meta, StoryObj } from "@storybook/react-vite";
import { screen, userEvent, within } from "storybook/test";
import { dropFocus } from "@/stories/PlayHelpers";
import { presetSonGuessr } from "@/stories/StorePresets";
import { SONG_LOBBY_ROOMS, SONG_PEOPLE, seedUsername } from "@/stories/fixtures/SonGuessr";
import SonGuessrPage from "./SonGuessrPage";

const meta = {
  title: "页面/猜歌大厅",
  component: SonGuessrPage,
  tags: ["page"],
  parameters: { layout: "fullscreen", router: { route: "/songuessr" } },
  beforeEach: () => seedUsername(SONG_PEOPLE.me.name),
} satisfies Meta<typeof SonGuessrPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
  name: "加载中",
  beforeEach: () => presetSonGuessr({ connected: false, rooms: [] }),
};

export const Empty: Story = {
  name: "空列表",
  beforeEach: () => presetSonGuessr({ connected: true, lobbyReady: true, rooms: [] }),
};

export const RoomList: Story = {
  name: "房间列表",
  beforeEach: () => presetSonGuessr({ connected: true, lobbyReady: true, rooms: SONG_LOBBY_ROOMS }),
};

export const PasswordDialog: Story = {
  name: "输入房间密码",
  tags: ["!page", "overlay"],
  beforeEach: () => presetSonGuessr({ connected: true, lobbyReady: true, rooms: SONG_LOBBY_ROOMS }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /周五夜听歌会/ }));
    await screen.findByRole("dialog", { name: "输入房间密码" });
    dropFocus();
  },
};
