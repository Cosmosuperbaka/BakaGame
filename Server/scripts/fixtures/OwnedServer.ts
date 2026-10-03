// 合成进程，只证明启动/探活所有权和出口隔离，不冒充正式业务验证。
Bun.serve({ hostname: "127.0.0.1", port: Number(Bun.env.SERVER_PORT), fetch: () => Response.json({ status: "ok" }) });
