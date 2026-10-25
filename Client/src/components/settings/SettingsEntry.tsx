import { useState, type MouseEvent } from "react";
import { Settings } from "lucide-react";
import { Button } from "@/components/ui/Button";
import type { McpGameId } from "@/lib/McpConfig";
import type { OriginPoint } from "@/lib/Motion";
import { SettingsDialog } from "./SettingsDialog";

const originOf = (event: MouseEvent<HTMLElement>): OriginPoint => {
  const rect = event.currentTarget.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
};

/**
 * 首页、三个大厅与房间顶栏共用的设置入口：齿轮按钮打开同一份设置面板。
 * 传入 `game` 表示当前在对应游戏的房间里，MCP 分区只显示连接信息。
 */
export function SettingsEntry({ game }: { game?: McpGameId }) {
  const [open, setOpen] = useState(false);
  const [origin, setOrigin] = useState<OriginPoint | null>(null);

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="设置"
        onClick={(event) => {
          setOrigin(originOf(event));
          setOpen(true);
        }}
      >
        <Settings aria-hidden="true" />
      </Button>
      <SettingsDialog open={open} onOpenChange={setOpen} origin={origin} game={game} />
    </>
  );
}
