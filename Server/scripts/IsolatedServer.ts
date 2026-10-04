import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";

/** 不继承账号、代理和遥测；仅保留启动运行时所必需的 OS 字段。 */
export function isolatedEnvironment(source: Record<string, string | undefined>, port: number, directory: string, owner: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE"]) {
    if (source[key] !== undefined) env[key] = source[key]!;
  }
  return Object.assign(env, {
    NODE_ENV: "test", SERVER_PORT: String(port), SERVER_LISTEN_HOST: "127.0.0.1",
    SERVER_URL: `http://127.0.0.1:${port}`, CLIENT_URL: "http://localhost:5173",
    WORD_BANK_PATH: path.join(directory, "words.sqlite"),
    BANGUMI_ENRICHMENT_PATH: path.join(directory, "enrichment.sqlite"),
    BANGUMI_API_URL: "http://127.0.0.1:9", BANGUMI_IMAGE_URL: "http://127.0.0.1:9",
    CCB_ORIGINAL_SERVER_URL: "", CCB_ORIGINAL_AES_SECRET: "", MEILISEARCH_KEY: "", ENABLE_GENERAL_UNBLOCK: "false",
    SENTRY_DSN: "", SENTRY_AUTH_TOKEN: "", NETEASE_COOKIE: "",
    OTEL_EXPORTER_OTLP_ENDPOINT: "", OTEL_EXPORTER_OTLP_HEADERS: "",
    BAKAGAME_TEST_OWNER: owner,
  });
}

export async function availablePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

export async function startIsolatedServer(port: number, entry = path.resolve(import.meta.dir, "../src/Index.ts")) {
  const directory = await mkdtemp(path.join(tmpdir(), "bakagame-isolated-"));
  const owner = crypto.randomUUID();
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([process.execPath, "--no-env-file", "--preload", path.join(import.meta.dir, "fixtures/IsolatedPreload.ts"), entry], {
      cwd: path.resolve(import.meta.dir, ".."),
      env: isolatedEnvironment(process.env, port, directory, owner), stdout: "ignore", stderr: "pipe",
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  // 有界环形尾日志：持续排空管道，避免日志填满导致启动阻塞。
  let stderr = "";
  const drain = (async () => {
    const reader = (child.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      stderr = (stderr + decoder.decode(result.value)).slice(-4096);
    }
  })();
  const exited = child.exited.then(code => { throw new Error(`自有服务退出 (${code})\n${stderr}`); });
  // 退出可发生于调用 race 之前；立即登记拒绝处理，实际失败仍由 race 抛出。
  void exited.catch(() => {});
  let stopping: Promise<void> | undefined;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    directory,
    async run<T>(work: Promise<T>): Promise<T> {
      if (child.exitCode !== null) throw new Error(`自有服务已退出 (${child.exitCode})\n${stderr}`);
      const result = await Promise.race([work, exited]);
      if (child.exitCode !== null) throw new Error(`自有服务已退出 (${child.exitCode})\n${stderr}`);
      return result;
    },
    async ready() {
      const abort = new AbortController();
      const deadline = Date.now() + 15_000;
      try { await this.run((async () => {
        while (!abort.signal.aborted && Date.now() < deadline) {
          try {
            const proof = await fetch(`${this.baseUrl}/__bakagame_test_owner`, { signal: AbortSignal.timeout(500) });
            if (!proof.ok || await proof.text() !== owner) throw new Error("探针并非自有子进程");
            const response = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(500) });
            if (response.ok && (await response.json() as { status?: string }).status === "ok") return;
          } catch (error) {
            if (error instanceof Error && error.message === "探针并非自有子进程") throw error;
          }
          await Bun.sleep(100);
        }
        throw new Error(`隔离服务探活超时\n${stderr}`);
      })()); } finally { abort.abort(); }
    },
    stop(): Promise<void> {
      stopping ??= (async () => {
        if (child.exitCode === null) child.kill("SIGTERM");
        const timer = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 3_000);
        try { await child.exited; } finally { clearTimeout(timer); }
        await drain;
        await rm(directory, { recursive: true, force: true });
      })();
      return stopping;
    },
  };
}

// Playwright 专用启动入口；不复用普通业务实例，临时数据随生命周期销毁。
if (import.meta.main) {
  const server = await startIsolatedServer(4850);
  const shutdown = async () => { await server.stop(); process.exit(0); };
  process.once("SIGTERM", () => { void shutdown(); });
  process.once("SIGINT", () => { void shutdown(); });
  try {
    await server.ready();
    await server.run(new Promise<never>(() => {}));
  } finally { await server.stop(); }
}
