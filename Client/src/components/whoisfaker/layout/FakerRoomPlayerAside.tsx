import type { ReactNode, RefObject } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { motion } from "framer-motion";
import { PLAYER_COLUMN_WIDTH } from "@/components/common/PlayerStatusPill";
import { iconTappable, spring } from "@/lib/Motion";

interface FakerRoomPlayerAsideProps {
  historyAvailable: boolean;
  historyOpen: boolean;
  onToggleHistory: () => void;
  /** 侧栏自身的 id：展开按钮用 aria-controls 指向它 */
  panelId: string;
  toggleRef: RefObject<HTMLButtonElement | null>;
  /** 宽度动画结束：收起时据此才不再带着发言列渲染 */
  onSettled: () => void;
  list: ReactNode;
}

/** 桌面玩家栏：宽度动画与发言历史展开按钮一起构成向右扩张的抽屉。 */
export function FakerRoomPlayerAside({
  historyAvailable,
  historyOpen,
  onToggleHistory,
  panelId,
  toggleRef,
  onSettled,
  list,
}: FakerRoomPlayerAsideProps) {
  return (
    <>
      {/* 布局占位：使游戏区不因玩家栏展开而收缩 */}
      <div
        className="hidden shrink-0 md:block"
        style={{ width: PLAYER_COLUMN_WIDTH }}
        aria-hidden="true"
      />

      {/* 玩家栏（桌面）。展开时向右扩张覆盖游戏区。
        宽度必须真实重排（列表要按新宽度排版），是补间布局属性的例外；
        浮起的重阴影放在伪元素上只淡入淡出，不逐帧重算阴影。 */}
      <motion.aside
        id={panelId}
        data-room-part="player"
        data-history-open={historyOpen}
        className="absolute inset-y-0 left-0 z-drawer hidden flex-col rounded-md border bg-panel shadow-2xs after:pointer-events-none after:absolute after:-inset-px after:rounded-[inherit] after:opacity-0 after:shadow-lg after:transition-opacity after:duration-(--motion-duration-base) data-[history-open=true]:after:opacity-100 md:flex"
        initial={false}
        animate={{ width: historyOpen ? "100%" : PLAYER_COLUMN_WIDTH }}
        transition={{ width: spring.settle }}
        onAnimationComplete={onSettled}
      >
        {/* 展开/收起按钮：仅在游戏开始后显示。
          收起时骑在面板右边框上；展开后面板已占满整段，按钮内收，
          否则会落到 section 的裁切区外被切掉。 */}
        {historyAvailable ? (
          <motion.div
            className="absolute -right-4 top-1/2 z-dropdown -translate-y-1/2"
            initial={false}
            animate={{ x: historyOpen ? "-1.5rem" : 0 }}
            transition={spring.settle}
          >
            <motion.button
              ref={toggleRef}
              type="button"
              aria-label={historyOpen ? "收起发言历史" : "展开发言历史"}
              aria-expanded={historyOpen}
              aria-controls={panelId}
              onClick={onToggleHistory}
              {...iconTappable}
              className="flex h-8 w-8 items-center justify-center floating-surface text-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              {/* 箭头指向面板将要移动的方向：收起时向右展开，展开时向左收回 */}
              {historyOpen ? (
                <ChevronLeft className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </motion.button>
          </motion.div>
        ) : null}

        <div className="min-h-0 min-w-0 flex-1 overflow-hidden rounded-md">{list}</div>
      </motion.aside>
    </>
  );
}
