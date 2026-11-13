import type { CEEPhase, RecordedGameKind, SonGuessrPhase } from "@bakagame/shared";
import { PHASE_LABELS as FAKER_PHASE_LABELS } from "@/config/WhoIsFakerPresentation";

/**
 * 管理端房间卡的阶段名。卧底复用客户端已有的阶段文案；猜歌与 CEE 客户端没有按阶段枚举的文案表
 * （房间里的标题随画面内容变化），这里按各阶段在玩家眼里的含义写一份简短名称。
 * 用 Record 钉住枚举：服务端新增阶段时这里编译不过，不会静默漏译。
 */
const SONG_PHASE_LABELS: Record<SonGuessrPhase, string> = {
  waiting: "等待开始",
  choosingSubmitter: "指定出题人",
  submittingSong: "选择本局题目",
  playing: "听歌作答",
  roundResult: "答案揭晓",
};

const CEE_PHASE_LABELS: Record<CEEPhase, string> = {
  waiting: "等待开始",
  choosingSetter: "指定出题人",
  preparing: "正在准备题目",
  answering: "选择本局答案",
  guessing: "猜猜是哪位角色",
  settled: "答案揭晓",
};

const LABELS: Record<RecordedGameKind, Record<string, string>> = {
  faker: FAKER_PHASE_LABELS,
  song: SONG_PHASE_LABELS,
  cee: CEE_PHASE_LABELS,
};

/** 房间阶段的中文名；接口把阶段当字符串下发，没登记的阶段原样显示。 */
export const roomPhaseLabel = (game: RecordedGameKind, phase: string): string =>
  LABELS[game][phase] ?? phase;
