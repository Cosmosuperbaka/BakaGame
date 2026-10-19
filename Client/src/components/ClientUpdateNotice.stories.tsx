import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { ClientUpdateBanner, type ClientUpdateFloor } from "./ClientUpdateNotice";

/** 门槛读回依赖真实服务端，这里直接渲染展示层。 */
const desktopFloor: ClientUpdateFloor = { clientType: "desktop", minimumVersion: "1.2.0" };
const mobileFloor: ClientUpdateFloor = { clientType: "mobile", minimumVersion: "1.2.0" };

const meta = {
  title: "公共组件/ClientUpdateNotice",
  component: ClientUpdateBanner,
  parameters: { layout: "centered" },
  args: {
    open: true,
    floor: desktopFloor,
    downloadUrl: "https://cdn.baka.website/files/BakaGame-latest-x64.exe",
    onDismiss: fn(),
  },
} satisfies Meta<typeof ClientUpdateBanner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DesktopOutdated: Story = { name: "桌面端版本过旧" };
export const MobileOutdated: Story = {
  name: "移动端版本过旧",
  args: {
    floor: mobileFloor,
    downloadUrl: "https://cdn.baka.website/files/BakaGame-latest-release.apk",
  },
};
export const NothingToDownload: Story = {
  name: "安装包还没发布",
  args: { downloadUrl: undefined },
};
