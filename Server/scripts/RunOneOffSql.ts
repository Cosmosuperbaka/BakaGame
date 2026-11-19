/**
 * 一次性表结构脚本的执行器：`bun run db:oneoff <脚本.sql> [--dry-run] [--yes]`。
 *
 * 表结构以 `src/infrastructure/db/Schema.ts` 为唯一来源，服务启动不改表。线上库要跟上
 * schema 变更时，把这次变更写成一份 SQL 脚本，用本命令在目标库上显式执行一次；
 * 所有环境都执行过之后删掉脚本，仓库里不累积迁移历史。规则见 `Server/docs/Database.md`。
 *
 * 语句按 `--> statement-breakpoint` 或行尾分号切分，逐条执行，任一条失败立即停止并报出序号——
 * MySQL 的 DDL 会隐式提交，没法整体回滚，所以停在哪一条必须清清楚楚。
 *
 * 目标库来自环境里的 DATABASE_URL（Bun 会自动读 `.env`），操作者很容易忘了当前指向哪里，
 * 而 DDL 不可回滚，所以真正执行前一定先回显「主机:端口/库名」（不含账号口令）：
 * 交互终端要求键入库名确认，非交互环境（CI、管道）必须显式带 `--yes`。`--dry-run` 不连库，不受影响。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
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

/** 只取主机、端口与库名；账号与口令永远不出现在输出里，解析失败时也不回显原串。 */
export const describeTarget = (databaseUrl: string): { label: string; database: string } => {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL 不是合法的连接地址（出于安全不回显其内容）");
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!parsed.hostname || !database) throw new Error("DATABASE_URL 缺少主机或库名");
  return { label: `${parsed.hostname}:${parsed.port || "3306"}/${database}`, database };
};

export type Confirmation = "skip" | "prompt" | "refuse";

/** 非交互环境不能弹提示，只认显式的 `--yes`；交互终端即使带了 `--yes` 也照常放行。 */
export const confirmationMode = (args: string[], interactive: boolean): Confirmation => {
  if (args.includes("--yes")) return "skip";
  return interactive ? "prompt" : "refuse";
};

const confirmTarget = async (args: string[], target: { label: string; database: string }) => {
  console.log(`目标库：${target.label}`);
  const mode = confirmationMode(args, Boolean(process.stdin.isTTY && process.stdout.isTTY));
  if (mode === "skip") return;
  if (mode === "refuse")
    throw new Error(`非交互环境必须显式带 --yes 才会执行；目标库：${target.label}`);
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await reader.question(`DDL 不可回滚。键入库名「${target.database}」确认执行：`);
    if (answer.trim() !== target.database) throw new Error("库名不符，已取消，未执行任何语句");
  } finally {
    reader.close();
  }
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const file = args.find((arg) => !arg.startsWith("--"));
  const dryRun = args.includes("--dry-run");
  if (!file) throw new Error("用法：bun run db:oneoff <脚本.sql> [--dry-run] [--yes]");
  const statements = splitStatements(readFileSync(resolve(file), "utf8"));
  if (statements.length === 0) throw new Error(`脚本里没有可执行的语句：${file}`);
  if (dryRun) {
    statements.forEach((statement, index) => console.log(`-- [${index + 1}]\n${statement};\n`));
    return;
  }
  const url = Bun.env.DATABASE_URL;
  if (!url) throw new Error("请先设置 DATABASE_URL");
  await confirmTarget(args, describeTarget(url));
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
