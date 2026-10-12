# 数据库

涉及持久化表结构、迁移、连接配置或数据导入时查阅。账号、云同步、后台与对局记录的业务规则见各自专项文档；本文只维护存储层。

## 1. 定位与边界

- 托管库为 TiDB Serverless（MySQL 协议），ORM 为 Drizzle（`drizzle-orm/mysql2`）。连接串来自 `DATABASE_URL`，必须包含库名（当前为 `bakagame`）。
- 数据库承载账号、用户设置、词库、对局记录、审计、反馈与访问统计。**房间与对局实时状态仍为纯内存**，不读写数据库。
- 游客游玩不依赖数据库：`/readyz` 只看停机标志，不检查数据库；数据库故障时账号相关功能报错，游戏照常。
- 生产（`DEPLOYMENT_ENVIRONMENT=production`）缺 `DATABASE_URL` 时 `createServer` 抛 `CONFIG_ERROR` 拒绝启动。本地开发与隔离测试不配置时，词对不落库，账号相关功能整体关闭；隔离服务（`scripts/IsolatedServer.ts`）显式清空该变量。

## 2. 连接

唯一入口 `Server/src/infrastructure/db/Database.ts` 的 `createDatabase(url)`：

- 强制 TLS（`minVersion: TLSv1.2`、校验证书），不提供明文开关。
- `timezone: "Z"`：所有时间列按 UTC 读写。业务上的“自然日”统计按北京时间切日，在写入前换算成 `YYYY-MM-DD` 字符串，不依赖库端时区。
- 连接池上限 5、空闲回收 60 秒、开启 keep-alive，适配免费额度。
- 创建即开始应用迁移，结果暴露为 `ready`。所有仓储写入先 `await database.ready`；迁移失败时 `Index.ts` 记录错误日志，相关功能持续报错，不阻断启动。
- 停机时随 `disposeResources` 关闭连接池；仓储自身的未完成写入由 `drainPendingWrites` 阶段排空。

## 3. Schema 与迁移

- 表结构唯一真相源：`Server/src/infrastructure/db/Schema.ts`。属性名即 Better Auth 字段名（适配器按属性名映射），列名蛇形。
- 时间列一律 `datetime(3)`，不用 `timestamp`（2038 溢出，远期封禁时间放不下）。
- 修改 schema 后在 `Server/` 执行 `bun run db:generate` 生成迁移（不连库），迁移文件 `Server/drizzle/` 进 Git；服务启动时自动应用。不手写或手改已发布的迁移 SQL。
- 词对表 `word_pair` 以 `(word_a, word_b)` 唯一，入库前经 `normalizeWordPair` 规范化并按字典序排列；重复提交累加 `use_count`、刷新 `last_used_at`。

## 4. 数据导入

旧版 `Server/storage/word-bank.json` 的一次性迁移：

```bash
cd Server
bun run db:import-word-bank            # 缺省读取 storage/word-bank.json
bun run db:import-word-bank <文件路径>
```

脚本读取 `DATABASE_URL`、先应用迁移，再以 `INSERT IGNORE` 分批写入；重复执行安全，不累加次数。格式错误的条目整体失败，不静默跳过；规范化后非法的词对计入跳过数。

## 5. 测试

- 单元与集成测试不连接真实数据库：服务以可选依赖注入仓储，未注入即不落库。
- 对真实 TiDB 的验证（迁移、写入、重复累加）属于一次性人工验收，结束后恢复测试改动的数据，不进入 CI。
