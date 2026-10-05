import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";
import { UserRound } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { SearchCombobox, SearchOptionContent, type SearchStatus } from "./SearchCombobox";

interface DemoItem {
  id: string;
  name: string;
  nameCn: string;
}

const CHARACTERS: DemoItem[] = [
  { id: "1", name: "サラマンダー・コーラル", nameCn: "撒拉曼达·卡罗尔" },
  { id: "2", name: "サターニャ弟", nameCn: "撒塔妮亚的弟弟" },
  { id: "3", name: "サターニャ母", nameCn: "撒塔妮亚的妈妈" },
  { id: "4", name: "サターニャ父", nameCn: "撒塔妮亚的爸爸" },
  { id: "5", name: "Xan", nameCn: "" },
  { id: "6", name: "胡桃沢=サタニキア=マクドウェル", nameCn: "胡桃泽·萨塔妮亚·麦克道威尔" },
];

/** 故事里的占位头像：真实组件里是角色图，这里只要尺寸对上。 */
function Avatar() {
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
      <UserRound className="size-4" aria-hidden="true" />
    </span>
  );
}

function Demo({ status = null, empty = false, banned = [] }: { status?: SearchStatus | null; empty?: boolean; banned?: string[] }) {
  const [value, setValue] = useState("撒大赛");
  const [picked, setPicked] = useState<DemoItem | null>(null);
  return (
    // 面板浮在下面这块内容之上：留出高度，截图能拍到整个面板。
    <div className="w-[34rem] max-w-full space-y-3 pb-80">
      <SearchCombobox
        value={value}
        onValueChange={setValue}
        label="搜索角色"
        placeholder="角色名、别名或编号"
        options={empty ? [] : CHARACTERS}
        getKey={(item) => item.id}
        isOptionDisabled={(item) => banned.includes(item.id)}
        renderOption={(item) => (
          <SearchOptionContent
            media={<Avatar />}
            title={item.name}
            subtitle={item.nameCn || undefined}
            trailing={banned.includes(item.id) ? "已被选择" : undefined}
          />
        )}
        onSelect={setPicked}
        listKey="demo"
        status={status}
        actions={(
          <>
            <Button type="button" className="h-10">搜角色</Button>
            <Button type="button" variant="outline" className="h-10">搜作品</Button>
          </>
        )}
      />
      <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
        {picked ? `已选择：${picked.nameCn || picked.name}` : "游戏操作区：结果面板浮在这里之上"}
      </p>
    </div>
  );
}

const meta = {
  title: "公共组件/SearchCombobox",
  component: Demo,
  tags: ["overlay"],
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("combobox", { name: "搜索角色" }));
  },
} satisfies Meta<typeof Demo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Results: Story = {
  name: "结果浮层",
};

export const Banned: Story = {
  name: "含不可选候选",
  args: { banned: ["2", "3"] },
};

export const Searching: Story = {
  name: "查询中",
  args: { empty: true, status: { tone: "busy", text: "正在查询 Bangumi" } },
};

export const Empty: Story = {
  name: "没有结果",
  args: { empty: true, status: { tone: "info", text: "没有找到符合条件的结果" } },
};

export const Failed: Story = {
  name: "查询失败",
  args: { empty: true, status: { tone: "error", text: "Bangumi 暂时无法访问，请稍后重试" } },
};

export const Collapsed: Story = {
  name: "收起",
  play: undefined,
};
