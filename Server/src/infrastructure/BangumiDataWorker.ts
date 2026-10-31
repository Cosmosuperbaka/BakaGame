import { AppError, isAppError } from "../domain/Errors";
import { CEECharacterRepository } from "./CEECharacterRepository";
import { rankCEEOpenings } from "../domain/CEERankedSolver";
import { CEE_RANKED_AIGA_OPENING_ID } from "../domain/CEERankedBot";
import { LocalBangumiProvider } from "./LocalBangumiProvider";
import { scheduleDatasetBackup } from "./DatasetBackup";
import { scheduleTagDiffSync, syncTagDiff } from "./TagDiffSync";
import { BangumiImageStore, type ImageStore } from "./BangumiImageStore";
import { R2ImageStore, R2ImageUploader, type R2Config } from "./R2ImageStore";
import { BangumiSearchIndex } from "./BangumiSearchIndex";
import { openDataset } from "./OpenDataset";
import { SubjectUpdater, type SubjectUpdaterInit } from "./SubjectUpdater";
import type { AnimeAutoFilters } from "../shared/Index";
import type { BangumiProviderInit } from "./LocalBangumiProvider";
import type { CEEDataInit } from "./CEEData";
import type { CEECharacterView, CEEImageSize, CEESettings } from "../shared/CEE";

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
  | {
      id: number;
      method: "init";
      song: BangumiProviderInit;
      cee: CEEDataInit;
      tagDiff?: TagDiffOptions;
      imagesDir?: string;
      /** 配上就写 R2（字节上云、本地只留索引）；不配则维持本地分片。 */
      r2?: R2Config;
      updater?: SubjectUpdaterInit;
    }
  // ---- 猜歌 ----
  | {
      id: number;
      method: "song.searchSubjects";
      keyword: string;
      limit?: number;
      filters?: AnimeAutoFilters;
    }
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
  /** 排位题库：整档答案池 + 首猜排名 + 题库外补充视图，一次性算好在 worker 里。 */
  | { id: number; method: "cee.rankedPool"; settings: CEESettings }
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

/**
 * 跨线程错误上下文。
 *
 * `postMessage` 用结构化克隆，Error 的 `stack` / `name` / `cause` 都过不去：主线程
 * 收到失败后只能 `new Error(...)`，拿到的是「请求侧栈」，worker 里真正的抛出点整条
 * 丢失，Sentry 上无法归因到哪个操作、哪一行。这里显式把错误摊平成纯字符串字段，
 * cause 链按层递归但限深（防止环状引用把克隆打爆）。
 */
export interface BangumiErrorContext {
  name: string;
  message: string;
  /** worker 线程侧的栈，帧里带 worker 自己的文件名与行号。 */
  stack?: string;
  cause?: BangumiErrorContext;
}

/** 只到三层：再深的 cause 链对排障没有增量，却有把克隆图撑爆的风险。 */
const MAX_ERROR_CAUSE_DEPTH = 3;

/** 非 Error 的抛出值与 cause 可能是 Symbol、循环对象：取值本身不能让日志再抛一次。 */
const describeUnknown = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (typeof value === "symbol" || typeof value === "bigint") return value.toString();
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

const toErrorContext = (error: unknown, depth = 0): BangumiErrorContext => {
  const thrown = error instanceof Error;
  const cause = thrown ? error.cause : undefined;
  return {
    name: thrown ? error.name : "NonErrorThrown",
    message: thrown ? error.message : describeUnknown(error),
    ...(thrown && error.stack ? { stack: error.stack } : {}),
    ...(cause !== undefined && depth < MAX_ERROR_CAUSE_DEPTH
      ? { cause: toErrorContext(cause, depth + 1) }
      : {}),
  };
};

export type BangumiDataReply = { type: "reply"; id: number } & (
  | { ok: true; value: unknown }
  | { ok: false; code: string; message: string; error?: BangumiErrorContext }
);

/**
 * worker → 主线程的日志帧。
 *
 * worker 线程没有 Sentry、也不该有：唯一的观测出口是主线程的 `EventLogger`
 * （结构化真相源 + OTLP + Sentry 都在那边）。裸标准输出只进 stdout，既不经
 * 脱敏也不产生指标，采集链路里等于隐形。所以 worker 内所有日志统一走这个桥。
 */
export interface BangumiDataLogFrame {
  type: "log";
  level: "info" | "warn" | "error";
  /** 归因来源：请求的 `method`，或定时任务名（worker 里只有这一层知道是谁在说话）。 */
  source: string;
  message: string;
  error?: BangumiErrorContext;
}

