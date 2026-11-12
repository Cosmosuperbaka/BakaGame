import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";
import type { CEESettings } from "@bakagame/shared";
import { SettingsStack } from "@/components/common/room/SettingsAccordion";
import { presetCEE } from "@/stories/StorePresets";
import { CEE_CUSTOM_SETTINGS, ceeSettings } from "@/stories/fixtures/CEE";
import { useCEEStore } from "@/stores/UseCEEStore";
import { CEEGameSettings } from "./CEEGameSettings";

/** 追加作品按编号补名字：替换 `cee.subject.lookup` 的应答，其余命令照常（故事里不会发出）。 */
const SUBJECT_NAMES: Record<number, string> = { 328609: "孤独摇滚！", 1424: "轻音少女" };
function stubSubjectLookup() {
  const sendCommand = useCEEStore.getState().sendCommand;
  useCEEStore.setState({
    sendCommand: ((command, payload) =>
      command === "cee.subject.lookup"
        ? Promise.resolve({
            results: (payload as { subjectIds: number[] }).subjectIds.map((id) => ({
              id,
              name: SUBJECT_NAMES[id] ?? `#${id}`,
              nameCn: SUBJECT_NAMES[id] ?? "",
              type: 2,
              year: null,
              rating: 0,
              heat: 0,
            })),
          })
        : sendCommand(command, payload)) as typeof sendCommand,
  });
}

/** 依次展开所有折叠组。页面故事只截视口，长面板的上半段只能在这里整块看到。 */
async function openAll({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  for (const name of [/反作弊/, /题目设置/, /猜测设置/]) {
    const button = canvas.queryByRole("button", { name });
    if (button) await userEvent.click(button);
  }
  (document.activeElement as HTMLElement | null)?.blur();
}

/** 等待页里的玩法设置：房主可改、其他人只读，收起时各组只显示摘要。 */
const meta = {
  title: "CEE/CEEGameSettings",
  component: CEEGameSettings,
  args: {
    settings: CEE_CUSTOM_SETTINGS,
    source: "native",
    waiting: true,
    readOnly: false,
  },
  beforeEach: () => {
    presetCEE({ connected: true });
    stubSubjectLookup();
  },
  decorators: [
    (Story) => (
      <div className="mx-auto w-[28rem] max-w-full">
        <SettingsStack>
          <Story />
        </SettingsStack>
      </div>
    ),
  ],
} satisfies Meta<typeof CEEGameSettings>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Collapsed: Story = { name: "收起 · 摘要" };

export const HostOpen: Story = { name: "房主 · 全部展开", play: openAll };

export const GuestReadOnly: Story = {
  name: "玩家 · 只读展开",
  args: { readOnly: true },
  play: openAll,
};

/** 目录出题：年份与热度禁用，目录编号带同步按钮。 */
const directorySettings: CEESettings = ceeSettings({ useIndex: true, indexId: 12345 });
export const HostDirectory: Story = {
  name: "房主 · 使用目录",
  args: { settings: directorySettings },
  play: openAll,
};

export const AntiCheat: Story = {
  name: "反作弊房 · 展开",
  args: { settings: ceeSettings({ bakaAntiCheat: true }), readOnly: true },
  play: openAll,
};
