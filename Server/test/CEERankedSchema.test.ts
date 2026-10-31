// ==================== 一次性建表脚本与 schema 的一致性 ====================
// `Server/oneoff/2026-10-31-cee-ranked.sql` 是真正在各环境执行的那份文本，Schema.ts 是唯一真相源。
// 两者靠人工同步，最容易漏的是「加了列忘了脚本」和「列宽改了脚本没改」，所以这里逐列比对，
// 而不是只数一下列的个数。脚本尚未在任何环境执行过，因此它直接写 CREATE TABLE，不含 ALTER。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableColumns, type Column, type Table } from "drizzle-orm";

import {
  ceeRankedGame,
  ceeRankedGuess,
  ceeRankedRating,
  ceeRankedSeries,
  ceeRankedSeriesPlayer,
} from "../src/infrastructure/db/Schema";

const SQL_PATH = resolve(import.meta.dir, "../oneoff/2026-10-31-cee-ranked.sql");
const SCRIPT = readFileSync(SQL_PATH, "utf8").replaceAll("\r\n", "\n");

/** drizzle 列对象上这一批用得着的元数据；只读比对，不参与建表。 */
interface ColumnMeta {
  columnType: string;
  /** 蛇形列名，与 JS 属性名不同。 */
  name: string;
  notNull: boolean;
  hasDefault: boolean;
  default?: unknown;
  length?: number;
  fsp?: number;
}

/** schema 侧的列定义文本，与脚本里的写法逐字对齐：`列名 类型 [NOT NULL] [DEFAULT 值]`。 */
const definitionOf = (name: string, column: Column): string => {
  const meta = column as unknown as ColumnMeta;
  let type = meta.columnType;
  if (meta.columnType === "MySqlVarChar") type = `varchar(${meta.length})`;
  else if (meta.columnType === "MySqlDateTime") type = `datetime(${meta.fsp})`;
  else if (meta.columnType === "MySqlInt") type = "int";
  else if (meta.columnType === "MySqlDouble") type = "double";
  else if (meta.columnType === "MySqlBoolean") type = "boolean";
  else if (meta.columnType === "MySqlJson") type = "json";
  const notNull = meta.notNull ? " NOT NULL" : "";
  // $defaultFn 的缺省是函数，由应用层补值，不进 DDL；只有写死的数值缺省才落成 DEFAULT。
  const constant =
    meta.hasDefault && typeof meta.default === "number" ? ` DEFAULT ${meta.default}` : "";
  return `\`${name}\` ${type}${notNull}${constant}`;
};

/** 脚本里某张 CREATE TABLE 的内部文本行，去缩进与行尾逗号。 */
const linesOf = (table: string): string[] => {
  const header = `CREATE TABLE \`${table}\` (`;
  const start = SCRIPT.indexOf(header);
  if (start < 0) throw new Error(`建表脚本里没有 ${header}`);
  const body = SCRIPT.slice(start + header.length);
  const end = body.indexOf("\n);");
  if (end < 0) throw new Error(`建表脚本里 ${table} 的建表语句没有收尾`);
  return body
    .slice(0, end)
    .split("\n")
    .map((line) => line.trim().replace(/,$/, ""))
    .filter((line) => line.length > 0);
};

/** 脚本里某张表的列定义行（表级约束行不算）。 */
const scriptColumnsOf = (table: string): string[] =>
  linesOf(table).filter((line) => line.startsWith("`"));

/** schema 侧某张表的列名（蛇形列名，不是 JS 属性名）。 */
const schemaColumnNamesOf = (table: Table): string[] =>
  Object.values(getTableColumns(table)).map((column) => (column as unknown as ColumnMeta).name);

const columnsOf = (table: Table): string[] =>
  Object.values(getTableColumns(table)).map((column) =>
    definitionOf((column as unknown as ColumnMeta).name, column)
  );

/** 脚本里 CREATE INDEX 引用的列，按表名归组。 */
const indexedColumnsOf = (): Map<string, string[]> => {
  const map = new Map<string, string[]>();
  for (const match of SCRIPT.matchAll(/CREATE INDEX `[^`]+` ON `([^`]+)` \(([^)]*)\)/g)) {
    const table = match[1];
    const columns = match[2];
    if (!table || !columns) continue;
    map.set(table, [
      ...(map.get(table) ?? []),
      ...columns.split(",").map((column) => column.replace(/`/g, "").trim()),
    ]);
  }
  return map;
};

const RANKED_TABLES: ReadonlyArray<readonly [string, Table]> = [
  ["cee_ranked_rating", ceeRankedRating],
  ["cee_ranked_series", ceeRankedSeries],
  ["cee_ranked_series_player", ceeRankedSeriesPlayer],
  ["cee_ranked_game", ceeRankedGame],
  ["cee_ranked_guess", ceeRankedGuess],
];

describe("建表脚本与 Schema.ts 一致", () => {
  test("脚本只建排位这五张表", () => {
    const created = [...SCRIPT.matchAll(/CREATE TABLE `([^`]+)`/g)]
      .map((match) => match[1])
      .filter((name): name is string => name !== undefined);
    expect(created).toEqual(RANKED_TABLES.map(([name]) => name));
  });

  for (const [name, table] of RANKED_TABLES) {
    test(`${name} 的列定义逐列一致`, () => {
      expect(scriptColumnsOf(name)).toEqual(columnsOf(table));
    });
  }

  test("主键与索引引用的列都是表里的列", () => {
    const indexes = indexedColumnsOf();
    for (const [name, table] of RANKED_TABLES) {
      const names = new Set(schemaColumnNamesOf(table));
      const keys = linesOf(name)
        .filter((line) => line.startsWith("CONSTRAINT"))
        .flatMap((line) => {
          const primary = line.match(/PRIMARY KEY\(([^)]*)\)/);
          return primary?.[1] ? primary[1].split(",") : [];
        })
        .map((column) => column.replace(/`/g, "").trim());
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) expect(names).toContain(key);

      const indexed = indexes.get(name);
      if (!indexed) continue;
      expect(indexed.length).toBeGreaterThan(0);
      for (const column of indexed) expect(names).toContain(column);
    }
  });
});

describe("校准与定级用到的列", () => {
  const metaOf = (table: Table, key: string): ColumnMeta => {
    const column = getTableColumns(table)[key];
    if (!column) throw new Error(`${key} 不在 schema 里`);
    return column as unknown as ColumnMeta;
  };

  test("bot_entry 宽度放宽到 16 以容纳 placement", () => {
    expect(metaOf(ceeRankedSeries, "botEntry").length).toBe(16);
    expect(metaOf(ceeRankedSeries, "botEntry").notNull).toBe(false);
    expect(scriptColumnsOf("cee_ranked_series")).toContain("`bot_entry` varchar(16)");
  });

  test("bot_strength_rating 是可空 double，脚本与 schema 都有", () => {
    expect(metaOf(ceeRankedSeriesPlayer, "botStrengthRating").columnType).toBe("MySqlDouble");
    expect(metaOf(ceeRankedSeriesPlayer, "botStrengthRating").notNull).toBe(false);
    expect(scriptColumnsOf("cee_ranked_series_player")).toContain("`bot_strength_rating` double");
  });
});
