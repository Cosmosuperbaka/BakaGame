import type { SonGuessrSendCommand } from "@/lib/SonGuessrWs";
import type { SongClipRange, SongQuestionType } from "@bakagame/shared";

/**
 * 出题与取详情不设请求超时：回源取题（含歌词、音频与猜番解析）耗时由上游决定，
 * 默认超时会把一次正常的慢提交报成「提交失败」，题目其实还在后端装配。
 */
export const NO_REQUEST_TIMEOUT = { timeout: 0 } as const;

/** 聚合检索给出的备用音源与会员标记，随出题请求回传给服务端做兜底。 */
export interface SongPick {
  sources?: string[];
  requiresVip?: boolean;
}

/** 只带有值的字段：没有备用音源、不知道会员标记时不往请求里放。 */
export function songPickFields(pick?: SongPick): SongPick {
  const fields: SongPick = {};
  if (pick?.sources?.length) fields.sources = pick.sources;
  if (pick?.requiresVip !== undefined) fields.requiresVip = pick.requiresVip;
  return fields;
}

export interface SongChoice {
  questionType: SongQuestionType;
  /** submit 出题、guess 猜测 */
  mode: "submit" | "guess";
  /** 歌曲 id；猜番时是番剧 id */
  id: string;
  /** 猜番出题时选中的关联曲 */
  extraId?: string;
  clip?: SongClipRange;
  pick?: SongPick;
}

/**
 * 把一次选歌或选番变成对应命令：题型与动作决定命令名，出题时才带片段、备用音源与关联曲，
 * 并且只有出题不设请求超时。
 */
export async function sendSongChoice(send: SonGuessrSendCommand, choice: SongChoice) {
  const submit = choice.mode === "submit";
  const options = submit ? NO_REQUEST_TIMEOUT : undefined;
  if (choice.questionType === "anime") {
    await send(
      submit ? "song.game.submitAnime" : "song.game.guessAnime",
      {
        subjectId: choice.id,
        ...(submit && choice.extraId ? { songId: choice.extraId } : {}),
      },
      options
    );
    return;
  }
  await send(
    submit ? "song.game.submitSong" : "song.game.guess",
    {
      songId: choice.id,
      ...(submit && choice.clip ? { clip: choice.clip } : {}),
      ...(submit ? songPickFields(choice.pick) : {}),
    },
    options
  );
}
