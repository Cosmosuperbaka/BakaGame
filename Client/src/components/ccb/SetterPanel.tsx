import { useState } from "react";
import { PenLine } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { CharacterSearch } from "@/components/ccb/CharacterSearch";
import { useCCBStore } from "@/stores/UseCCBStore";
import { cn } from "@/lib/Utils";
import type { CCBCharacterSearchResult } from "@/types";

/** 长任务（提交后要开局）用无限超时，与 `GameArea` 同一口径。 */
const LONG_TASK_TIMEOUT = 0;

/** 常量空集合：`new Set()` 每次渲染都是新对象，没必要让下游跟着失效。 */
const NO_PICKED_IDS: Set<number> = new Set();

/**
 * 手动出题：出题人挑答案。
 *
 * **两步走 —— 先搜、再确认**。答案一提交就直接开局，所以必须有一次明确的确认动作
 *（原版也是让出题人「确定角色」而不是选中即出题）。
 *
 * 组件随 `answering` 阶段挂载 / 卸载，所以「已选角色」这份草稿不需要任何清理逻辑 ——
 * 这是 `react-hooks/set-state-in-effect` 那条硬约束推荐的写法（别用 effect 同步状态）。
 */
export function CCBSetterPanel({ className }: { className?: string }) {
  const sendCommand = useCCBStore((state) => state.sendCommand);
  const setNotice = useCCBStore((state) => state.setNotice);
  const [picked, setPicked] = useState<CCBCharacterSearchResult | null>(null);
  const [pending, setPending] = useState(false);

  const confirm = async () => {
    if (!picked || pending) return;
    setPending(true);
    try {
      await sendCommand(
        "ccb.game.setAnswer",
        { characterId: picked.id },
        { timeout: LONG_TASK_TIMEOUT },
      );
    } catch (error) {
      setNotice((error as { message: string }).message, "error");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className={cn("flex flex-col gap-3 rounded-md border bg-card p-3", className)}>
      <p className="text-xs text-muted-foreground">
        你是本局出题人：选好答案再确认，其他人就要来猜它。确认后本局立刻开始。
      </p>
      <CharacterSearch
        pickedIds={NO_PICKED_IDS}
        disabled={pending}
        onSelect={(character) => setPicked(character)}
      />
      {picked ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="min-w-0 truncate text-sm">
            答案：<span className="font-medium">{picked.nameCn || picked.name}</span>
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="outline" size="sm" disabled={pending} onClick={() => setPicked(null)}>
              换个角色
            </Button>
            <Button
              size="sm"
              className="gap-1.5"
              disabled={pending}
              onClick={() => void confirm()}
            >
              <PenLine className="h-3.5 w-3.5" />
              确认出题
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
