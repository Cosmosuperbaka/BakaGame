import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { screen, within } from "storybook/test";
import { setSoundEnabled } from "@/lib/SoundEffects";
import { dropFocus } from "@/stories/PlayHelpers";
import { STORY_PROFILE, presetAccount } from "@/stories/fixtures/Account";
import { SettingsDialog } from "./SettingsDialog";
import { SettingsEntry } from "./SettingsEntry";

const meta = {
  title: "公共组件/SettingsEntry",
  component: SettingsEntry,
  decorators: [
    (Story) => (
      <div className="flex items-center justify-end rounded-md border bg-panel p-2">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SettingsEntry>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 入口只有一枚齿轮，打开后才是完整设置面板（见下一条故事）。 */
export const Entry: Story = { name: "入口", tags: ["no-shot"] };

function OpenSettings({ agentsBlocked }: { agentsBlocked?: boolean }) {
  const [open, setOpen] = useState(true);
  return <SettingsDialog open={open} onOpenChange={setOpen} agentsBlocked={agentsBlocked} />;
}

/** 统一设置面板：MCP、外观、提示音与云同步在同一处。 */
export const DialogOpen: Story = {
  name: "设置面板",
  render: () => <OpenSettings />,
  tags: ["overlay"],
};

/** 已登录：云同步节不再有「当前未登录」的补充说明。 */
export const SignedIn: Story = {
  name: "设置面板 · 已登录",
  render: () => <OpenSettings />,
  tags: ["overlay"],
  beforeEach: () => presetAccount({ status: "signedIn", profile: STORY_PROFILE }),
};

/** 「连接信息」折叠区展开：站点连接状态、端点地址与复制按钮。 */
export const ConnectionOpen: Story = {
  name: "设置面板 · 连接信息展开",
  render: () => <OpenSettings />,
  tags: ["overlay"],
  beforeEach: () => presetAccount({ status: "guest" }),
  play: async ({ userEvent }) => {
    const dialog = within(await screen.findByRole("dialog"));
    await userEvent.click(dialog.getByRole("button", { name: "连接信息" }));
    await dialog.findByText("复制地址");
    dropFocus();
  },
};

/** 关掉提示音：音量滑块与读数一起置灰。 */
export const SoundOff: Story = {
  name: "设置面板 · 提示音关闭",
  render: () => <OpenSettings />,
  tags: ["overlay"],
  beforeEach: () => {
    const restoreAccount = presetAccount({ status: "guest" });
    setSoundEnabled(false);
    return () => {
      setSoundEnabled(true);
      restoreAccount();
    };
  },
};

/** 在房间里打开、房主没开 MCP：配对区给出限制说明。 */
export const RoomBlocked: Story = {
  name: "设置面板 · 房间未开 MCP",
  render: () => <OpenSettings agentsBlocked />,
  tags: ["overlay"],
  beforeEach: () => presetAccount({ status: "guest" }),
};
