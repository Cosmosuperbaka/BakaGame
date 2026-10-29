/**
 * 一次性表结构脚本的执行器：`bun run db:oneoff <脚本.sql> [--dry-run]`。
 *
 * 表结构以 `src/infrastructure/db/Schema.ts` 为唯一来源，服务启动不改表。线上库要跟上
 * schema 变更时，把这次变更写成一份 SQL 脚本，用本命令在目标库上显式执行一次；
 * 所有环境都执行过之后删掉脚本，仓库里不累积迁移历史。规则见 `Server/docs/Database.md`。
 *
 * 语句按 `--> statement-breakpoint` 或行尾分号切分，逐条执行，任一条失败立即停止并报出序号——
 * MySQL 的 DDL 会隐式提交，没法整体回滚，所以停在哪一条必须清清楚楚。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/infrastructure/db/Database";

export const splitStatements = (text: string): string[] => {
  const withoutComments = text
    .split(/\r?\n/)
    .filter((line) => !/^\s*--(?!>)/.test(line))
    .join("\n");
  const chunks = withoutComments.includes("--> statement-breakpoint")
    ? withoutComments.split("--> statement-breakpoint")
    : withoutComments.split(/;\s*(?:\n|$)/);
  return chunks.map((chunk) => chunk.trim().replace(/;$/, "").trim()).filter(Boolean);
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const file = args.find((arg) => !arg.startsWith("--"));
  const dryRun = args.includes("--dry-run");
  if (!file) throw new Error("用法：bun run db:oneoff <脚本.sql> [--dry-run]");
  const statements = splitStatements(readFileSync(resolve(file), "utf8"));
  if (statements.length === 0) throw new Error(`脚本里没有可执行的语句：${file}`);
  if (dryRun) {
    statements.forEach((statement, index) => console.log(`-- [${index + 1}]\n${statement};\n`));
    return;
  }
  const url = Bun.env.DATABASE_URL;
  if (!url) throw new Error("请先设置 DATABASE_URL");
  const database = createDatabase(url);
  try {
    await database.ready;
    for (const [index, statement] of statements.entries()) {
      try {
        await database.db.execute(sql.raw(statement));
        console.log(`[${index + 1}/${statements.length}] 完成`);
      } catch (error) {
        throw new Error(`第 ${index + 1} 条语句失败，此前的语句已生效：\n${statement}`, {
          cause: error,
        });
      }
    }
    console.log("全部执行完成；所有环境都执行过后删除这份脚本。");
  } finally {
    await database.close();
  }
};

if (import.meta.main) await main();
