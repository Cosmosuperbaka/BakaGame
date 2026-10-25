import { BangumiWorkerProvider } from "./BangumiWorkerProvider";
import { CEECharacterWorkerProvider } from "./CEECharacterWorkerProvider";
import { BangumiDataWorkerClient } from "./BangumiDataWorkerClient";
import type { BangumiProviderInit } from "./LocalBangumiProvider";
import type { CEEDataInit } from "./CEEData";
import type { TagDiffOptions } from "./BangumiDataWorker";
import type { SubjectUpdaterInit } from "./SubjectUpdater";

export interface BangumiDataBundle {
  /** 猜歌侧门面，实现 `BangumiDataProvider`。 */
  song: BangumiWorkerProvider;
  /** CEE 侧门面，实现 `CEEDataProvider`。 */
  cee: CEECharacterWorkerProvider;
  /** 唯一 Worker 的持有者：关闭资源时调它，不要分别关两个门面。 */
  client: BangumiDataWorkerClient;
}

/** 起**一个**数据 Worker（合流理由见 `BangumiDataWorker`），并给出猜歌与 CEE 两个门面。 */
export function createBangumiData(options: {
  song: BangumiProviderInit;
  cee: CEEDataInit;
  tagDiff?: TagDiffOptions;
  imagesDir?: string;
  updater?: SubjectUpdaterInit;
}): BangumiDataBundle {
  const client = new BangumiDataWorkerClient();
  // 一次 init 同时建两边的数据源；两个门面共用这个 Promise，不会各发起一次。
  const ready = client.init({
    method: "init",
    song: options.song,
    cee: options.cee,
    tagDiff: options.tagDiff,
    imagesDir: options.imagesDir,
    updater: options.updater,
  });
  return {
    client,
    song: new BangumiWorkerProvider(client, ready),
    cee: new CEECharacterWorkerProvider(client, ready),
  };
}
