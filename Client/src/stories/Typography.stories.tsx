import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";

function TypographySpecimen() {
  const [density, setDensity] = useState<"comfortable" | "compact">("comfortable");
  return (
    <div className="min-h-dvh bg-background px-6 py-10 text-foreground md:px-10">
      <div className="mx-auto max-w-3xl space-y-10">
        <header>
          <p className="font-mono text-2xs tracking-widest text-muted-foreground">
            FOUNDATIONS / TYPE
          </p>
          <h1 className="mt-2 text-3xl font-semibold sm:text-4xl">字体角色</h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            正文、说明与表单使用楷体；标题、强调与操作标签使用衬线体；房间号、哈希与时间戳使用等宽体。
          </p>
        </header>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">正文与说明</h2>
          <p className="text-sm leading-6">
            这是一段普通正文，用来检查长句的阅读节奏与字距。段落里的
            <strong>关键结论</strong>
            会切回衬线体，和周围的楷体形成层级；正文本身保持楷体的书写感，不靠加粗承担全部信息。
          </p>
          <p className="text-sm leading-6 text-muted-foreground">
            说明文字、表单帮助与聊天内容都走同一层。遇到生僻字时回落到衬线体，不会掉到系统无衬线体。
          </p>
          <p className="text-lg leading-8">
            夜空に浮かぶ星たち、静寂を切り裂いていく。浮现在夜空中的群星点点，将这无尽的寂静一点点撕裂开来。
          </p>
        </section>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              小布丁的房间
              <Badge variant="subtle">等待中</Badge>
            </CardTitle>
            <CardDescription>
              房间号 <span className="font-mono">4821</span> · 创建于 21:40
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm leading-6 text-muted-foreground">
            <p>卡片标题用衬线体，描述与正文用楷体；操作按钮在底部保持衬线标签。</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm">加入房间</Button>
              <Button size="sm" variant="outline">
                复制链接
              </Button>
              <Button size="sm" variant="ghost">
                返回大厅
              </Button>
            </div>
          </CardContent>
        </Card>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">控件与表单</h2>
          <div className="flex flex-wrap items-center gap-3">
            <Button>开始游戏</Button>
            <Button variant="secondary">取消准备</Button>
            <Button variant="outline">查看规则</Button>
            <Button variant="link">更新日志</Button>
          </div>
          <SegmentedControl
            aria-label="信息密度"
            value={density}
            onValueChange={setDensity}
            options={[
              { value: "comfortable", label: "舒适" },
              { value: "compact", label: "紧凑" },
            ]}
          />
          <div className="grid gap-2">
            <Label htmlFor="typography-nickname">昵称</Label>
            <Input id="typography-nickname" defaultValue="小布丁" />
            <p className="text-xs text-muted-foreground">这个输入框和帮助文字使用楷体。</p>
          </div>
          <Tabs defaultValue="body">
            <TabsList>
              <TabsTrigger value="body">正文</TabsTrigger>
              <TabsTrigger value="data">数据</TabsTrigger>
            </TabsList>
            <TabsContent value="body" className="pt-4">
              <p className="text-sm leading-6 text-muted-foreground">
                标签页的标签在控件层使用衬线体，内容回到楷体正文。
              </p>
            </TabsContent>
            <TabsContent value="data" className="pt-4">
              <p className="font-mono text-sm text-muted-foreground">
                room=4821 · v1.9.5 · d5cbfc43
              </p>
            </TabsContent>
          </Tabs>
        </section>

        <section className="space-y-2">
          <h2 className="text-xl font-semibold">数据</h2>
          <p className="font-mono text-sm text-muted-foreground">
            房间号 4821 · QQ 12345678 · v1.9.5 · d5cbfc43 · 2026-10-25 21:40
          </p>
          <p className="text-sm leading-6">
            数据保持等宽体，正文里的时间与编号不会跟着楷体的书写节奏摆动。
          </p>
        </section>
      </div>
    </div>
  );
}

const meta = {
  title: "基础规则/字体角色",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Roles: Story = {
  name: "楷体正文与衬线标题",
  render: () => <TypographySpecimen />,
};
