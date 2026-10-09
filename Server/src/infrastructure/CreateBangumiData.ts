import { BangumiWorkerProvider } from "./BangumiWorkerProvider";
import { CCBCharacterWorkerProvider } from "./CCBCharacterWorkerProvider";
import { BangumiDataWorkerClient } from "./BangumiDataWorkerClient";
import type { BangumiProviderInit } from "./LocalBangumiProvider";
import type { CCBDataInit } from "./CCBData";
import type { TagDiffOptions } from "./BangumiDataWorker";

export interface BangumiDataBundle {
  /** 猜歌侧门面，实现 `BangumiDataProvider`。 */
  song: BangumiWorkerProvider;
  /** CCB 侧门面，实现 `CCBDataProvider`。 */
  ccb: CCBCharacterWorkerProvider;
  /** 唯一 Worker 的持有者：关闭资源时调它，不要分别关两个门面。 */
  client: BangumiDataWorkerClient;
}

/**
 * 起**一个**数据 Worker，并给出猜歌与 CCB 两个门面。
 *
 * 两个玩法的数据请求原本各走一个 Worker 进程，各自打开 SQLite 与 Meilisearch。
 * 数据集改为可写、且要由后端自己更新之后，两个进程同写一个库文件会出现写写冲突；
 * 这里让两边共用同一进程，写操作因此天然串行，不需要额外的跨 Worker 队列。
 */
export function createBangumiData(options: { song: BangumiProviderInit; ccb: CCBDataInit; tagDiff?: TagDiffOptions }): BangumiDataBundle {
  const client = new BangumiDataWorkerClient();
  // 一次 init 同时建两边的数据源；两个门面共用这个 Promise，不会各发起一次。
  const ready = client.init({ method: "init", song: options.song, ccb: options.ccb, tagDiff: options.tagDiff });
  return {
    client,
    song: new BangumiWorkerProvider(client, ready),
    ccb: new CCBCharacterWorkerProvider(client, ready),
  };
}
