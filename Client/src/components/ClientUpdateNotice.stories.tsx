import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { ClientUpdateBanner, type ClientUpdateFloor } from "./ClientUpdateNotice";

/** 门槛与最新版号都依赖真实服务端，这里直接渲染展示层。 */
const desktopFloor: ClientUpdateFloor = {
  clientType: "desktop",
  mode: "required",
  version: "1.2.0",
};
const mobileFloor: ClientUpdateFloor = { clientType: "mobile", mode: "required", version: "1.2.0" };
const desktopAvailable: ClientUpdateFloor = {
  clientType: "desktop",
  mode: "available",
  version: "1.2.0",
};

const meta = {
  title: "公共组件/ClientUpdateNotice",
  component: ClientUpdateBanner,
  parameters: { layout: "centered" },
  args: {
    open: true,
    floor: desktopFloor,
    downloadUrl: "https://cdn.example.com/files/BakaGame-latest-x64.exe",
    onDismiss: fn(),
  },
} satisfies Meta<typeof ClientUpdateBanner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DesktopOutdated: Story = { name: "桌面端版本过旧" };
export const DesktopNewerAvailable: Story = {
  name: "桌面端有新版本可用",
  args: { floor: desktopAvailable },
};
export const MobileOutdated: Story = {
  name: "移动端版本过旧",
  args: {
    floor: mobileFloor,
    downloadUrl: "https://cdn.example.com/files/BakaGame-latest-release.apk",
  },
};
/** 桌面壳已在后台下好并校验过新版：按钮换成「重启更新」，下载链接让位。 */
export const DesktopReadyToRestart: Story = {
  name: "桌面端新版已就绪",
  args: { floor: desktopAvailable, onRestart: fn() },
};
/** 窄宽度下正文换行，按钮与关闭钮不被挤走（手机宽度下的同一条提醒）。 */
export const DesktopReadyNarrow: Story = {
  name: "桌面端新版已就绪（窄屏）",
  args: { floor: desktopAvailable, onRestart: fn() },
  decorators: [
    (Story) => (
      <div className="w-80">
        <Story />
      </div>
    ),
  ],
};
/** 点了「重启更新」、等壳安装：按钮进入进行中，防止连点。 */
export const DesktopRestarting: Story = {
  name: "桌面端正在重启更新",
  args: { floor: desktopAvailable, onRestart: fn(), restarting: true },
};
/** 壳正在查新版或在后台下载：按钮进入进行中，下载链接让位，免得和壳自己下的那份撞车。 */
export const DesktopPreparing: Story = {
  name: "桌面端正在准备更新",
  args: { floor: desktopAvailable, preparing: true },
};
/** 点了「下载最新版」：链接交给系统浏览器下载，按钮短暂换成确认，不让点击看起来没反应。 */
export const DownloadHandedOff: Story = {
  name: "下载已转到浏览器",
  args: { floor: desktopAvailable, downloadHandedOff: true, onDownload: fn() },
};
/** 窄宽度下确认文案变长，正文换行让位，按钮与关闭钮不被挤走。 */
export const DownloadHandedOffNarrow: Story = {
  name: "下载已转到浏览器（窄屏）",
  args: { floor: desktopAvailable, downloadHandedOff: true, onDownload: fn() },
  decorators: [
    (Story) => (
      <div className="w-80">
        <Story />
      </div>
    ),
  ],
};
export const NothingToDownload: Story = {
  name: "安装包还没发布",
  args: { downloadUrl: undefined },
};
