import type { Meta, StoryObj } from "@storybook/react-vite";
import { screen, within } from "storybook/test";
import { dropFocus } from "@/stories/PlayHelpers";
import {
  STORY_ANDROID_PACKAGE,
  STORY_MACOS_PACKAGE,
  STORY_WINDOWS_PACKAGE,
  stubClientPackages,
} from "@/stories/fixtures/ClientPackages";
import { ClientDownloadDialog } from "./ClientDownloadEntry";

/**
 * 首页「下载客户端」弹窗。发布信息由故事桩住；默认档按设备猜，截图浏览器不是 Mac，停在 Windows。
 * macOS 这一档只在清单里有它时才出现，两种情形各拍一张。
 */
const meta = {
  title: "公共组件/ClientDownloadDialog",
  component: ClientDownloadDialog,
  tags: ["overlay"],
  args: { open: true, onOpenChange: () => {} },
} satisfies Meta<typeof ClientDownloadDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 等发布信息落进弹窗再拍：骨架行换成真实的架构与大小。 */
const settled = async (text: string) => {
  await within(await screen.findByRole("dialog")).findByText(text);
};

/** Mac 包正式分发前的线上形态：只有 Windows 与 Android 两档。 */
export const WithoutMacos: Story = {
  name: "macOS 未发布",
  beforeEach: () => stubClientPackages([STORY_WINDOWS_PACKAGE, STORY_ANDROID_PACKAGE]),
  play: () => settled("x64"),
};

/** 清单里有 macOS：三档按 Windows、macOS、Android 排。 */
export const WithMacos: Story = {
  name: "含 macOS",
  beforeEach: () =>
    stubClientPackages([STORY_WINDOWS_PACKAGE, STORY_MACOS_PACKAGE, STORY_ANDROID_PACKAGE]),
  play: () => settled("x64"),
};

/** 选中 macOS 档：架构标两种芯片通用，下载按钮给 Mac 的包。 */
export const MacosSelected: Story = {
  name: "选中 macOS",
  beforeEach: () =>
    stubClientPackages([STORY_WINDOWS_PACKAGE, STORY_MACOS_PACKAGE, STORY_ANDROID_PACKAGE]),
  play: async ({ userEvent }) => {
    const dialog = within(await screen.findByRole("dialog"));
    await userEvent.click(await dialog.findByRole("radio", { name: "macOS" }));
    await dialog.findByText("Intel 与 Apple 芯片");
    dropFocus();
  },
};

/** 服务端读不到发布信息：置灰并给重试。 */
export const Failed: Story = {
  name: "读不到发布信息",
  beforeEach: () => stubClientPackages("error"),
  play: () => settled("暂时读不到发布信息。"),
};
