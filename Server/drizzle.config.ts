import { defineConfig } from "drizzle-kit";

// 仅供 `bun run db:generate` 从 schema 生成迁移；生成过程不连接数据库。
// 迁移由服务启动时自动应用（见 src/infrastructure/db/Database.ts）。
export default defineConfig({
  dialect: "mysql",
  schema: "./src/infrastructure/db/Schema.ts",
  out: "./drizzle",
});
