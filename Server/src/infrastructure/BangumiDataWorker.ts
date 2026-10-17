import { AppError } from "../domain/Errors";
import { CEECharacterRepository } from "./CEECharacterRepository";
import { LocalBangumiProvider } from "./LocalBangumiProvider";
import { scheduleDatasetBackup } from "./DatasetBackup";
import { scheduleTagDiffSync, syncTagDiff } from "./TagDiffSync";
import { BangumiImageStore } from "./BangumiImageStore";
import { BangumiSearchIndex } from "./BangumiSearchIndex";
import { openDataset } from "./OpenDataset";
import { SubjectUpdater, type SubjectUpdaterInit } from "./SubjectUpdater";
import type { AnimeAutoFilters } from "../shared/Index";
import type { BangumiProviderInit } from "./LocalBangumiProvider";
import type { CEEDataInit } from "./CEEData";
import type { CEEImageSize, CEESettings } from "../shared/CEE";

/**
 * 猜歌与 CEE 共用的唯一数据 Worker。
 *
 * 两个玩法此前各起一个 Worker（`BangumiWorker` / `CEECharacterWorker`），各自打开
 * SQLite 与 Meilisearch。数据集改为**可写**之后，两个进程同时写同一个库文件会出现
 * 写写冲突；合到这里之后写操作天然串行，不需要跨 Worker 的锁或队列。
 *
 * 方法按 `song.` / `cee.` 前缀分派：两边的 `searchSubjects` 语义不同（猜歌带
 * 年份/评分过滤、CEE 带作品类型），合名会撞车，所以保留命名空间。
 */
export type BangumiDataRequest =
  | { id: number; method: "init"; song: BangumiProviderInit; cee: CEEDataInit; tagDiff?: TagDiffOptions; imagesDir?: string; updater?: SubjectUpdaterInit }
  // ---- 猜歌 ----
  | { id: number; method: "song.searchSubjects"; keyword: string; limit?: number; filters?: AnimeAutoFilters }
  | { id: number; method: "song.getSubject"; subjectId: string }
  | { id: number; method: "song.resolveCharacterImage"; characterId: number }
  | { id: number; method: "song.resolveSubjectImage"; subjectId: string }
  // ---- CEE ----
  | { id: number; method: "cee.searchCharacters"; keyword: string; limit: number }
  | { id: number; method: "cee.searchSubjects"; keyword: string; limit: number; types?: number[] }
  | { id: number; method: "cee.getSubjectCharacters"; subjectId: number; limit: number }
  | { id: number; method: "cee.getSubjects"; subjectIds: number[] }
  | { id: number; method: "cee.getRawCharacter"; characterId: number }
  | { id: number; method: "cee.getCharacter"; characterId: number; settings: CEESettings }
  | { id: number; method: "cee.chooseRandomCharacter"; settings: CEESettings; rolls: number[] }
  | { id: number; method: "cee.importDirectory"; indexId: number }
  | { id: number; method: "cee.resolveCharacterImage"; characterId: number; size?: CEEImageSize }
  | { id: number; method: "cee.resolveSubjectImage"; subjectId: number; size?: CEEImageSize }
  /** 拉取并应用上游的角色标签增量（CCB-TagsCI 产出）。 */
  | { id: number; method: "cee.syncTagDiff" }
  /** 图床落库（单写者）：主线程路由抓到的新图经这里写入分片。 */
  | { id: number; method: "images.put"; path: string; bytes: Uint8Array }
  // ---- 运行时更新器（阶段 6）----
  /** 上报在线玩家数：更新器据此在 10~100 req/s 之间调整上游速率。 */
  | { id: number; method: "updater.reportLoad"; players: number }
  /** 玩家点开过的条目：过期就异步回源更新一次。 */
  | { id: number; method: "updater.refreshSubject"; subjectId: number }
  /** 运维快照：排障时看更新器是否在跑、跑多快。 */
  | { id: number; method: "updater.stats" }
  | { id: number; method: "close" };

export type BangumiDataReply = { id: number } & ({ ok: true; value: unknown } | { ok: false; code: string; message: string });

/** 角色标签增量的来源与已应用版本的记录位置。 */
export interface TagDiffOptions {
  diffUrl: string;
  statePath: string;
}

