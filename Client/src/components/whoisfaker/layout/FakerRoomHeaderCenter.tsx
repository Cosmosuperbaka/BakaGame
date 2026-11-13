import type { RefObject } from "react";
import { BookOpen, CircleHelp, Eye, ShieldCheck } from "lucide-react";
import { HeaderChip, HeaderCounter } from "@/components/common/room/RoomHeader";
import type { WhoIsFakerPrivateState } from "@bakagame/shared";

interface FakerRoomHeaderCenterProps {
  day: number;
  dayVisible: boolean;
  isQuestioner: boolean | undefined;
  isSpectator: boolean;
  globalWords: WhoIsFakerPrivateState["globalWords"];
  privateInfoVisible: boolean;
  assignedWordText: string | undefined;
  dockSize: { width: number; height: number };
  wordAnchorRef: RefObject<HTMLSpanElement | null>;
}

/** 顶栏中栏：天数、身份徽章、全局词语与停靠位占位。 */
export function FakerRoomHeaderCenter({
  day,
  dayVisible,
  isQuestioner,
  isSpectator,
  globalWords,
  privateInfoVisible,
  assignedWordText,
  dockSize,
  wordAnchorRef,
}: FakerRoomHeaderCenterProps) {
  const docked = Boolean(privateInfoVisible && assignedWordText);
  // 手机上中栏只容得下一样内容：自己的词或全局词语优先，天数（聊天里另有「第 N 天开始」）
  // 与身份徽章（主持人、旁观者本人已知）让位，不再把词语挤成一道竖条、把图标压在词下面。
  const crowded = docked || Boolean(globalWords);
  return (
    <>
      {dayVisible && day > 0 ? (
        <HeaderCounter className={crowded ? "max-sm:hidden" : undefined}>第 {day} 天</HeaderCounter>
      ) : null}
      {isQuestioner ? (
        <HeaderChip
          icon={ShieldCheck}
          label="主持人"
          className={globalWords ? "max-sm:hidden" : undefined}
        />
      ) : null}
      {!isQuestioner && isSpectator ? (
        <HeaderChip
          icon={Eye}
          label="旁观"
          muted
          className={globalWords ? "max-sm:hidden" : undefined}
        />
      ) : null}
      {/* 全局词语：只有已能看到全部身份的主持人与旁观者才会收到。放不下时截断，完整内容在 title 里 */}
      {globalWords ? (
        <HeaderChip
          icon={BookOpen}
          label={`${globalWords.civilianWord}/${globalWords.undercoverWord}`}
          title={`平民：${globalWords.civilianWord} | 卧底：${globalWords.undercoverWord}${globalWords.blankHint ? ` | 白板：${globalWords.blankHint}` : ""}`}
          truncate
        />
      ) : null}
      {globalWords?.blankHint ? (
        <HeaderChip
          icon={CircleHelp}
          label={globalWords.blankHint}
          title={`白板：${globalWords.blankHint}`}
          truncate
          // 白板提示是三枚里最次要的一枚：中栏到 xl 才放得下三枚完整徽章，更窄时只留在平民/卧底词的 title 里
          className="hidden xl:inline-flex"
        />
      ) : null}
      {/* 词语停靠位。真实词语由 FakerAssignedWord 以固定定位覆盖在此，
        此处只占位撑开顶栏空间，避免停靠时挤动相邻元素；停靠后的词语对读屏隐藏，由这里读出。 */}
      {docked ? (
        <span
          ref={wordAnchorRef}
          // 可被挤窄：中栏放不下单行时让出右侧图标，词语按这里的宽度折行（见 FakerAssignedWord）。
          className="relative min-w-0"
          style={{ width: dockSize.width, height: dockSize.height }}
        >
          <span className="sr-only">你的词语 {assignedWordText}</span>
        </span>
      ) : null}
    </>
  );
}
