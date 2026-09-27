import type { Meta, StoryObj } from "@storybook/react-vite";
import { Eye, Lock, Users } from "lucide-react";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./Card";

const meta = {
  title: "基础控件/Card",
  component: Card,
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Composed: Story = {
  name: "标题、正文与底部操作",
  render: () => (
    <Card className="w-[26rem]">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span className="truncate">小布丁的房间</span>
          <Lock className="h-4 w-4 shrink-0 text-muted-foreground" aria-label="需要密码" />
        </CardTitle>
        <CardDescription>
          房间号: <span className="font-mono">4821</span>
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <Badge variant="outline" className="text-xs font-normal text-muted-foreground">
          等待中
        </Badge>
        <Badge variant="outline" className="gap-1 text-xs font-normal text-muted-foreground">
          <Eye className="h-3.5 w-3.5" />
          可观战
        </Badge>
        <span className="ml-auto flex items-center gap-1.5 tabular-nums">
          <Users className="h-4 w-4 text-muted-foreground/70" />
          5 玩家 · 1 旁观
        </span>
      </CardContent>
      <CardFooter className="justify-end gap-2">
        <Button variant="outline">复制链接</Button>
        <Button>加入</Button>
      </CardFooter>
    </Card>
  ),
};

export const ContentOnly: Story = {
  name: "仅正文",
  render: () => (
    <Card className="w-[36rem]">
      <CardContent className="flex items-center justify-between gap-4 p-4 sm:px-5">
        <div className="min-w-0">
          <div className="truncate text-base font-medium">周五晚上一起猜歌</div>
          <div className="mt-1 text-sm text-muted-foreground">
            房间号: <span className="font-mono">0937</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3 text-sm text-muted-foreground">
          <Badge variant="secondary" className="border border-primary/20 bg-primary/10 text-xs font-normal text-primary">
            游戏中
          </Badge>
          <span className="flex items-center gap-1.5 tabular-nums">
            <Users className="h-4 w-4 text-muted-foreground/70" />
            6 玩家
          </span>
        </div>
      </CardContent>
    </Card>
  ),
};
