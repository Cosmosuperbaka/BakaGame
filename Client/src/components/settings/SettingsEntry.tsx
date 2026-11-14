import { useState } from "react";
import { Settings } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useOriginTracker } from "@/hooks/UseOriginTracker";
import { SettingsDialog } from "./SettingsDialog";

/**
 * 首页、三个大厅与房间顶栏共用的设置入口：齿轮按钮打开同一份设置面板。
 * `agentsBlocked` 由房间顶栏按房主的 MCP 开关算出，面板自己不认识任何游戏的房间状态。
 */
export function SettingsEntry({ agentsBlocked }: { agentsBlocked?: boolean }) {
  const [open, setOpen] = useState(false);
  const { origin, capture } = useOriginTracker();

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="设置"
        onClick={(event) => {
          capture(event);
          setOpen(true);
        }}
      >
        <Settings aria-hidden="true" />
      </Button>
      <SettingsDialog
        open={open}
        onOpenChange={setOpen}
        origin={origin}
        agentsBlocked={agentsBlocked}
      />
    </>
  );
}
