import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  DAY_MS,
  DEFAULT_REFRESH_TIERS,
  RefreshPlanner,
  type RefreshTier,
} from "../src/infrastructure/updater/RefreshPlanner";

const NOW = Date.parse("2026-10-10T12:00:00Z");

/** 只建选取要读的两张表；热度按编号递减，编号越小越热。 */
const makeDb = (subjects: number) => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE subjects (id INTEGER PRIMARY KEY, heat INTEGER NOT NULL);
    CREATE TABLE bangumi_refresh (
      subject_id INTEGER PRIMARY KEY, tier INTEGER NOT NULL, refreshed_at INTEGER NOT NULL,
      failures INTEGER NOT NULL, next_at INTEGER NOT NULL
    );
  `);
  const insert = db.query("INSERT INTO subjects VALUES (?,?)");
  for (let id = 1; id <= subjects; id += 1) insert.run(id, subjects - id);
  return db;
};

const seed = (db: Database, id: number, refreshedAt: number, nextAt = 0, failures = 0) =>
  db
    .query("INSERT OR REPLACE INTO bangumi_refresh VALUES (?,0,?,?,?)")
    .run(id, refreshedAt, failures, nextAt);

const planner = (db: Database, tiers = DEFAULT_REFRESH_TIERS, roundLimit = 1000) =>
  new RefreshPlanner(db, () => NOW, tiers, roundLimit);

/** 旧实现的原样复刻：整表读出、在内存里逐行判定。只作为等价比对的参照。 */
const reference = (db: Database, tiers: RefreshTier[], roundLimit: number) => {
  const rows = db
    .query<{ id: number; refreshed_at: number | null; next_at: number | null }, []>(
      "SELECT s.id AS id, r.refreshed_at AS refreshed_at, r.next_at AS next_at FROM subjects s" +
        " LEFT JOIN bangumi_refresh r ON r.subject_id = s.id ORDER BY s.heat DESC, s.id ASC"
    )
    .all();
  const tierAt = (ratio: number) => {
    for (let index = 0; index < tiers.length; index += 1)
      if (ratio < (tiers[index]?.coverage ?? 1)) return index;
    return Math.max(0, tiers.length - 1);
  };
  const due: Array<{ id: number; tier: number }> = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const tier = tierAt(index / Math.max(1, rows.length));
    const interval = (tiers[tier]?.intervalDays ?? 30) * DAY_MS;
    const stale = row.refreshed_at === null || NOW - row.refreshed_at >= interval;
    const allowed = row.next_at === null || NOW >= row.next_at;
    if (stale && allowed) due.push({ id: row.id, tier });
    if (due.length >= roundLimit) break;
  }
  return due;
};

/** 随机铺状态：约两成没有状态行，其余的刷新时刻、退避与「从未成功」随机组合。 */
const seedRandomly = (db: Database, total: number, random: () => number) => {
  for (let id = 1; id <= total; id += 1) {
    if (random() < 0.2) continue;
    const age = Math.floor(random() * 40) * DAY_MS + (random() < 0.3 ? 0 : 1);
    const next = random() < 0.3 ? NOW + Math.floor(random() * 3) * 1000 - 1000 : 0;
    seed(db, id, random() < 0.1 ? 0 : NOW - age, next, next ? 1 : 0);
  }
};

describe("到期选取的边界", () => {
  test("恰好到期的选中，差一毫秒的不选", () => {
    const db = makeDb(10);
    const tiers: RefreshTier[] = [{ coverage: 1, intervalDays: 2 }];
    seed(db, 1, NOW - 2 * DAY_MS);
    seed(db, 2, NOW - 2 * DAY_MS + 1);
    for (let id = 3; id <= 10; id += 1) seed(db, id, NOW);
    expect(
      planner(db, tiers)
        .selectDue()
        .map((row) => Number(row.id))
    ).toEqual([1]);
    db.close();
  });

  test("从未成功过的新条目（没有状态行，或刷新时刻为零）都到期", () => {
    const db = makeDb(4);
    const tiers: RefreshTier[] = [{ coverage: 1, intervalDays: 30 }];
    // 1：没有状态行；2：失败过但从未成功（刷新时刻 0，退避已过）；3、4：刚刷新过。
    seed(db, 2, 0, NOW - 1, 3);
    seed(db, 3, NOW);
    seed(db, 4, NOW);
    expect(
      planner(db, tiers)
        .selectDue()
        .map((row) => Number(row.id))
    ).toEqual([1, 2]);
    db.close();
  });

  test("退避中的条目不选，退避截止的那一刻才放行", () => {
    const db = makeDb(3);
    const tiers: RefreshTier[] = [{ coverage: 1, intervalDays: 2 }];
    // 三个都已过期，只有退避决定谁被选。
    seed(db, 1, NOW - 9 * DAY_MS, NOW + 1, 2);
    seed(db, 2, NOW - 9 * DAY_MS, NOW, 1);
    seed(db, 3, NOW - 9 * DAY_MS, 0, 0);
    expect(
      planner(db, tiers)
        .selectDue()
        .map((row) => Number(row.id))
    ).toEqual([2, 3]);
    db.close();
  });

  test("分层与限量：热的先选，每个条目带上所属层", () => {
    const db = makeDb(10);
    for (let id = 1; id <= 10; id += 1) seed(db, id, NOW - 8 * DAY_MS);
    // 8 天前：前 50%（两层）到期，其余一个月的层不到期。
    const all = planner(db).selectDue();
    expect(all.map((row) => [Number(row.id), row.tier])).toEqual([
      [1, 0],
      [2, 0],
      [3, 1],
      [4, 1],
      [5, 1],
    ]);
    expect(planner(db, DEFAULT_REFRESH_TIERS, 3).selectDue()).toHaveLength(3);
    db.close();
  });

  test("与旧的内存全表判定逐项等价（随机状态）", () => {
    let seedValue = 7;
    const random = () => {
      seedValue = (seedValue * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seedValue / 2_147_483_648;
    };
    for (const total of [1, 2, 7, 10, 33, 100]) {
      for (const limit of [1, 5, 1000]) {
        const db = makeDb(total);
        seedRandomly(db, total, random);
        const expected = reference(db, DEFAULT_REFRESH_TIERS, limit);
        const actual = planner(db, DEFAULT_REFRESH_TIERS, limit)
          .selectDue()
          .map((row) => ({ id: Number(row.id), tier: row.tier }));
        expect(actual).toEqual(expected);
        db.close();
      }
    }
  });
});

/** 记录每条 `all()` 语句的文本与返回行数：证明筛选与限量发生在数据库里。 */
const spyOnQueries = (db: Database) => {
  const statements: string[] = [];
  const rowCounts: number[] = [];
  const bound = (target: object, value: unknown) =>
    typeof value === "function" ? value.bind(target) : value;
  const wrapStatement = (sql: string, statement: object) =>
    new Proxy(statement, {
      get(inner, key) {
        const value = Reflect.get(inner, key, inner) as unknown;
        if (key !== "all") return bound(inner, value);
        return (...args: unknown[]) => {
          const rows = (value as (...a: unknown[]) => unknown[]).apply(inner, args);
          statements.push(sql);
          rowCounts.push(rows.length);
          return rows;
        };
      },
    });
  const spy = new Proxy(db, {
    get(target, property) {
      if (property !== "query") return bound(target, Reflect.get(target, property, target));
      return (sql: string) => wrapStatement(sql, target.query(sql));
    },
  });
  return { spy, statements, rowCounts };
};

describe("选取发生在查询层", () => {
  test("筛选与限量由 SQL 完成：数据库只返回本轮要用的那几行，语句带限量", () => {
    const db = makeDb(200);
    for (let id = 1; id <= 200; id += 1) seed(db, id, 0);
    const { spy, statements, rowCounts } = spyOnQueries(db);
    const due = planner(spy, DEFAULT_REFRESH_TIERS, 5).selectDue();
    expect(due).toHaveLength(5);
    // 全表 200 行都到期：旧实现会把 200 行全部读成对象，这里每条语句返回的行数都不超过限量。
    expect(Math.max(...rowCounts)).toBeLessThanOrEqual(5);
    expect(statements.some((sql) => /\bLIMIT\b/i.test(sql))).toBe(true);
    db.close();
  });
});
