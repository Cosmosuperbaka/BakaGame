import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

/**
 * 打开本地数据集。
 *
 * 数据集不再是只读产物 —— 后端要自己更新它（原数据整行覆盖），所以默认连接可写。
 *
 * 三条必须守住的约定：
 * - **不得凭空创建**：数据集是构建产物，缺失就是部署或配置错误。交给 SQLite 默认行为的话，
 *   它会默默建一个空库，把「文件没下发」伪装成「库是空的」，一路拖到查询时才炸。
 *   注意不能靠 `create: false` 表达这个意图 —— bun:sqlite 对该选项会直接抛错，只能自己先查存在性。
 * - **不开 WAL**：猜歌与 CEE 各持一个连接，但同处一个 Worker 线程、访问天然串行，
 *   WAL 的并发收益用不上，反而多出 `-wal` / `-shm` 两个附属文件 —— 部署替换库、手动备份
 *   都得连带处理，容易漏。`busy_timeout` 兜住偶发的锁等待即可。
 * - **多进程分片下只有一片可写**：数据集是单一可写文件，跨进程并发写会长时间等锁
 *   （卡的是出题那条路），备份的 `VACUUM INTO` 与更新器落库还会互相踩。
 *   所以只有承担更新器那一（主）片以可写打开，其余片必须 `readonly` —— 分片只做查询，
 *   写操作（更新器 / 每日备份 / 新条目发现）由调用侧收口到主片，见 `BangumiDataWorker`。
 *   只读连接上任何写语句会直接抛 `SQLITE_READONLY`，这比静默等待锁要好排查得多。
 */
export function openDataset(path: string, readonly = false): Database {
  // 抛普通 Error 而不是 AppError：错误码由调用侧决定（猜歌报 BANGUMI_*、CEE 报 CEE_*），
  // 这里预设任何一个都会让另一侧拿到错的码。
  if (!existsSync(path)) throw new Error(`本地数据集不存在：${path}`);
  const db = readonly ? new Database(path, { readonly: true }) : new Database(path);
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}
