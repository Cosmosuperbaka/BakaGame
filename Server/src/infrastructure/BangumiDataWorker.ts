import { AppError } from "../domain/Errors";
import { CCBCharacterRepository } from "./CCBCharacterRepository";
import { LocalBangumiProvider } from "./LocalBangumiProvider";
import { scheduleDatasetBackup } from "./DatasetBackup";
import type { AnimeAutoFilters } from "../shared/Index";
import type { BangumiProviderInit } from "./LocalBangumiProvider";
import type { CCBDataInit } from "./CCBData";
import type { CCBImageSize, CCBSettings } from "../shared/CCB";

/**
 * 猜歌与 CCB 共用的唯一数据 Worker。
 *
 * 两个玩法此前各起一个 Worker（`BangumiWorker` / `CCBCharacterWorker`），各自打开
 * SQLite 与 Meilisearch。数据集改为**可写**之后，两个进程同时写同一个库文件会出现
 * 写写冲突；合到这里之后写操作天然串行，不需要跨 Worker 的锁或队列。
 *
 * 方法按 `song.` / `ccb.` 前缀分派：两边的 `searchSubjects` 语义不同（猜歌带
 * 年份/评分过滤、CCB 带作品类型），合名会撞车，所以保留命名空间。
 */
export type BangumiDataRequest =
  | { id: number; method: "init"; song: BangumiProviderInit; ccb: CCBDataInit }
  // ---- 猜歌 ----
  | { id: number; method: "song.searchSubjects"; keyword: string; limit?: number; filters?: AnimeAutoFilters }
  | { id: number; method: "song.getSubject"; subjectId: string }
  | { id: number; method: "song.resolveCharacterImage"; characterId: number }
  | { id: number; method: "song.resolveSubjectImage"; subjectId: string }
  // ---- CCB ----
  | { id: number; method: "ccb.searchCharacters"; keyword: string; limit: number }
  | { id: number; method: "ccb.searchSubjects"; keyword: string; limit: number; types?: number[] }
  | { id: number; method: "ccb.getSubjectCharacters"; subjectId: number; limit: number }
  | { id: number; method: "ccb.getSubjects"; subjectIds: number[] }
  | { id: number; method: "ccb.getRawCharacter"; characterId: number }
  | { id: number; method: "ccb.getCharacter"; characterId: number; settings: CCBSettings }
  | { id: number; method: "ccb.chooseRandomCharacter"; settings: CCBSettings; rolls: number[] }
  | { id: number; method: "ccb.importDirectory"; indexId: number }
  | { id: number; method: "ccb.resolveCharacterImage"; characterId: number; size?: CCBImageSize }
  | { id: number; method: "ccb.resolveSubjectImage"; subjectId: number; size?: CCBImageSize }
  | { id: number; method: "close" };

export type BangumiDataReply = { id: number } & ({ ok: true; value: unknown } | { ok: false; code: string; message: string });

/** 一个 Worker 进程里同时持有两条数据链路；各自的初始化失败互不影响。 */
let song: LocalBangumiProvider | undefined;
let ccb: CCBCharacterRepository | undefined;
let songError: AppError | undefined;
let ccbError: AppError | undefined;
/** 备份定时器的停止函数；两条链路读的是同一个库，只起一份备份。 */
let stopBackup: (() => void) | undefined;

/**
 * 两条链路共用一次 init，但**分别容错**：猜歌的库缺失不该让 CCB 一起不可用
 * （反之亦然）。失败只记在该侧，查询时再抛出来。
 */
const requireSong = () => {
  if (songError) throw songError;
  if (!song) throw new AppError("BANGUMI_DATA_UNAVAILABLE", "本地 Bangumi 数据尚未就绪");
  return song;
};
const requireCcb = () => {
  if (ccbError) throw ccbError;
  if (!ccb) throw new AppError("CCB_DATA_UNAVAILABLE", "本地角色数据尚未就绪");
  return ccb;
};

const asAppError = (error: unknown, code: string) => error instanceof AppError
  ? error
  : new AppError(code, error instanceof Error ? error.message : "本地数据初始化失败");

