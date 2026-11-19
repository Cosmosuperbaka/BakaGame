import { defineConfig } from "drizzle-kit";

// 仅供 `bun run db:push`：按 schema 直接建出一份空库或开发库的表结构。
// 已有数据的线上库不要用 push（它按差异直接改表，可能删列），改走 `db:oneoff` 一次性脚本，
// 见 Server/docs/Database.md。连接串与服务同一个 DATABASE_URL，托管库一律校验证书。
const url = new URL(process.env.DATABASE_URL ?? "mysql://localhost/bakagame");

export default defineConfig({
  dialect: "mysql",
  schema: "./src/infrastructure/db/Schema.ts",
  dbCredentials: {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ""),
    ssl: { rejectUnauthorized: true },
  },
});
