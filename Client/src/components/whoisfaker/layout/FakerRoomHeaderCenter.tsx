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
  return (
    <>
      {dayVisible && day > 0 ? <HeaderCounter>第 {day} 天</HeaderCounter> : null}
      {/* 中栏在手机上只有一百六十多像素：主持人徽章在 sm 以下只留图标，身份名交给读屏 */}
      {isQuestioner ? (
        <>
          <HeaderChip icon={ShieldCheck} label="主持人" className="hidden sm:inline-flex" />
          <HeaderChip icon={ShieldCheck} label="" title="主持人" className="px-1.5 sm:hidden" />
          <span className="sr-only sm:hidden">主持人</span>
        </>
      ) : null}
      {!isQuestioner && isSpectator ? <HeaderChip icon={Eye} label="旁观" muted /> : null}
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
      {privateInfoVisible && assignedWordText ? (
        <span
          ref={wordAnchorRef}
          className="relative shrink-0"
          style={{ width: dockSize.width, height: dockSize.height }}
        >
          <span className="sr-only">你的词语 {assignedWordText}</span>
        </span>
      ) : null}
    </>
  );
}