self.onmessage = async ({ data: request }: MessageEvent<BangumiDataRequest>) => {
  try {
    let value: unknown;
    if (request.method === "init") {
      // 两边各自建索引，串行初始化：同一进程内共用一个 Meilisearch 客户端即可，
      // 但索引写入仍由各自适配器排队，并发只会让两边互相拖慢。
      try {
        song = new LocalBangumiProvider(request.song);
        await song.initialize();
      } catch (error) {
        song = undefined;
        songError = asAppError(error, "BANGUMI_DATA_UNAVAILABLE");
      }
      try {
        ccb = new CCBCharacterRepository(request.ccb);
        await ccb.initialize();
      } catch (error) {
        ccb = undefined;
        ccbError = asAppError(error, "CCB_DATA_UNAVAILABLE");
      }
      // 库现在可写、且要由后端自己更新：没有快照就没有退路。启动先备一份，之后每天 04:00 覆盖。
      stopBackup = scheduleDatasetBackup({
        dbPath: request.song.dbPath,
        backupPath: `${request.song.dbPath}.backup`,
        logger: { warn: (message) => console.warn(message) },
      });
      value = true;
    } else if (request.method === "close") {
      stopBackup?.();
      stopBackup = undefined;
      await Promise.allSettled([ccb?.close(), song?.close()]);
      song = undefined;
      ccb = undefined;
      songError = undefined;
      ccbError = undefined;
      value = true;
    } else if (request.method.startsWith("song.")) {
      const provider = requireSong();
      switch (request.method) {
        case "song.searchSubjects": value = await provider.searchSubjects(request.keyword, request.limit, request.filters); break;
        case "song.getSubject": value = await provider.getSubject(request.subjectId); break;
        case "song.resolveCharacterImage": value = await provider.resolveCharacterImage(request.characterId); break;
        case "song.resolveSubjectImage": value = await provider.resolveSubjectImage(request.subjectId); break;
      }
    } else {
      const repository = requireCcb();
      switch (request.method) {
        case "ccb.searchCharacters": value = await repository.searchCharacters(request.keyword, request.limit); break;
        case "ccb.searchSubjects": value = await repository.searchSubjects(request.keyword, request.limit, request.types); break;
        case "ccb.getSubjectCharacters": value = await repository.getSubjectCharacters(request.subjectId, request.limit); break;
        case "ccb.getSubjects": value = await repository.getSubjects(request.subjectIds); break;
        case "ccb.getRawCharacter": value = await repository.getRawCharacter(request.characterId); break;
        case "ccb.getCharacter": value = await repository.getCharacter(request.characterId, request.settings); break;
        case "ccb.chooseRandomCharacter": {
          let cursor = 0;
          value = await repository.chooseRandomCharacter(request.settings, () => {
            const roll = request.rolls[cursor++];
            if (roll === undefined) throw new AppError("CCB_DATA_INVALID", "随机采样参数不完整");
            return roll;
          });
          break;
        }
        case "ccb.importDirectory": value = await repository.importDirectory(request.indexId); break;
        case "ccb.resolveCharacterImage": value = await repository.resolveCharacterImage(request.characterId, request.size); break;
        case "ccb.resolveSubjectImage": value = await repository.resolveSubjectImage(request.subjectId, request.size); break;
      }
    }
    self.postMessage({ id: request.id, ok: true, value } satisfies BangumiDataReply);
  } catch (error) {
    // 只对**非业务错误**打日志：`CCB_CHARACTER_NOT_FOUND` 这类是正常返回路径，
    // 打出来会污染排障日志（线上要看的是程序异常，不是用户搜了个不存在的角色）。
    if (!(error instanceof AppError)) console.error("Bangumi data worker query failed", error);
    self.postMessage({ id: request.id, ok: false,
      code: error instanceof AppError ? error.code : "CCB_DATA_UNAVAILABLE",
      message: error instanceof AppError ? error.message : "本地 Bangumi 数据读取失败",
    } satisfies BangumiDataReply);
  }
};
