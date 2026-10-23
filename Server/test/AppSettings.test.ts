import { describe, expect, it } from "bun:test";

import { AppSettings } from "../src/application/AppSettings";
import { AppError } from "../src/domain/Errors";
import type {
  AppSettingRepository,
  StoredAppSetting,
} from "../src/infrastructure/db/AppSettingRepository";

/** 只替数据库这一层：其余逻辑（校验、回落、缓存收敛）走的都是生产同一条路径。 */
class FakeRepository implements AppSettingRepository {
  rows = new Map<string, StoredAppSetting>();
  failing = false;

  async loadAll(): Promise<Record<string, StoredAppSetting>> {
    if (this.failing) throw new Error("数据库连不上");
    return Object.fromEntries(this.rows);
  }

  async set(key: string, value: string, updatedBy: string | null): Promise<void> {
    this.rows.set(key, { value, updatedBy, updatedAt: new Date("2026-10-20T00:00:00.000Z") });
  }
}

const warnings: string[] = [];

const make = (
  repository: AppSettingRepository | undefined,
  defaults = { clientMinDesktopVersion: "0.1.1", enableGeneralUnblock: true }
) =>
  new AppSettings({
    repository,
    defaults,
    logger: { warn: (message) => warnings.push(message) },
    refreshIntervalMs: 600_000,
  });

describe("AppSettings 运行期旋钮", () => {
  it("没有数据库时全部按环境变量缺省，写入被明确拒绝", async () => {
    const settings = make(undefined);
    expect(settings.version("clientMinDesktopVersion")).toBe("0.1.1");
    expect(settings.boolean("enableGeneralUnblock")).toBe(true);
    // 没库不等于没配：报错要说清是缺 DATABASE_URL，而不是含糊的「不支持」。
    const error = await settings
      .update("clientMinDesktopVersion", "0.2.0", "actor")
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("CONFIG_ERROR");
  });

  it("库里的值覆盖缺省，读取始终同步走内存快照", async () => {
    const repository = new FakeRepository();
    const settings = make(repository);
    await settings.refresh();
    expect(settings.version("clientMinDesktopVersion")).toBe("0.1.1");
    await settings.update("clientMinDesktopVersion", "0.3.0", "actor-1");
    expect(settings.version("clientMinDesktopVersion")).toBe("0.3.0");
    expect(repository.rows.get("clientMinDesktopVersion")?.value).toBe("0.3.0");
    // 写的人记在 updatedBy 上，后台据此显示是谁抬的门槛。
    expect(
      settings.snapshot().find((item) => item.key === "clientMinDesktopVersion")?.updatedBy
    ).toBe("actor-1");
  });

  it("解灰开关关掉后只认 false，缺省才是 true", async () => {
    const repository = new FakeRepository();
    const settings = make(repository);
    expect(settings.boolean("enableGeneralUnblock")).toBe(true);
    await settings.update("enableGeneralUnblock", "false", "actor-1");
    expect(settings.boolean("enableGeneralUnblock")).toBe(false);
  });

  it("取值不合法时拒绝写入并原样保留旧值", async () => {
    const repository = new FakeRepository();
    const settings = make(repository);
    await settings.update("clientMinDesktopVersion", "0.3", "actor-1").catch(() => {});
    expect(repository.rows.has("clientMinDesktopVersion")).toBe(false);
    await settings.update("enableGeneralUnblock", "yes", "actor-1").catch(() => {});
    expect(repository.rows.has("enableGeneralUnblock")).toBe(false);
    expect(settings.version("clientMinDesktopVersion")).toBe("0.1.1");
  });

  it("空串是合法门槛值，表示不设版本门槛", async () => {
    const settings = make(new FakeRepository());
    await settings.update("clientMinMobileVersion", "", "actor-1");
    expect(settings.version("clientMinMobileVersion")).toBe("");
  });

  it("读取失败保留上一次的值，并且只告警一次", async () => {
    const repository = new FakeRepository();
    const settings = make(repository);
    await settings.update("clientMinDesktopVersion", "0.4.0", "actor-1");
    repository.failing = true;
    await settings.refresh();
    await settings.refresh();
    expect(settings.version("clientMinDesktopVersion")).toBe("0.4.0");
    expect(warnings.filter((message) => message.includes("读取失败"))).toHaveLength(1);
  });

  it("库里存着当前校验不认的值时按缺省执行，不把玩法打挂", async () => {
    const repository = new FakeRepository();
    repository.rows.set("clientMinDesktopVersion", {
      value: "not-a-version",
      updatedBy: null,
      updatedAt: new Date(),
    });
    const settings = make(repository);
    await settings.refresh();
    expect(settings.version("clientMinDesktopVersion")).toBe("0.1.1");
    expect(warnings.some((message) => message.includes("按缺省执行"))).toBe(true);
  });

  it("snapshot 同时给出缺省、覆盖值与生效值，管理员不用猜现在是多少", async () => {
    const repository = new FakeRepository();
    const settings = make(repository);
    await settings.update("clientMinDesktopVersion", "0.5.0", "actor-1");
    const desktop = settings.snapshot().find((item) => item.key === "clientMinDesktopVersion");
    expect(desktop).toMatchObject({
      defaultValue: "0.1.1",
      storedValue: "0.5.0",
      effectiveValue: "0.5.0",
      envVar: "CLIENT_MIN_DESKTOP_VERSION",
      kind: "version",
    });
    const mobile = settings.snapshot().find((item) => item.key === "clientMinMobileVersion");
    expect(mobile).toMatchObject({ storedValue: null, effectiveValue: "" });
    expect(settings.snapshot()).toHaveLength(4);
  });

  it("QQ 匿名补充检索默认开启，关闭后只认 false", async () => {
    const repository = new FakeRepository();
    const settings = make(repository);
    expect(settings.boolean("enableAnonymousQqSearch")).toBe(true);
    await settings.update("enableAnonymousQqSearch", "false", "actor-1");
    expect(settings.boolean("enableAnonymousQqSearch")).toBe(false);
  });
});
