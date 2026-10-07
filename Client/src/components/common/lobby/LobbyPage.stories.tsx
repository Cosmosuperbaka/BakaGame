import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { LobbyPage } from "./LobbyPage";
import type { LobbyRoomView } from "./RoomListCard";

const ROOMS: LobbyRoomView[] = [
  { roomId: "4821", name: "周五晚上的卧底局", hasPassword: false, inGame: false, allowSpectators: true, playerCount: 6, spectatorCount: 1 },
  { roomId: "3141", name: "深夜卧底局", hasPassword: true, inGame: true, allowSpectators: false, playerCount: 8, spectatorCount: 0 },
  { roomId: "2718", name: "原版服务器上的房间", hasPassword: false, inGame: false, allowSpectators: true, playerCount: 3, spectatorCount: null, tag: "原版" },
];

const meta = {
  title: "公共组件/LobbyPage",
  component: LobbyPage,
  tags: ["page"],
  parameters: { layout: "fullscreen" },
  args: {
    path: "/whoisfaker",
    title: "Who is",
    logo: { src: "/assets/Faker.png", alt: "Faker" },
    titleLabel: "Who is Faker",
    rooms: ROOMS,
    loading: false,
    userName: "小明",
    onUserNameChange: fn(),
    onCreate: fn(),
    onSelectRoom: fn(),
  },
} satisfies Meta<typeof LobbyPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 正在进入第二间房：转圈挂在那张卡片的房名行末，其余卡片变淡，列表不被推动。 */
export const Entering: Story = { name: "进房中", args: { disabled: true, pendingRoomId: "3141" } };
