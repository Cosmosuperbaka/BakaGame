import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";

/** 每日备份时刻（本地时间 04:00）。 */
const BACKUP_HOUR = 4;
const DAY_MS = 24 * 60 * 60 * 1_000;

export interface DatasetBackupOptions {
  /** 数据集路径。备份用**独立连接**做，不共享运行时的连接。 */
  dbPath: string;
  /**
   * 备份落点。保留**两代**：当前快照在 `backupPath`，上一代在 `${backupPath}.prev`。
   * 新快照先写到临时文件，校验通过才轮换进来，任何一步失败都不动现有快照。
   */
  backupPath: string;
  logger?: { warn: (message: string) => void };
  /** 每次备份结束都回报结果（含失败），供状态页留痕。 */
  onResult?: (result: { ok: boolean; error: string | null }) => void;
  now?: () => number;
  /**
   * 每日 04:00 的额外维护任务（备份之后执行）。抛错只记警告，不影响排程。
   * 当前挂的是「发现并导入新条目」。
   */
  onDailyTask?: () => Promise<void>;
  /**
   * 备份前后通知更新器暂停/恢复。
   *
   * `VACUUM INTO` 在事务里出一致快照，期间另一条连接持续写入会让两边互相等待
   * （写等读事务、读事务被拉长），快的时候只是变慢，慢的时候直接撞上
   * `busy_timeout`。先停一下写，快照出得干净也更快。
   */
  onBackup?: { pause: () => void; resume: () => void };
}

/** 快照要能打开且通过完整性抽检才算数；否则换入的会是一份损坏的「唯一退路」。 */
function verifySnapshot(path: string): void {
  const snapshot = new Database(path, { readonly: true });
  try {
    const row = snapshot.query("PRAGMA quick_check").get() as { quick_check: string } | null;
    if (row?.quick_check !== "ok")
      throw new Error(`快照完整性检查未通过：${row?.quick_check ?? "无结果"}`);
  } finally {
    snapshot.close();
  }
}

/** 下一次每日任务的时刻（进程本地时区的 04:00），后台状态页读同一口径。 */
export const nextDailyRunAt = (current: number): number => {
  const next = new Date(current);
  next.setHours(BACKUP_HOUR, 0, 0, 0);
  if (next.getTime() <= current) next.setTime(next.getTime() + DAY_MS);
  return next.getTime();
};

const shouldBackupAtStartup = (backupPath: string, current: number): boolean => {
  if (!existsSync(backupPath)) return true;
  return current - statSync(backupPath).mtimeMs >= STARTUP_BACKUP_MAX_AGE_MS;
};

/**
 * 启动时只在「没有快照或快照已超过一天」时补备一份。
 * 无条件启动即备份的话，数据集被坏部署或坏写入弄坏后，一次重启就会用坏库覆盖掉唯一的好快照。
 */
const STARTUP_BACKUP_MAX_AGE_MS = DAY_MS;

/**
 * 数据集备份：启动时按需补备，之后每天 04:00 备一份，保留两代。
 *
 * 用 `VACUUM INTO` 而不是 `cp`：后者会拷到写了一半的页（库正在被写入方更新），
 * `VACUUM INTO` 在事务里出一致快照，且顺带把碎片整理掉、产物更小。
 * 图片不进备份 —— 那是几个 GiB 的静态资源，丢了可以按需重下。
 *
 * **写新、校验、再轮换**：`VACUUM INTO` 要求目标不存在，但绝不能为此先删旧快照——磁盘写满、
 * 源库损坏或进程中途被杀时，旧快照是唯一的退路。恢复时须先停写者进程再换文件。
 */
export function scheduleDatasetBackup(options: DatasetBackupOptions): () => void {
  const now = options.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  /** 把新快照换入：当前快照退为上一代，换入失败时把上一代放回原位。 */
  const rotate = (temporaryPath: string) => {
    const previousPath = `${options.backupPath}.prev`;
    const hadCurrent = existsSync(options.backupPath);
    if (hadCurrent) {
      rmSync(previousPath, { force: true });
      renameSync(options.backupPath, previousPath);
    }
    try {
      renameSync(temporaryPath, options.backupPath);
    } catch (error) {
      if (hadCurrent) renameSync(previousPath, options.backupPath);
      throw error;
    }
  };

  const runBackup = () => {
    options.onBackup?.pause();
    let failure: string | null = null;
    const temporaryPath = `${options.backupPath}.tmp`;
    try {
      // 必须先查存在性：SQLite 打开不存在的路径会**默默建一个空库**，
      // 于是「源库缺失」会被伪装成一次成功的空备份——比失败更危险。
      if (!existsSync(options.dbPath)) throw new Error(`数据集不存在：${options.dbPath}`);
      mkdirSync(dirname(options.backupPath), { recursive: true });
      // 上次中途被杀可能留下临时文件；VACUUM INTO 要求目标不存在。
      rmSync(temporaryPath, { force: true });
      const source = new Database(options.dbPath);
      try {
        // 路径不能用参数绑定（VACUUM INTO 的目标是标识符位置），转义单引号后内联。
        source.exec(`VACUUM INTO '${temporaryPath.replace(/'/g, "''")}'`);
      } finally {
        source.close();
      }
      verifySnapshot(temporaryPath);
      rotate(temporaryPath);
    } catch (error) {
      // 备份失败绝不阻断主流程：库本身还在，缺一次快照不是可用性问题。
      failure = error instanceof Error ? error.message : String(error);
      options.logger?.warn(`数据集备份失败：${failure}`);
      rmSync(temporaryPath, { force: true });
    } finally {
      // 备份失败也必须恢复：更新器卡在暂停态会让数据集永远不再更新。
      options.onBackup?.resume();
    }
    options.onResult?.({ ok: failure === null, error: failure });
  };

  const scheduleNext = () => {
    if (stopped) return;
    const current = now();
    timer = setTimeout(
      () => {
        runBackup();
        void runDailyTask();
        scheduleNext();
      },
      nextDailyRunAt(current) - current
    );
  };

  const runDailyTask = async () => {
    if (!options.onDailyTask) return;
    try {
      await options.onDailyTask();
    } catch (error) {
      // 日常维护失败不该影响服务：下一轮会重试，数据本身还在。
      options.logger?.warn(
        `每日维护任务失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  // 首次部署后没有任何快照，更新器一旦写坏就没有退路，所以缺快照时刚起来就先备一份。
  if (shouldBackupAtStartup(options.backupPath, now())) runBackup();
  scheduleNext();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