/** Worker 线程可能发回的所有帧：判别字段是 `type`，回包带 `id`，日志帧不带。 */
export type BangumiDataFrame = BangumiDataReply | BangumiDataLogFrame;

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
let images: ImageStore | undefined;
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

const asAppError = (error: unknown, code: string) =>
  error instanceof AppError
    ? error
    : new AppError(code, error instanceof Error ? error.message : "本地数据初始化失败");

type InitRequest = Extract<BangumiDataRequest, { method: "init" }>;
type SongRequest = Extract<BangumiDataRequest, { method: `song.${string}` }>;
type CeeRequest = Extract<BangumiDataRequest, { method: `cee.${string}` }>;

/** 猜歌链路建库：失败只记在本侧（两链路可用性各自判定，见文件头）。 */
const initSongLink = async (request: InitRequest): Promise<void> => {
  try {
    // 玩家点开的条目登记到更新器：闭包引用，更新器晚一步创建也没关系。
    song = new LocalBangumiProvider({
      ...request.song,
      onSubjectView: (id) => updater?.requestRefresh(id),
      logger: bridgedLogger("song"),
    });
    await song.initialize();
  } catch (error) {
    song = undefined;
    songError = asAppError(error, "BANGUMI_DATA_UNAVAILABLE");
  }
};

/** CEE 链路建库：同样失败只记在该侧，查询时再抛出来。 */
const initCeeLink = async (request: InitRequest): Promise<void> => {
  try {
    cee = new CEECharacterRepository(request.cee);
    await cee.initialize();
  } catch (error) {
    cee = undefined;
    ceeError = asAppError(error, "CEE_DATA_UNAVAILABLE");
  }
};

/**
 * worker 线程唯一的日志出口：桥回主线程的 `EventLogger`。
 *
 * 本线程没有 Sentry，也不裸调标准 console 通道：那条路只进 stdout，既不经脱敏也不产生
 * 日志/指标，观测平台里等于隐形（定时任务的故障因此完全不可见）。
 */
const postLog = (
  level: BangumiDataLogFrame["level"],
  source: string,
  message: string,
  error?: unknown
): void => {
  self.postMessage({
    type: "log",
    level,
    source,
    message,
    ...(error === undefined ? {} : { error: toErrorContext(error) }),
  } satisfies BangumiDataLogFrame);
};

/** 定时任务与更新器的日志适配器：把它们也收进同一条桥，source 标明是谁在说话。 */
const bridgedLogger = (source: string) => ({
  info: (message: string) => postLog("info", source, message),
  warn: (message: string) => postLog("warn", source, message),
});

/**
 * 更新器自己开一条数据集连接：它与查询侧同处本线程，写操作天然串行，
 * 不必（也不该）去扒 provider 内部的句柄。
 * 起不来只记警告：数据集缺失时查询链路已经各自报错了，更新器不该再把它
 * 放大成 init 整体失败（那会让所有查询永久拿不到数据）。
 */
const createUpdater = (request: InitRequest): void => {
  try {
    updater =
      request.updater && !request.song.readonly
        ? new SubjectUpdater({
            db: openDataset(request.song.dbPath),
            // 没配搜索就不建索引适配器：否则待同步队列会一直攒着却永远没人消费。
            search: request.song.meilisearch?.apiKey
              ? new BangumiSearchIndex({
                  apiKey: request.song.meilisearch.apiKey,
                  host: request.song.meilisearch.host,
                })
              : undefined,
            images,
            logger: bridgedLogger("updater"),
            ...request.updater,
          })
        : undefined;
    updater?.markDatasetFresh();
    updater?.start();
  } catch (error) {
    postLog("warn", "updater", "运行时更新器未启动", error);
    updater = undefined;
  }
};

/** 每日维护：补上两份 dump 之间新出的作品与角色。没有这一步，搜索永远搜不到新番。 */
const discoverNewSubjectsDaily = async (request: InitRequest): Promise<void> => {
  const base = (request.song.apiBase ?? "").trim();
  if (!base) return; // 未配置上游地址时静默跳过（本地开发常见）。
  const result = await requireCee().discoverNewSubjects(base);
  postLog(
    "info",
    "maintenance.discoverNewSubjects",
    `新条目发现：窗口自 ${result.window}，候选 ${result.candidates}，` +
      `入库 ${result.added}，跳过 ${result.skipped}，失败 ${result.failed}`
  );
};

