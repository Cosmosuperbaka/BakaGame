import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "@/components/ui/Button";
import {
  RANKED_IDLE_STATE,
  rankedProfile,
  rankedQueuedState,
  rankedSeries,
} from "@/stories/fixtures/CEERanked";
import { useAccountStore } from "@/stores/UseAccountStore";
import { useCEEStore } from "@/stores/UseCEEStore";
import { useCEERankedStore } from "@/stores/UseCEERankedStore";
import CEERankedPage from "./CEERankedPage";

/**
 * 排位页从排队切进系列赛的那一下（匹配成功）。页面只认壳注入的桥接与服务端推来的状态：
 * 这里装一个只表明「在客户端里」的桥接，把排位状态库的网络动作都换成空操作，按钮直接改状态，等价于服务端推来系列赛。
 */
const meta = {
  title: "页面/CEE 排位",
  component: CEERankedPage,
  tags: ["no-shot"],
  beforeEach: () => {
    window.__BAKA_CHANNEL__ = {
      clientType: "desktop",
      platform: "windows",
      clientVersion: "1.0.0",
      channelTicket: "",
      selfCheck: async () => true,
    } as never;
    useAccountStore.setState({ status: "signedIn", profile: {} as never });
    useCEEStore.setState({ connected: true, sendCommand: (async () => ({})) as never });
    useCEERankedStore.setState({
      ready: true,
      syncFailed: false,
      syncRetrying: false,
      state: rankedQueuedState(12_000),
      profile: rankedProfile("rated"),
      attach: () => () => {},
      loadProfile: async () => {},
      loadLeaderboard: async () => {},
      characterImage: async () => undefined,
    });
    return () => {
      delete window.__BAKA_CHANNEL__;
    };
  },
} satisfies Meta<typeof CEERankedPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 排位状态已就绪、空闲：排位首页。与连接中、失败两态对照，就绪后的画面以它为准。 */
export const Ready: Story = {
  name: "就绪",
  tags: ["!no-shot", "page"],
  beforeEach: () => {
    useCEERankedStore.setState({ ready: true, state: RANKED_IDLE_STATE });
  },
};

/** 排位状态还没到：骨架上写着正在连接。 */
export const Connecting: Story = {
  name: "连接中",
  tags: ["!no-shot", "page"],
  beforeEach: () => {
    useCEERankedStore.setState({
      ready: false,
      syncFailed: false,
      syncRetrying: false,
      state: null,
    });
  },
};

/** 已连接但状态请求失败：同一块位置换成说明与重试；点重试即进入在途。 */
export const SyncFailed: Story = {
  name: "连接失败",
  tags: ["!no-shot", "page"],
  beforeEach: () => {
    useCEERankedStore.setState({
      ready: false,
      syncFailed: true,
      syncRetrying: false,
      state: null,
      retryStatus: () => {
        useCEERankedStore.setState({ syncFailed: false, syncRetrying: true });
        return new Promise<void>(() => {});
      },
    });
  },
};

/** 重试在途：入口转圈、不可再点，说明留在原处。 */
export const Retrying: Story = {
  name: "重试在途",
  tags: ["!no-shot", "page"],
  beforeEach: () => {
    useCEERankedStore.setState({
      ready: false,
      syncFailed: false,
      syncRetrying: true,
      state: null,
    });
  },
};

export const MatchFound: Story = {
  name: "匹配成功",
  render: () => (
    <div className="h-screen">
      <Button
        size="sm"
        className="fixed right-4 bottom-4 z-toast"
        onClick={() =>
          useCEERankedStore.setState({
            state: { status: "series", series: rankedSeries("countdown") },
          })
        }
      >
        匹配成功
      </Button>
      <CEERankedPage />
    </div>
  ),
};
