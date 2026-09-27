import type { Meta, StoryObj } from "@storybook/react-vite";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./Tabs";

const meta = {
  title: "基础控件/Tabs",
  component: Tabs,
} satisfies Meta<typeof Tabs>;

export default meta;
type Story = StoryObj<typeof meta>;

function RoomSourceTabs({ initial = "native" }: { initial?: "native" | "original" }) {
  return (
    <Tabs defaultValue={initial} className="w-[28rem]">
      <TabsList>
        <TabsTrigger value="native">增强房</TabsTrigger>
        <TabsTrigger value="original">原版房</TabsTrigger>
      </TabsList>
      <TabsContent value="native" className="mt-4 space-y-3">
        <p className="text-sm text-muted-foreground">增强房使用本项目的多人玩法与聊天功能。</p>
        <p className="rounded-md border border-dashed py-12 text-center text-sm text-muted-foreground">暂无房间</p>
      </TabsContent>
      <TabsContent value="original" className="mt-4 space-y-3">
        <p className="text-sm text-muted-foreground">与原版玩家一起游玩，聊天仅增强版玩家可见。</p>
        <p role="status" className="rounded-md border p-4 text-sm">
          原版服务器暂未接入，请使用增强房。
        </p>
      </TabsContent>
    </Tabs>
  );
}

export const FirstTab: Story = {
  name: "默认标签",
  render: () => <RoomSourceTabs />,
};

export const SecondTab: Story = {
  name: "第二个标签",
  render: () => <RoomSourceTabs initial="original" />,
};