/** 一个 Worker 进程里同时持有两条数据链路；各自的初始化失败互不影响。 */
let song: LocalBangumiProvider | undefined;
let cee: CEECharacterRepository | undefined;
let songError: AppError | undefined;
let ceeError: AppError | undefined;
/** 备份定时器的停止函数；两条链路读的是同一个库，只起一份备份。 */
let stopBackup: (() => void) | undefined;
/** 标签增量定时的停止函数。 */
let stopTagDiff: (() => void) | undefined;
let tagDiff: TagDiffOptions | undefined;
let images: BangumiImageStore | undefined;
let updater: SubjectUpdater | undefined;

/**
 * 两条链路共用一次 init，但**分别容错**：猜歌的库缺失不该让 CEE 一起不可用
 * （反之亦然）。失败只记在该侧，查询时再抛出来。
 */
const requireSong = () => {
  if (songError) throw songError;
  if (!song) throw new AppError("BANGUMI_DATA_UNAVAILABLE", "本地 Bangumi 数据尚未就绪");
  return song;
};
const requireCee = () => {
  if (ceeError) throw ceeError;
  if (!cee) throw new AppError("CEE_DATA_UNAVAILABLE", "本地角色数据尚未就绪");
  return cee;
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
      // 玩家点开的条目登记到更新器：闭包引用，更新器晚一步创建也没关系。
      try {
        song = new LocalBangumiProvider({ ...request.song, onSubjectView: (id) => updater?.requestRefresh(id) });
        await song.initialize();
      } catch (error) {
        song = undefined;
        songError = asAppError(error, "BANGUMI_DATA_UNAVAILABLE");
      }
      try {
        cee = new CEECharacterRepository(request.cee);
        await cee.initialize();
      } catch (error) {
        cee = undefined;
        ceeError = asAppError(error, "CEE_DATA_UNAVAILABLE");
      }
      // 库现在可写、且要由后端自己更新：没有快照就没有退路。启动先备一份，之后每天 04:00 覆盖。
      tagDiff = request.tagDiff;
      images = request.imagesDir ? BangumiImageStore.open(request.imagesDir) : undefined;
      // 更新器自己开一条数据集连接：它与查询侧同处本线程，写操作天然串行，
      // 不必（也不该）去扒 provider 内部的句柄。
      // 起不来只记警告：数据集缺失时查询链路已经各自报错了，更新器不该再把它
      // 放大成 init 整体失败（那会让所有查询永久拿不到数据）。
      try {
        updater = request.updater
          ? new SubjectUpdater({
              db: openDataset(request.song.dbPath),
              // 没配搜索就不建索引适配器：否则待同步队列会一直攒着却永远没人消费。
              search: request.song.meilisearch?.apiKey
                ? new BangumiSearchIndex({ apiKey: request.song.meilisearch.apiKey })
                : undefined,
              images, logger: { warn: (message) => console.warn(message), info: (message) => console.log(message) },
              ...request.updater,
            })
          : undefined;
        updater?.markDatasetFresh();
        updater?.start();
      } catch (error) {
        console.warn(`运行时更新器未启动：${error instanceof Error ? error.message : String(error)}`);
        updater = undefined;
      }
      stopBackup = scheduleDatasetBackup({
        dbPath: request.song.dbPath,
        backupPath: `${request.song.dbPath}.backup`,
        logger: { warn: (message) => console.warn(message) },
        // 备份期间停更新器：VACUUM INTO 出一致快照，别让写入拖长它。
        onBackup: { pause: () => updater?.pause(), resume: () => updater?.resume() },
        // 每日维护：补上两份 dump 之间新出的作品与角色。没有这一步，搜索永远搜不到新番。
        onDailyTask: async () => {
          const base = (request.song.apiBase ?? "").trim();
          if (!base) return;   // 未配置上游地址时静默跳过（本地开发常见）。
          const result = await requireCee().discoverNewSubjects(base);
          console.log(`新条目发现：窗口自 ${result.window}，候选 ${result.candidates}，`
            + `入库 ${result.added}，跳过 ${result.skipped}，失败 ${result.failed}`);
        },
      });
      // 角色标签增量（CCB-TagsCI 产出）：定时拉取，不依赖任何外部触发。
      stopTagDiff = tagDiff
        ? scheduleTagDiffSync({
            repository: () => requireCee(), diffUrl: tagDiff!.diffUrl, statePath: tagDiff!.statePath,
            logger: { warn: (message) => console.warn(message), info: (message) => console.log(message) },
          })
        : undefined;
      value = true;
    } else if (request.method === "close") {
      updater?.stop();
      updater = undefined;
      stopTagDiff?.();
      stopTagDiff = undefined;
      stopBackup?.();
      stopBackup = undefined;
      await Promise.allSettled([cee?.close(), song?.close()]);
      images?.close();
      images = undefined;
      song = undefined;
      cee = undefined;
      songError = undefined;
      ceeError = undefined;
      value = true;
    } else if (request.method === "images.put") {
      if (!images) throw new AppError("BANGUMI_DATA_UNAVAILABLE", "图床未就绪");
      images.put(request.path, request.bytes);
      value = true;
    } else if (request.method === "updater.reportLoad") {
      updater?.reportLoad(request.players);
      value = true;
    } else if (request.method === "updater.stats") {
      value = updater?.stats() ?? { running: false };
    } else if (request.method === "updater.refreshSubject") {
      value = updater ? await updater.refresh(request.subjectId) : false;
    } else if (request.method.startsWith("song.")) {
      const provider = requireSong();
      switch (request.method) {
        case "song.searchSubjects": value = await provider.searchSubjects(request.keyword, request.limit, request.filters); break;
        case "song.getSubject": value = await provider.getSubject(request.subjectId); break;
        case "song.resolveCharacterImage": value = await provider.resolveCharacterImage(request.characterId); break;
        case "song.resolveSubjectImage": value = await provider.resolveSubjectImage(request.subjectId); break;
      }
    } else {
      const repository = requireCee();
      switch (request.method) {
        case "cee.searchCharacters": value = await repository.searchCharacters(request.keyword, request.limit); break;
        case "cee.searchSubjects": value = await repository.searchSubjects(request.keyword, request.limit, request.types); break;
        case "cee.getSubjectCharacters": value = await repository.getSubjectCharacters(request.subjectId, request.limit); break;
        case "cee.getSubjects": value = await repository.getSubjects(request.subjectIds); break;
        case "cee.getRawCharacter": value = await repository.getRawCharacter(request.characterId); break;
        case "cee.getCharacter": value = await repository.getCharacter(request.characterId, request.settings); break;
        case "cee.chooseRandomCharacter": {
          let cursor = 0;
          value = await repository.chooseRandomCharacter(request.settings, () => {
            const roll = request.rolls[cursor++];
            if (roll === undefined) throw new AppError("CEE_DATA_INVALID", "随机采样参数不完整");
            return roll;
          });
          break;
        }
        case "cee.importDirectory": value = await repository.importDirectory(request.indexId); break;
        case "cee.resolveCharacterImage": value = await repository.resolveCharacterImage(request.characterId, request.size); break;
        case "cee.resolveSubjectImage": value = await repository.resolveSubjectImage(request.subjectId, request.size); break;
        case "cee.syncTagDiff": {
          if (!tagDiff) throw new AppError("CEE_DATA_UNAVAILABLE", "标签增量未配置");
          value = await syncTagDiff({ repository, diffUrl: tagDiff.diffUrl, statePath: tagDiff.statePath });
          break;
        }
      }
    }
    self.postMessage({ id: request.id, ok: true, value } satisfies BangumiDataReply);
  } catch (error) {
    // 只对**非业务错误**打日志：`CEE_CHARACTER_NOT_FOUND` 这类是正常返回路径，
    // 打出来会污染排障日志（线上要看的是程序异常，不是用户搜了个不存在的角色）。
    if (!(error instanceof AppError)) console.error("Bangumi data worker query failed", error);
    // 搜索服务故障按请求所属玩法归一 code：猜歌侧要能被 FallbackBangumiProvider 识别
    // （它只接 BANGUMI_DATA_UNAVAILABLE / BANGUMI_QUERY_TIMEOUT），不能一概记成 CEE 的 code。
    const isSongRequest = request.method.startsWith("song.");
    const code = error instanceof AppError ? error.code : isSongRequest ? "BANGUMI_DATA_UNAVAILABLE" : "CEE_DATA_UNAVAILABLE";
    self.postMessage({ id: request.id, ok: false,
      code,
      message: error instanceof AppError ? error.message : "本地 Bangumi 数据读取失败",
    } satisfies BangumiDataReply);
  }
};