/**
 * 备份与标签增量的定时任务：库现在可写、且要由后端自己更新：没有快照就没有退路。启动先备一份，之后每天 04:00 覆盖。
 *
 * **只读片整段跳过**：备份是 `VACUUM INTO`、新条目发现要落库，两者都是对数据集的写。
 * 多进程分片下这些活只归主片（见 `CreateServer` 的 `datasetReadonly`），
 * 在只读连接上跑只会拿到 `SQLITE_READONLY`，还会把 `discoverNewSubjects` 变成重复打上游。
 */
const scheduleRuntimeMaintenance = (request: InitRequest): void => {
  if (request.song.readonly) return;
  stopBackup = scheduleDatasetBackup({
    dbPath: request.song.dbPath,
    backupPath: `${request.song.dbPath}.backup`,
    logger: bridgedLogger("maintenance.backup"),
    // 备份期间停更新器：VACUUM INTO 出一致快照，别让写入拖长它。
    onBackup: { pause: () => updater?.pause(), resume: () => updater?.resume() },
    onDailyTask: () => discoverNewSubjectsDaily(request),
  });
  // 角色标签增量（CCB-TagsCI 产出）：定时拉取，不依赖任何外部触发。
  stopTagDiff = tagDiff
    ? scheduleTagDiffSync({
        repository: () => requireCee(),
        diffUrl: tagDiff!.diffUrl,
        statePath: tagDiff!.statePath,
        logger: bridgedLogger("maintenance.tagDiff"),
      })
    : undefined;
};

/** 两条链路共用一次 init，但分别容错；两边的库各自建索引，串行初始化。 */
const initRuntime = async (request: InitRequest): Promise<true> => {
  // 同一进程内共用一个 Meilisearch 客户端即可，但索引写入仍由各自适配器排队，
  // 并发只会让两边互相拖慢。
  await initSongLink(request);
  await initCeeLink(request);
  tagDiff = request.tagDiff;
  const index = request.imagesDir ? BangumiImageStore.open(request.imagesDir) : undefined;
  // 有 R2 就写云：本地分片退成「路径索引」，字节不再落在生产机。
  images = index
    ? request.r2
      ? new R2ImageStore(index, new R2ImageUploader(request.r2))
      : index
    : undefined;
  createUpdater(request);
  scheduleRuntimeMaintenance(request);
  return true;
};

const closeRuntime = async (): Promise<true> => {
  updater?.stop();
  updater = undefined;
  stopTagDiff?.();
  stopTagDiff = undefined;
  stopBackup?.();
  stopBackup = undefined;
  await Promise.allSettled([cee, song].map((database) => Promise.resolve(database?.close())));
  images?.close();
  images = undefined;
  song = undefined;
  cee = undefined;
  songError = undefined;
  ceeError = undefined;
  return true;
};

const dispatchSongRequest = async (
  request: SongRequest,
  provider: LocalBangumiProvider
): Promise<unknown> => {
  switch (request.method) {
    case "song.searchSubjects":
      return provider.searchSubjects(request.keyword, request.limit, request.filters);
    case "song.getSubject":
      return provider.getSubject(request.subjectId);
    case "song.resolveCharacterImage":
      return provider.resolveCharacterImage(request.characterId);
    case "song.resolveSubjectImage":
      return provider.resolveSubjectImage(request.subjectId);
  }
  return undefined;
};

/**
 * 爱噶首猜用的题库外角色视图。
 *
 * 丰川祥子不一定在本档题库里；数据集里没这个角色时人机退化成普通首猜：只吞「不存在」这一类错误，
 * 库损坏或未就绪之类的故障必须照原样抛出，否则题库会被静默降级成没有爱噶首猜。
 */
const aigaOpeningView = async (
  repository: CEECharacterRepository,
  settings: CEESettings
): Promise<CEECharacterView[]> => {
  try {
    return [await repository.getCharacter(CEE_RANKED_AIGA_OPENING_ID, settings)];
  } catch (error) {
    if (isAppError(error) && error.code === "CEE_CHARACTER_NOT_FOUND") return [];
    throw error;
  }
};

