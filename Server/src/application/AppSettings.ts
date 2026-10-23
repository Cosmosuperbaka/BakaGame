import { AppError } from "../domain/Errors";
import type {
  AppSettingRepository,
  StoredAppSetting,
} from "../infrastructure/db/AppSettingRepository";
import {
  RUNTIME_SETTING_KEYS,
  RUNTIME_SETTINGS,
  type AdminRuntimeSetting,
  type RuntimeSettingDefaults,
  type RuntimeSettingKey,
} from "../shared/RuntimeSettings";

/**
 * 多进程分片下让各片自行收敛：写的那一片立刻更新，其余片按这个周期回读。
 * 表只有 T3 那几行，整表读的代价可以忽略。
 */
const REFRESH_INTERVAL_MS = 15_000;

export interface AppSettingsOptions {
  /** 没有数据库时不提供：全部旋钮退回环境变量缺省，行为与进表之前一致。 */
  repository?: AppSettingRepository;
  /** 环境变量侧的缺省值（`AppEnv` 的相应几项）。 */
  defaults: RuntimeSettingDefaults;
  logger?: { warn(message: string, context?: Record<string, unknown>): void };
  refreshIntervalMs?: number;
}

/**
 * 运行期旋钮（T3）的读取侧。
 *
 * 读取一律**同步**取内存快照：准入检查在握手与请求路径上，不能为了一个版本号去等数据库。
 * 快照由启动后的首次 `refresh` 与定时回读维护，读不到库、库没起、键不存在时都回落到
 * 环境变量缺省 —— 因此数据库故障只会让旋钮退回启动时的值，不会把玩法打挂。
 */
export class AppSettings {
  private stored = new Map<RuntimeSettingKey, StoredAppSetting>();
  private timer?: ReturnType<typeof setInterval>;
  /** 只在「从正常转为失败」时记一条，避免每 15 秒刷一条同样的告警。 */
  private warned = false;

  constructor(private readonly options: AppSettingsOptions) {
    if (!options.repository) return;
    void this.refresh();
    this.timer = setInterval(
      () => void this.refresh(),
      options.refreshIntervalMs ?? REFRESH_INTERVAL_MS
    );
    // 定时器不该拖住退出：隔离冒烟与压测子进程都靠进程自己收摊。
    this.timer.unref?.();
  }

  async refresh(): Promise<void> {
    const repository = this.options.repository;
    if (!repository) return;
    try {
      const rows = await repository.loadAll();
      const next = new Map<RuntimeSettingKey, StoredAppSetting>();
      for (const key of RUNTIME_SETTING_KEYS) {
        const row = rows[key];
        if (row) next.set(key, row);
      }
      this.stored = next;
      this.warned = false;
    } catch (error) {
      if (this.warned) return;
      this.warned = true;
      this.options.logger?.warn("运行期设置读取失败，暂用上一次的值", { error: String(error) });
    }
  }

  /** 当前生效值（规范化字符串）；库里的值不合当前校验时按缺省处理。 */
  raw(key: RuntimeSettingKey): string {
    const descriptor = RUNTIME_SETTINGS[key];
    const fallback = descriptor.defaultValue(this.options.defaults);
    const row = this.stored.get(key);
    if (!row) return fallback;
    const parsed = descriptor.schema.safeParse(row.value);
    if (!parsed.success) {
      if (!this.warned) {
        this.warned = true;
        this.options.logger?.warn("运行期设置的值不合当前校验，按缺省执行", { key });
      }
      return fallback;
    }
    return parsed.data;
  }

  version(key: Extract<RuntimeSettingKey, "clientMinDesktopVersion" | "clientMinMobileVersion">) {
    return this.raw(key);
  }

  boolean(
    key: Extract<RuntimeSettingKey, "enableGeneralUnblock" | "enableAnonymousQqSearch">
  ): boolean {
    return this.raw(key) === "true";
  }

  snapshot(): AdminRuntimeSetting[] {
    return RUNTIME_SETTING_KEYS.map((key) => this.toView(key));
  }

  private toView(key: RuntimeSettingKey): AdminRuntimeSetting {
    const descriptor = RUNTIME_SETTINGS[key];
    const row = this.stored.get(key);
    return {
      key,
      title: descriptor.title,
      note: descriptor.note,
      envVar: descriptor.envVar,
      kind: descriptor.kind,
      defaultValue: descriptor.defaultValue(this.options.defaults),
      storedValue: row?.value ?? null,
      effectiveValue: this.raw(key),
      updatedAt: row ? row.updatedAt.toISOString() : null,
      updatedBy: row?.updatedBy ?? null,
    };
  }

  /**
   * 写入前的两道门：取值合不合当前校验、有没有配数据库。
   *
   * 单列出来是因为后台要**先写审计再改值**，而被这两条拒掉的请求什么都没改，
   * 不该留下一条看起来成功过的审计。`update` 走同一份校验。
   */
  check(key: RuntimeSettingKey, value: string): string {
    const parsed = RUNTIME_SETTINGS[key].schema.safeParse(value);
    if (!parsed.success) {
      throw new AppError(
        "VALIDATION_ERROR",
        parsed.error.issues.map((issue) => issue.message).join("；") || "取值不合法"
      );
    }
    this.requireRepository();
    return parsed.data;
  }

  /** 管理员写入：校验通过才落库，落库后立刻刷新本片快照。 */
  async update(key: RuntimeSettingKey, value: string, actorId: string): Promise<void> {
    const normalized = this.check(key, value);
    await this.requireRepository().set(key, normalized, actorId);
    await this.refresh();
  }

  private requireRepository(): AppSettingRepository {
    if (!this.options.repository) {
      throw new AppError("CONFIG_ERROR", "运行期设置需要配置数据库（DATABASE_URL）");
    }
    return this.options.repository;
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
