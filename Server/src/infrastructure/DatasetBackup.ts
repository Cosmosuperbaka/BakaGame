import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

/** 每日备份时刻（本地时间 04:00）。 */
const BACKUP_HOUR = 4;
const DAY_MS = 24 * 60 * 60 * 1_000;

export interface DatasetBackupOptions {
  /** 数据集路径。备份用**独立连接**做，不共享运行时的连接。 */
  dbPath: string;
  /** 备份落点。**只保留这一份**：新一轮开始前先删掉上一轮。 */
  backupPath: string;
  logger?: { warn: (message: string) => void };
  now?: () => number;
  /**
   * 每日 04:00 的额外维护任务（备份之后执行）。抛错只记警告，不影响排程。
   * 当前挂的是「发现并导入新条目」。
   */
  onDailyTask?: () => Promise<void>;
}

/**
 * 数据集备份：**启动时立刻备一份**，之后每天 04:00 覆盖，只保留最新一份。
 *
 * 用 `VACUUM INTO` 而不是 `cp`：后者会拷到写了一半的页（库正在被写入方更新），
 * `VACUUM INTO` 在事务里出一致快照，且顺带把碎片整理掉、产物更小。
 * 图片不进备份 —— 那是几个 GiB 的静态资源，丢了可以按需重下。
 */
export function scheduleDatasetBackup(options: DatasetBackupOptions): () => void {
  const now = options.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const runBackup = () => {
    try {
      // 必须先查存在性：SQLite 打开不存在的路径会**默默建一个空库**，
      // 于是「源库缺失」会被伪装成一次成功的空备份——比失败更危险。
      if (!existsSync(options.dbPath)) throw new Error(`数据集不存在：${options.dbPath}`);
      mkdirSync(dirname(options.backupPath), { recursive: true });
      // VACUUM INTO 要求目标不存在；删掉上一份正好就是「只留一个」的语义。
      rmSync(options.backupPath, { force: true });
      const source = new Database(options.dbPath);
      try {
        // 路径不能用参数绑定（VACUUM INTO 的目标是标识符位置），转义单引号后内联。
        source.exec(`VACUUM INTO '${options.backupPath.replace(/'/g, "''")}'`);
      } finally {
        source.close();
      }
    } catch (error) {
      // 备份失败绝不阻断主流程：库本身还在，缺一次快照不是可用性问题。
      options.logger?.warn(`数据集备份失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const scheduleNext = () => {
    if (stopped) return;
    const current = now();
    const next = new Date(current);
    next.setHours(BACKUP_HOUR, 0, 0, 0);
    if (next.getTime() <= current) next.setTime(next.getTime() + DAY_MS);
    timer = setTimeout(() => {
      runBackup();
      void runDailyTask();
      scheduleNext();
    }, next.getTime() - current);
  };

  const runDailyTask = async () => {
    if (!options.onDailyTask) return;
    try {
      await options.onDailyTask();
    } catch (error) {
      // 日常维护失败不该影响服务：下一轮会重试，数据本身还在。
      options.logger?.warn(`每日维护任务失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // 刚起来就先备一份：首次部署后没有任何快照，更新器一旦写坏就没有退路。
  runBackup();
  scheduleNext();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