const dispatchCeeRequest = async (
  request: CeeRequest,
  repository: CEECharacterRepository
): Promise<unknown> => {
  switch (request.method) {
    case "cee.searchCharacters":
      return repository.searchCharacters(request.keyword, request.limit);
    case "cee.searchSubjects":
      return repository.searchSubjects(request.keyword, request.limit, request.types);
    case "cee.getSubjectCharacters":
      return repository.getSubjectCharacters(request.subjectId, request.limit);
    case "cee.getSubjects":
      return repository.getSubjects(request.subjectIds);
    case "cee.getRawCharacter":
      return repository.getRawCharacter(request.characterId);
    case "cee.getCharacter":
      return repository.getCharacter(request.characterId, request.settings);
    case "cee.chooseRandomCharacter": {
      let cursor = 0;
      return repository.chooseRandomCharacter(request.settings, () => {
        const roll = request.rolls[cursor++];
        if (roll === undefined) throw new AppError("CEE_DATA_INVALID", "随机采样参数不完整");
        return roll;
      });
    }
    case "cee.rankedPool": {
      const candidates = await repository.listRankedCandidates(request.settings);
      // 首猜排名是题库大小平方次反馈计算，必须留在 worker 线程，回主线程会卡住游戏循环。
      const openings = rankCEEOpenings(candidates, request.settings);
      return {
        candidates,
        openings,
        extras: await aigaOpeningView(repository, request.settings),
      };
    }
    case "cee.importDirectory":
      return repository.importDirectory(request.indexId);
    case "cee.resolveCharacterImage":
      return repository.resolveCharacterImage(request.characterId, request.size);
    case "cee.resolveSubjectImage":
      return repository.resolveSubjectImage(request.subjectId, request.size);
    case "cee.syncTagDiff": {
      if (!tagDiff) throw new AppError("CEE_DATA_UNAVAILABLE", "标签增量未配置");
      return syncTagDiff({ repository, diffUrl: tagDiff.diffUrl, statePath: tagDiff.statePath });
    }
  }
  return undefined;
};

/** 前缀分派要靠类型谓词收窄：`startsWith` 本身不动判别联合的类型。 */
const isSongRequest = (request: BangumiDataRequest): request is SongRequest =>
  request.method.startsWith("song.");

const dispatchRequest = async (request: BangumiDataRequest): Promise<unknown> => {
  if (request.method === "init") return initRuntime(request);
  if (request.method === "close") return closeRuntime();
  if (request.method === "images.put") {
    if (!images) throw new AppError("BANGUMI_DATA_UNAVAILABLE", "图床未就绪");
    await images.put(request.path, request.bytes);
    return true;
  }
  if (request.method === "updater.reportLoad") {
    updater?.reportLoad(request.players);
    return true;
  }
  if (request.method === "updater.stats") return updater?.stats() ?? { running: false };
  if (request.method === "updater.refreshSubject")
    return updater ? updater.refresh(request.subjectId) : false;
  if (isSongRequest(request)) return dispatchSongRequest(request, requireSong());
  return dispatchCeeRequest(request, requireCee());
};

/**
 * 失败回包：只对**非业务错误**上报表——`CEE_CHARACTER_NOT_FOUND` 这类是正常返回路径，
 * 报出来会污染排障日志（线上要看的是程序异常，不是用户搜了个不存在的角色）。
 * 业务错误仍然带 stack：主线程据此归因，但不再裸打 console。
 */
const replyWithFailure = (request: BangumiDataRequest, error: unknown): void => {
  if (!(error instanceof AppError)) {
    postLog("error", request.method, `Bangumi 数据 Worker 查询异常：${request.method}`, error);
  }
  // 搜索服务故障按请求所属玩法归一 code：猜歌侧要能被 FallbackBangumiProvider 识别
  // （它只接 BANGUMI_DATA_UNAVAILABLE / BANGUMI_QUERY_TIMEOUT），不能一概记成 CEE 的 code。
  const fromSongLink = request.method.startsWith("song.");
  const code =
    error instanceof AppError
      ? error.code
      : fromSongLink
        ? "BANGUMI_DATA_UNAVAILABLE"
        : "CEE_DATA_UNAVAILABLE";
  self.postMessage({
    type: "reply",
    id: request.id,
    ok: false,
    code,
    message: error instanceof AppError ? error.message : "本地 Bangumi 数据读取失败",
    error: toErrorContext(error),
  } satisfies BangumiDataReply);
};

self.onmessage = async ({ data: request }: MessageEvent<BangumiDataRequest>) => {
  try {
    const value = await dispatchRequest(request);
    self.postMessage({ type: "reply", id: request.id, ok: true, value } satisfies BangumiDataReply);
  } catch (error) {
    replyWithFailure(request, error);
  }
};
