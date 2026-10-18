import http from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { availablePort, isolatedEnvironment } from "../IsolatedServer";
import { GameKind, MIN_SEATS } from "./Rooms";
import type { WorkerResult } from "./Worker";

/**
 * 压测主控：拉起隔离目标进程，按混合比例派生发压分片，逐步加压直到自然饱和。
 *
 * 目标进程只跑真实的 `createApp` + 三个真实游戏服务，数据源换桩，且用 E2E 同款
 * 出口守卫 preload 启动 —— 任何误打上游或外部网络的代码会当场抛错，测到的 CPU 与
 * 扇出全部属于服务端自身。发压分片是独立进程，因此报告里的 `generator` 可以自证
 * 「瓶颈不在生成器」。
 */

const GAMES: readonly GameKind[] = ["faker", "song", "cee"];
/** 与 `test/NetworkCapacity.test.ts` 同口径：帧头与 TCP/TLS 线路开销。 */
const TRANSPORT_OVERHEAD_RATIO = 1.15;

export interface StepRecord {
  index: number;
  players: number;
  pace: number;
  allocation: { game: GameKind; rooms: number; seats: number; players: number }[];
  roomsStarted: number;
  livePlayers: number;
  liveConnections: number;
  windowMs: number;
  commandsPerSecond: number;
  errorsPerSecond: number;
  errorRate: number;
  /** 前置类错误码的重发次数：正常节奏下应当接近 0，暴涨说明驱动或服务端跟不上了。 */
  retries: number;
  egressMbps: number;
  ingressMbps: number;
  wireMbps: number;
  bytesPerPlayerSecond: number;
  framesPerSecond: number;
  latency: { p50: number; p95: number; p99: number; max: number; count: number };
  target: {
    cores: number;
    rssMb: number;
    heapMb: number;
    lagP50Ms: number;
    lagP95Ms: number;
    lagMaxMs: number;
    samples: number;
  };
  generator: { cores: number; rssMb: number };
  failures: Record<string, number>;
  notes: string[];
  saturated: string | null;
}

interface StepOutcome {
  record: StepRecord;
  results: WorkerResult[];
}

interface RunConfig {
  mode: "ramp" | "cap" | "fat";
  label: string;
  /** 报告上的机器名：同一整套数字混了机器就必须能看出来自哪台。 */
  machine: string;
  /** 被测进程数。一个进程只有一个事件循环，跨核只能靠多进程分片。 */
  shards: number;
  mix: Record<GameKind, number>;
  seats: Record<GameKind, number>;
  pace: number;
  players: number;
  growth: number;
  maxPlayers: number;
  maxSteps: number;
  warmupMs: number;
  measureMs: number;
  playersPerWorker: number;
  maxWorkers: number;
  mbps: number;
  paceSweep: number[];
  fatSeats: number;
  cpusPerTarget: number;
  targetCpuset: string;
  workerCpuset: string;
  latencyP95BudgetMs: number;
  lagP95BudgetMs: number;
  errorRateBudget: number;
  outDir: string;
  keepTargetLogs: boolean;
  /** 让被测进程自带 CPU 采样：容量数字说明「撑不住在哪一维」，剖面说明「那一核的时间花在哪个函数」。 */
  cpuProf: boolean;
}

const parseFlags = (argv: string[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) continue;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) out[token.slice(2)] = "true";
    else {
      out[token.slice(2)] = next;
      index += 1;
    }
  }
  return out;
};

const num = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
};

/** `faker=34,song=33,cee=33` → 归一化比例；缺省项为 0。 */
const parseRatioMap = (
  raw: string | undefined,
  fallback: Record<GameKind, number>
): Record<GameKind, number> => {
  if (!raw) return fallback;
  const out: Record<GameKind, number> = { faker: 0, song: 0, cee: 0 };
  for (const part of raw.split(",")) {
    const [key, value] = part.split("=");
    if (!key || value === undefined) continue;
    const game = key.trim() as GameKind;
    if (!GAMES.includes(game)) continue;
    out[game] = Math.max(0, Number(value) || 0);
  }
  const total = GAMES.reduce((sum, game) => sum + out[game], 0);
  if (total <= 0) return fallback;
  return { faker: out.faker / total, song: out.song / total, cee: out.cee / total };
};

const percentile = (sorted: readonly number[], ratio: number): number =>
  sorted.length === 0
    ? 0
    : sorted[Math.min(sorted.length - 1, Math.ceil(ratio * sorted.length) - 1)]!;

const quantiles = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: Math.round(percentile(sorted, 0.5) * 10) / 10,
    p95: Math.round(percentile(sorted, 0.95) * 10) / 10,
    p99: Math.round(percentile(sorted, 0.99) * 10) / 10,
    max: Math.round((sorted[sorted.length - 1] ?? 0) * 10) / 10,
  };
};

/** 走 node:http 而不是 fetch：本机代理变量会让回环请求出现假超时。 */
const httpJson = async <T>(url: string, timeoutMs = 1_500): Promise<T> =>
  await new Promise<T>((resolve, reject) => {
    const request = http.get(url, { agent: false, timeout: timeoutMs }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if ((response.statusCode ?? 500) >= 300)
          reject(new Error(`${url} -> ${response.statusCode} ${body.slice(0, 120)}`));
        else {
          try {
            resolve(JSON.parse(body) as T);
          } catch (error) {
            reject(new Error(`${url} 非法响应：${String(error)}`));
          }
        }
      });
      response.on("error", reject);
    });
    request.on("timeout", () => {
      request.destroy(new Error("超时"));
    });
    request.on("error", reject);
  });

interface MetricSample {
  at: number;
  cpuTotalUs: number;
  rssBytes: number;
  heapUsedBytes: number;
  lag: number[];
  faker: { roomCount: number; connectionCount: number; onlinePlayerCount: number };
  song: { roomCount: number; connectionCount: number; onlinePlayerCount: number };
  cee: { roomCount: number; connectionCount: number; onlinePlayerCount: number };
}

const toSample = (raw: Record<string, unknown>): MetricSample => ({
  at: Number(raw.at),
  cpuTotalUs: Number(raw.cpuUserUs) + Number(raw.cpuSystemUs),
  rssBytes: Number(raw.rssBytes),
  heapUsedBytes: Number(raw.heapUsedBytes),
  lag: Array.isArray(raw.lagSamples) ? (raw.lagSamples as number[]) : [],
  faker: raw.faker as MetricSample["faker"],
  song: raw.song as MetricSample["song"],
  cee: raw.cee as MetricSample["cee"],
});

const total = (sample: MetricSample, key: "roomCount" | "connectionCount" | "onlinePlayerCount") =>
  sample.faker[key] + sample.song[key] + sample.cee[key];

const mergeHealth = (
  parts: MetricSample[],
  key: "faker" | "song" | "cee"
): MetricSample["faker"] => ({
  roomCount: parts.reduce((sum, part) => sum + part[key].roomCount, 0),
  connectionCount: parts.reduce((sum, part) => sum + part[key].connectionCount, 0),
  onlinePlayerCount: parts.reduce((sum, part) => sum + part[key].onlinePlayerCount, 0),
});

/**
 * 多分片合成一条总读数：CPU、内存、房间数按分片相加，事件环延迟把各片样本并成一个池。
 * 延迟判定看的是合并池的 P95，也就是最差那片分片的体感——分片不会互相救场，一饱和全饱和。
 */
const mergeSamples = (parts: MetricSample[]): MetricSample => ({
  at: Math.min(...parts.map((part) => part.at)),
  cpuTotalUs: parts.reduce((sum, part) => sum + part.cpuTotalUs, 0),
  rssBytes: parts.reduce((sum, part) => sum + part.rssBytes, 0),
  heapUsedBytes: parts.reduce((sum, part) => sum + part.heapUsedBytes, 0),
  lag: parts.flatMap((part) => part.lag),
  faker: mergeHealth(parts, "faker"),
  song: mergeHealth(parts, "song"),
  cee: mergeHealth(parts, "cee"),
});

interface TargetHandle {
  wsUrl: string;
  metricsUrl: string;
  directory: string;
  port: number;
  metricsPort: number;
  stdout: string;
  stderr: string;
  stop(): Promise<void>;
}

const cpusetSize = (cpuset: string): number => {
  if (!cpuset) return 0;
  return cpuset.split(",").reduce((count, part) => {
    const range = part.trim().split("-");
    return count + (range.length === 2 ? Math.abs(Number(range[1]) - Number(range[0])) + 1 : 1);
  }, 0);
};

/** 启动被测进程：与 E2E 同一份环境隔离表 + 出口守卫 preload。 */
const bootTarget = async (config: RunConfig): Promise<TargetHandle> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bakagame-loadtest-"));
  const port = await availablePort();
  const metricsPort = await availablePort();
  const owner = crypto.randomUUID();
  const env = Object.assign(
    isolatedEnvironment(process.env as Record<string, string | undefined>, port, directory, owner),
    {
      LOADTEST_METRICS_PORT: String(metricsPort),
    }
  );
  const script = path.resolve(import.meta.dir, "Target.ts");
  const preload = path.resolve(import.meta.dir, "../fixtures/IsolatedPreload.ts");
  const runtime = [process.execPath, "--no-env-file", "--preload", preload, script];
  if (config.cpuProf) {
    // markdown 剖面是纯文本，能直接读；每个分片各写一份文件（名里带 pid），互不覆盖。
    const profileDir = path.join(config.outDir, "profile", config.label);
    if (process.platform === "win32") {
      // Windows 上被测进程只能靠信号终止，Bun 来不及 flush 剖面（目录留着但是空的），绑核也没有 taskset。
      console.log(`CPU 剖面在 Windows 不会落盘，本跳跳过：${profileDir}`);
    } else {
      await mkdir(profileDir, { recursive: true });
      runtime.splice(1, 0, "--cpu-prof-md", "--cpu-prof-dir", profileDir);
    }
  }
  const taskset =
    config.targetCpuset && process.platform !== "win32"
      ? ["taskset", "-c", config.targetCpuset]
      : [];
  const child = Bun.spawn([...taskset, ...runtime], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  let stdout = "";
  let stderr = "";
  const collect = async (stream: ReadableStream<Uint8Array> | null, sink: "stdout" | "stderr") => {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      // 两条流都要封顶：长测里服务端日志能到几十 MB，全部留在控制器内存里会先压垮压测进程。
      if (sink === "stdout")
        stdout = stdout.length < 262_144 ? stdout + text : stdout.slice(0, 131_072);
      else stderr = (stderr + text).slice(-8_192);
    }
  };
  void collect(child.stdout as ReadableStream<Uint8Array>, "stdout");
  void collect(child.stderr as ReadableStream<Uint8Array>, "stderr");

  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`被测进程启动失败 (${child.exitCode})\n${stderr}`);
    if (stdout.includes("READY target")) break;
    if (Date.now() > deadline) throw new Error(`被测进程握手超时\n${stderr}`);
    await Bun.sleep(100);
  }
  const metricsUrl = `http://127.0.0.1:${metricsPort}`;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`被测进程启动失败 (${child.exitCode})\n${stderr}`);
    try {
      await httpJson<Record<string, unknown>>(`${metricsUrl}/metrics?reset=1`);
      break;
    } catch (error) {
      if (Date.now() > deadline)
        throw new Error(`侧信道探活失败：${String(error)}\n${stderr}`, { cause: error });
      await Bun.sleep(200);
    }
  }

  return {
    wsUrl: `ws://127.0.0.1:${port}`,
    metricsUrl,
    directory,
    port,
    metricsPort,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    async stop() {
      if (child.exitCode === null) child.kill("SIGTERM");
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 5_000);
      try {
        await child.exited;
      } finally {
        clearTimeout(timer);
      }
      await rm(directory, { recursive: true, force: true });
    },
  };
};

/** 分片是各自独立的进程、端口与号段：一个事件循环打满之后，只能靠多开进程吃下一个核。 */
const bootFleet = async (config: RunConfig): Promise<TargetHandle[]> => {
  const targets: TargetHandle[] = [];
  // 逐个拉起而不是并发：端口是"先探空闲再占用"，并发拉起会互相抢同一个端口。
  for (let shard = 0; shard < config.shards; shard += 1) targets.push(await bootTarget(config));
  return targets;
};

interface WorkerSpec {
  game: GameKind;
  /** 这条发压分片连到第几个被测进程。 */
  shard: number;
  rooms: number;
  seats: number;
  roomIdBase: number;
  pace: number;
  staggerMs: number;
}

/** 房间号只允许四位数字：每个游戏占一段号段，跨游戏不撞号；跨步骤靠 `drainTarget` 清空上一步的房间。 */
const ROOM_BASE: Record<GameKind, number> = { faker: 2000, song: 4000, cee: 6000 };
const MAX_ROOMS_PER_GAME = 1_900;

const allocate = (players: number, config: RunConfig) =>
  GAMES.filter((game) => config.mix[game] > 0).map((game) => {
    const seats = Math.max(MIN_SEATS[game], Math.round(config.seats[game]));
    // 号段是每个进程各有一套的：分片越多，同一款游戏能同时开的房间上限越高。
    const rooms = Math.min(
      MAX_ROOMS_PER_GAME * config.shards,
      Math.max(1, Math.round((players * config.mix[game]) / seats))
    );
    return { game, seats, rooms, players: rooms * seats };
  });

const planWorkers = (allocation: ReturnType<typeof allocate>, config: RunConfig): WorkerSpec[] => {
  const specs: WorkerSpec[] = [];
  for (const unit of allocation) {
    for (let shard = 0; shard < config.shards; shard += 1) {
      const shardRooms =
        Math.floor(unit.rooms / config.shards) + (shard < unit.rooms % config.shards ? 1 : 0);
      if (shardRooms <= 0) continue;
      // 分片是各自独立的进程，各有各的号段：每片都从本游戏的起点重新排。
      let roomBase = ROOM_BASE[unit.game];
      const workers = Math.min(
        config.maxWorkers,
        Math.max(1, Math.ceil((shardRooms * unit.seats) / config.playersPerWorker)),
        shardRooms
      );
      for (let index = 0; index < workers; index += 1) {
        const rooms = Math.floor(shardRooms / workers) + (index < shardRooms % workers ? 1 : 0);
        if (rooms <= 0) continue;
        specs.push({
          game: unit.game,
          shard,
          rooms,
          seats: unit.seats,
          roomIdBase: roomBase,
          pace: config.pace,
          staggerMs: Math.min(6_000, Math.max(600, rooms * 300)),
        });
        roomBase += rooms;
      }
    }
  }
  return specs;
};

const spawnWorker = async (
  spec: WorkerSpec,
  target: TargetHandle,
  config: RunConfig
): Promise<WorkerResult | null> => {
  const script = path.resolve(import.meta.dir, "Worker.ts");
  const runtime = [
    process.execPath,
    "--no-env-file",
    script,
    "--ws-url",
    target.wsUrl,
    "--game",
    spec.game,
    "--rooms",
    String(spec.rooms),
    "--seats",
    String(spec.seats),
    "--pace",
    String(spec.pace),
    "--room-base",
    String(spec.roomIdBase),
    "--stagger",
    String(spec.staggerMs),
    "--warmup",
    String(config.warmupMs),
    "--measure",
    String(config.measureMs),
    "--name-prefix",
    `${config.label}-${spec.game}`,
  ];
  const taskset =
    config.workerCpuset && process.platform !== "win32"
      ? ["taskset", "-c", config.workerCpuset]
      : [];
  const child = Bun.spawn([...taskset, ...runtime], {
    cwd: path.resolve(import.meta.dir, "../.."),
    // 分片只需回环地址：把代理变量清掉，避免本机代理把 WS 握手绕一圈外网。
    env: Object.assign({}, process.env as Record<string, string>, {
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
    }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const read = async (stream: ReadableStream<Uint8Array>) => await new Response(stream).text();
  const [stdout, stderr, code] = await Promise.all([
    read(child.stdout as ReadableStream<Uint8Array>),
    read(child.stderr as ReadableStream<Uint8Array>),
    child.exited,
  ]);
  const line = stdout.split("\n").find((entry) => entry.startsWith("LT_RESULT "));
  if (!line) {
    console.warn(`分片 ${spec.game} 无结果（退出码 ${code}）：${stderr.slice(0, 300)}`);
    return null;
  }
  try {
    return JSON.parse(line.slice("LT_RESULT ".length)) as WorkerResult;
  } catch (error) {
    console.warn(`分片结果解析失败：${String(error)}`);
    return null;
  }
};

/** 采样器只在测量窗口内取数，逐步计算 CPU / 延迟 / 房间数；多分片时把各片读数合成一条总量。 */
class MetricPoller {
  private samples: MetricSample[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;

  constructor(
    private readonly targets: TargetHandle[],
    private readonly intervalMs = 250
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      if (this.busy) return;
      this.busy = true;
      // 任一分片答不上来就丢掉这一拍：CPU 与在线数都是相加口径，缺一片的读数会整条偏低。
      void Promise.all(
        this.targets.map(async (target) =>
          toSample(await httpJson<Record<string, unknown>>(`${target.metricsUrl}/metrics?reset=1`))
        )
      )
        .then((parts) => {
          this.samples.push(mergeSamples(parts));
          if (this.samples.length > 20_000) this.samples = this.samples.slice(-10_000);
        })
        .catch(() => {})
        .finally(() => {
          this.busy = false;
        });
    }, this.intervalMs);
  }

  take(from: number, to: number): MetricSample[] {
    const window = this.samples.filter((sample) => sample.at >= from && sample.at <= to);
    return window.length >= 2 ? window : this.samples.slice(-8);
  }

  prune(): void {
    this.samples = [];
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

/** 侧信道读数：连不上时抛出，交给调用方的超时边界处理。 */
const readMetrics = async (target: TargetHandle): Promise<MetricSample> =>
  toSample(await httpJson<Record<string, unknown>>(`${target.metricsUrl}/metrics`));

/** 等被测进程把上一步的房间清空；超时仍非零时把剩余数量交给调用方记录。 */
const drainTarget = async (
  target: TargetHandle,
  timeoutMs = 150_000
): Promise<{ waitedMs: number; roomsLeft: number }> => {
  const startedAt = performance.now();
  let rooms: number | null = null;
  for (;;) {
    // 读数失败当作还没清干净：上一步几千条连接正在关，侧信道会短暂答不上来，
    // 此时按 0 间房放行就会让下一步整批撞号。
    try {
      rooms = total(await readMetrics(target), "roomCount");
    } catch {
      /* 继续等，直到超时 */
    }
    if (rooms === 0) return { waitedMs: Math.round(performance.now() - startedAt), roomsLeft: 0 };
    if (performance.now() - startedAt >= timeoutMs) {
      return { waitedMs: Math.round(performance.now() - startedAt), roomsLeft: rooms ?? -1 };
    }
    await Bun.sleep(1_000);
  }
};

/** 每个分片都要各自清场：任何一片还留着上一步的房间，下一步那一片就会整批撞号。 */
const drainFleet = async (
  targets: TargetHandle[],
  timeoutMs = 150_000
): Promise<{ waitedMs: number; roomsLeft: number }> => {
  const settled = await Promise.all(targets.map((target) => drainTarget(target, timeoutMs)));
  return {
    waitedMs: Math.max(...settled.map((item) => item.waitedMs)),
    roomsLeft: settled.some((item) => item.roomsLeft < 0)
      ? -1
      : settled.reduce((sum, item) => sum + item.roomsLeft, 0),
  };
};

const runStep = async (
  index: number,
  players: number,
  pace: number,
  targets: TargetHandle[],
  poller: MetricPoller,
  config: RunConfig
): Promise<StepOutcome> => {
  const allocation = allocate(players, config);
  // 慢节奏下一局要跑一分多钟：25 秒窗口会整段落在低流量阶段，人均带宽被系统性低估，
  // 带宽二分就会收敛到噪声上。测量窗口至少覆盖一个完整回合周期（pace 1 → 90 秒）。
  const effective: RunConfig = {
    ...config,
    pace,
    measureMs: Math.max(config.measureMs, Math.round(90_000 / Math.max(0.25, pace))),
  };
  const specs = planWorkers(allocation, effective);
  poller.prune();

  // 上一步没关掉的空房仍然占着房间号（空房宽限 90 秒 + 房务 10 秒节拍）：撞号后只有一部分
  // 房间能开局，测到的吞吐就成了假的。连接掉光但房间还在时，光等连接不够，要等房间清零。
  // 每个玩家都发出过 room.leave 时这里几乎不等待，只有大房间数下收尾被截断才会真的等。
  const settled = await drainFleet(targets);

  const started = performance.now();
  const results = (
    await Promise.all(specs.map((spec) => spawnWorker(spec, targets[spec.shard]!, effective)))
  ).filter((result): result is WorkerResult => !!result);
  const elapsedMs = performance.now() - started;
  if (!results.length) throw new Error("所有发压分片都没有返回结果");

  const windowStart = Math.max(...results.map((result) => result.windowStartAt));
  const windowEnd = Math.min(...results.map((result) => result.windowEndAt));
  const windowMs = Math.max(1, windowEnd - windowStart);
  const samples = poller.take(windowStart, windowEnd);
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  // cpuTotalUs 是微秒、windowMs 是毫秒：核数 = µs / 1e6 / (windowMs / 1000) = µs / windowMs / 1000。
  const cores = Math.max(0, last.cpuTotalUs - first.cpuTotalUs) / windowMs / 1000;

  const sum = (pick: (result: WorkerResult) => number) =>
    results.reduce((acc, result) => acc + pick(result), 0);
  const bytesReceived = sum((r) => r.counters.bytesReceived);
  const bytesSent = sum((r) => r.counters.bytesSent);
  const commands = sum((r) => r.counters.commandsSent);
  const failures = results.reduce<Record<string, number>>((acc, result) => {
    for (const [code, count] of Object.entries(result.failures))
      acc[code] = (acc[code] ?? 0) + count;
    return acc;
  }, {});
  const errors = sum((r) => r.counters.errors + r.counters.timeouts);
  const retries = sum((r) => r.counters.retries);
  const livePlayers = Math.max(
    sum((r) => r.players),
    total(last, "onlinePlayerCount")
  );
  const seconds = windowMs / 1_000;
  const wireMbps =
    ((bytesSent + bytesReceived) * TRANSPORT_OVERHEAD_RATIO * 8) / seconds / 1_000_000;
  const lag = samples.flatMap((sample) => sample.lag);

  const record: StepRecord = {
    index,
    players,
    pace,
    allocation,
    roomsStarted: sum((r) => r.roomsStarted),
    livePlayers,
    liveConnections: total(last, "connectionCount"),
    windowMs,
    commandsPerSecond: Math.round((commands / seconds) * 100) / 100,
    errorsPerSecond: Math.round((errors / seconds) * 100) / 100,
    errorRate: commands > 0 ? Math.round((errors / commands) * 10_000) / 10_000 : 0,
    retries,
    egressMbps:
      Math.round(((bytesReceived * TRANSPORT_OVERHEAD_RATIO * 8) / seconds / 1_000_000) * 1000) /
      1000,
    ingressMbps:
      Math.round(((bytesSent * TRANSPORT_OVERHEAD_RATIO * 8) / seconds / 1_000_000) * 1000) / 1000,
    wireMbps: Math.round(wireMbps * 1000) / 1000,
    bytesPerPlayerSecond: Math.round(
      (bytesSent + bytesReceived) / Math.max(1, livePlayers) / seconds
    ),
    framesPerSecond: Math.round(sum((r) => r.counters.framesReceived) / seconds),
    latency: quantiles(results.flatMap((result) => result.samples)),
    target: {
      cores: Math.round(cores * 100) / 100,
      rssMb: Math.round(Math.max(...samples.map((sample) => sample.rssBytes)) / 1_048_576),
      heapMb: Math.round(Math.max(...samples.map((sample) => sample.heapUsedBytes)) / 1_048_576),
      lagP50Ms: quantiles(lag).p50,
      lagP95Ms: quantiles(lag).p95,
      lagMaxMs: quantiles(lag).max,
      samples: samples.length,
    },
    generator: {
      cores: Math.round(sum((r) => r.generator.cores) * 100) / 100,
      rssMb: Math.round(sum((r) => r.generator.rssBytes) / 1_048_576),
    },
    failures,
    notes: [...new Set(results.flatMap((result) => result.notes))].slice(0, 24),
    saturated: null,
  };

  if (settled.roomsLeft > 0)
    console.warn(`清场超时：仍有 ${settled.roomsLeft} 间房残留，本步可能撞号`);
  else if (settled.roomsLeft < 0) console.warn("清场超时：侧信道读不到房间数，本步可能撞号");
  else if (settled.waitedMs > 3_000)
    console.log(`清场等待 ${(settled.waitedMs / 1000).toFixed(1)} 秒`);
  record.notes.push(
    settled.roomsLeft === 0
      ? `清场等待 ${Math.round(settled.waitedMs / 1000)} 秒`
      : `清场超时：${settled.roomsLeft < 0 ? "侧信道无读数" : `残留 ${settled.roomsLeft} 间房`}（等待 ${Math.round(settled.waitedMs / 1000)} 秒）`
  );

  const topFailures = Object.entries(record.failures)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([key, count]) => `${key}×${count}`)
    .join(" ");
  console.log(
    `step ${index}: players=${record.livePlayers} cmd/s=${record.commandsPerSecond} wire=${record.wireMbps}Mbps ` +
      `ackP95=${record.latency.p95}ms lagP95=${record.target.lagP95Ms}ms targetCPU=${record.target.cores}c genCPU=${record.generator.cores}c ` +
      `err=${(record.errorRate * 100).toFixed(2)}% retry=${record.retries} rooms=${record.roomsStarted}/${specs.reduce((n, s) => n + s.rooms, 0)} elapsed=${Math.round(elapsedMs / 1000)}s` +
      (topFailures ? ` fail=${topFailures}` : "")
  );
  return { record, results };
};

/** 第一个触发的维度就是「自然饱和」的答案。 */
const saturationReason = (
  record: StepRecord,
  previous: StepRecord | undefined,
  config: RunConfig
): string | null => {
  const roomsPlanned = record.allocation.reduce((sum, unit) => sum + unit.rooms, 0);
  const startedRatio = roomsPlanned > 0 ? record.roomsStarted / roomsPlanned : 0;
  if (startedRatio < 0.8) return "rooms";
  if (record.errorRate >= config.errorRateBudget) return "errors";
  if (record.latency.p95 >= config.latencyP95BudgetMs) return "ack-latency";
  if (record.target.lagP95Ms >= config.lagP95BudgetMs) return "event-loop";
  if (
    config.cpusPerTarget > 0 &&
    record.target.cores / Math.max(1, config.shards) >= config.cpusPerTarget * 0.9
  )
    return "cpu";
  if (previous) {
    const grew = record.players >= previous.players * 1.15;
    const flat = record.commandsPerSecond <= previous.commandsPerSecond * 1.03;
    const bytesFlat = record.wireMbps <= previous.wireMbps * 1.03;
    if (grew && flat && bytesFlat) return "plateau";
  }
  return null;
};

const buildConfig = (args: Record<string, string>): RunConfig => {
  const shards = Math.max(1, Math.round(num(args.shards, 1)));
  // 绑核集合是被测那一侧全部进程共用的：8 核 4 分片 = 每片 2 核，CPU 触顶判定要按每片算。
  const cpusPerTarget = cpusetSize(args["target-cpuset"] ?? "") / shards;
  const mode = (args.mode ?? "ramp") as RunConfig["mode"];
  const fatSeats = num(args["fat-seats"], 150);
  const defaultMix: Record<GameKind, number> =
    mode === "fat" ? { faker: 1, song: 0, cee: 0 } : { faker: 1 / 3, song: 1 / 3, cee: 1 / 3 };
  return {
    mode,
    label: args.label ?? (mode === "fat" ? "fat" : mode === "cap" ? "cap" : "ramp"),
    machine: args.machine ?? "",
    shards,
    mix: parseRatioMap(args.mix, defaultMix),
    seats: {
      faker: num(args["seats-faker"], mode === "fat" ? fatSeats : 8),
      song: num(args["seats-song"], mode === "fat" ? fatSeats : 6),
      cee: num(args["seats-cee"], mode === "fat" ? fatSeats : 6),
    },
    pace: num(args.pace, mode === "fat" ? 1.6 : 1),
    players: num(args.players, mode === "fat" ? 150 : mode === "cap" ? 48 : 48),
    growth: num(args.growth, 1.6),
    maxPlayers: num(args["max-players"], mode === "fat" ? 150 : 6_000),
    maxSteps: num(args["max-steps"], mode === "fat" ? 99 : 14),
    warmupMs: num(args.warmup, 15_000),
    measureMs: num(args.measure, 25_000),
    playersPerWorker: num(args["players-per-worker"], 96),
    maxWorkers: num(args["max-workers"], Math.max(1, Math.min(16, os.availableParallelism() - 2))),
    mbps: num(args.mbps, 6),
    paceSweep: (args["pace-sweep"] ?? "1,1.6,2.4,4")
      .split(",")
      .map((value) => Number(value))
      .filter((value) => value > 0),
    fatSeats: num(args["fat-seats"], 150),
    cpusPerTarget,
    targetCpuset: args["target-cpuset"] ?? "",
    workerCpuset: args["worker-cpuset"] ?? "",
    latencyP95BudgetMs: num(args["max-ack-p95"], 500),
    lagP95BudgetMs: num(args["max-lag-p95"], 100),
    errorRateBudget: num(args["max-error-rate"], 0.01),
    outDir: args.out ?? path.resolve(import.meta.dir, "../../tasks/loadtest"),
    keepTargetLogs: args["keep-target-logs"] === "true",
    cpuProf: args["cpu-prof"] === "true",
  };
};

const runRamp = async (
  targets: TargetHandle[],
  poller: MetricPoller,
  config: RunConfig
): Promise<{ steps: StepRecord[]; stopReason: string }> => {
  const steps: StepRecord[] = [];
  let players = config.players;
  let stopReason = "max-steps";
  for (let index = 1; index <= config.maxSteps; index += 1) {
    if (players > config.maxPlayers) {
      stopReason = "max-players";
      break;
    }
    const outcome = await runStep(index, players, config.pace, targets, poller, config);
    outcome.record.saturated = saturationReason(outcome.record, steps[steps.length - 1], config);
    steps.push(outcome.record);
    if (outcome.record.saturated) {
      stopReason = outcome.record.saturated;
      break;
    }
    players = Math.round(players * config.growth);
  }
  return { steps, stopReason };
};

/** 还没撞墙时按实测人均带宽直接外推下一跳（留 8% 余量），比固定倍率省一半轮次。 */
const projectPlayers = (players: number, wireMbps: number, config: RunConfig): number =>
  Math.min(
    config.maxPlayers,
    Math.ceil(players * (config.mbps / Math.max(0.001, wireMbps)) * 0.92)
  );

/** 闭环搜索：把带宽钉在 `--mbps` 之下，二分出此时的玩家数与其它硬件占用。 */
const runCap = async (
  targets: TargetHandle[],
  poller: MetricPoller,
  config: RunConfig
): Promise<{ steps: StepRecord[]; stopReason: string }> => {
  const steps: StepRecord[] = [];
  let lo = 0; // 实测带宽合规的最大玩家数
  let hi = Number.POSITIVE_INFINITY; // 实测带宽超限的最小玩家数
  let probe = config.players;
  let stopReason = "iterations";
  for (let iteration = 1; iteration <= config.maxSteps; iteration += 1) {
    if (probe > config.maxPlayers) {
      stopReason = "max-players";
      break;
    }
    const { record } = await runStep(iteration, probe, config.pace, targets, poller, config);
    record.saturated = "bandwidth-cap";
    steps.push(record);
    const planned = record.allocation.reduce((sum, unit) => sum + unit.rooms, 0);
    if (planned > 0 && record.roomsStarted / planned < 0.8) {
      // 开局失败多半是撞号之类的发压问题，不是容量信号：这一步不采信，同一玩家数再探一次。
      record.saturated = "rooms-invalid";
      record.notes.push("开局房间不足计划 80%，本步不计入二分");
      continue;
    }
    if (record.wireMbps > config.mbps) hi = probe;
    else lo = probe;
    if (Number.isFinite(hi)) {
      if (hi - lo <= Math.max(4, Math.round(lo * 0.05))) {
        stopReason = "found";
        break;
      }
      probe = Math.floor((lo + hi) / 2);
    } else probe = projectPlayers(probe, record.wireMbps, config);
  }
  return { steps, stopReason };
};

const runFat = async (
  targets: TargetHandle[],
  poller: MetricPoller,
  config: RunConfig
): Promise<{ steps: StepRecord[]; stopReason: string }> => {
  const steps: StepRecord[] = [];
  for (const pace of config.paceSweep) {
    const outcome = await runStep(steps.length + 1, config.fatSeats, pace, targets, poller, {
      ...config,
      pace,
    });
    outcome.record.saturated = saturationReason(outcome.record, steps[steps.length - 1], config);
    steps.push(outcome.record);
    if (outcome.record.saturated) return { steps, stopReason: outcome.record.saturated };
  }
  return { steps, stopReason: "pace-sweep" };
};

interface RunMeta {
  commit: string;
  dirty: boolean;
}

/** 被测代码的版本必须跟着报告一起留下：同一台机器换一次提交，数字就能差一倍。 */
const readRunMeta = async (): Promise<RunMeta> => {
  const run = async (args: string[]): Promise<string> => {
    const proc = Bun.spawn(["git", ...args], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return proc.exitCode === 0 ? text.trim() : "";
  };
  const commit = await run(["rev-parse", "--short", "HEAD"]);
  const status = await run([
    "status",
    "--porcelain",
    "--",
    "Server/src",
    "Server/scripts/loadtest",
  ]);
  return { commit: commit || "unknown", dirty: status.length > 0 };
};

const writeReport = async (
  config: RunConfig,
  targets: TargetHandle[],
  steps: StepRecord[],
  stopReason: string,
  startedAt: number,
  meta: RunMeta
) => {
  const best = steps.reduce<StepRecord | undefined>(
    (acc, step) => (!acc || step.commandsPerSecond > acc.commandsPerSecond ? step : acc),
    undefined
  );
  const compliant = steps.filter(
    (step) =>
      step.saturated !== "rooms-invalid" &&
      step.wireMbps <= config.mbps &&
      step.errorRate < config.errorRateBudget
  );
  const underCap = compliant.length ? compliant[compliant.length - 1]! : undefined;
  const doc = {
    schema: 1,
    kind: "bakagame-loadtest",
    mode: config.mode,
    label: config.label,
    startedAt,
    durationMs: Date.now() - startedAt,
    host: {
      machine: config.machine || os.hostname(),
      platform: `${os.platform()}-${os.arch()}`,
      release: os.release(),
      cpuModel: os.cpus()[0]?.model ?? "",
      logicalCpus: os.availableParallelism(),
      totalMemoryMb: Math.round(os.totalmem() / 1_048_576),
      node: process.version,
      bun: Bun.version,
    },
    config,
    source: meta,
    target: {
      shards: targets.length,
      ports: targets.map((item) => item.port),
      metricsPorts: targets.map((item) => item.metricsPort),
      wsUrls: targets.map((item) => item.wsUrl),
      directory: targets.map((item) => item.directory),
      cpuLimitCores: config.cpusPerTarget || null,
      stdout: config.keepTargetLogs ? targets.map((item) => item.stdout).join("\n") : undefined,
      stderrTail: targets.map((item) => item.stderr).join("\n"),
    },
    stopReason,
    headline: {
      saturatingDimension: stopReason,
      peakThroughput: best
        ? {
            players: best.livePlayers,
            commandsPerSecond: best.commandsPerSecond,
            wireMbps: best.wireMbps,
            targetCores: best.target.cores,
            ackP95Ms: best.latency.p95,
          }
        : null,
      underBandwidthCap:
        config.mode === "cap" && underCap
          ? {
              mbpsCap: config.mbps,
              players: underCap.livePlayers,
              commandsPerSecond: underCap.commandsPerSecond,
              wireMbps: underCap.wireMbps,
              targetCores: underCap.target.cores,
              targetRssMb: underCap.target.rssMb,
              ackP95Ms: underCap.latency.p95,
            }
          : null,
    },
    steps,
  };
  await mkdir(config.outDir, { recursive: true });
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(config.outDir, `${config.label}-${config.mode}-${stamp}.json`);
  await writeFile(file, JSON.stringify(doc, null, 2), "utf8");
  console.log(`报告：${file}`);
  return { doc, file };
};

const main = async () => {
  const args = parseFlags(process.argv.slice(2));
  const config = buildConfig(args);
  const startedAt = Date.now();
  const meta = await readRunMeta();
  console.log(
    `模式=${config.mode} 标签=${config.label} 混合=${GAMES.map((g) => `${g}:${(config.mix[g] * 100).toFixed(0)}%`).join(" ")} ` +
      `座位=${GAMES.map((g) => `${g}:${config.seats[g]}`).join(" ")} 节奏=${config.pace} 测量=${config.measureMs}ms ` +
      `分片=${config.shards} 源码=${meta.commit}${meta.dirty ? "(有未提交改动)" : ""}`
  );

  const targets = await bootFleet(config);
  const poller = new MetricPoller(targets);
  poller.start();
  console.log(
    `被测进程就绪 ${targets.length} 片：${targets.map((target) => target.wsUrl).join(" ")}` +
      `（指标 ${targets.map((target) => `${target.metricsPort}/metrics`).join(" ")}）`
  );
  try {
    const { steps, stopReason } =
      config.mode === "cap"
        ? await runCap(targets, poller, config)
        : config.mode === "fat"
          ? await runFat(targets, poller, config)
          : await runRamp(targets, poller, config);
    const { doc } = await writeReport(config, targets, steps, stopReason, startedAt, meta);
    console.log(`饱和判定：${doc.headline.saturatingDimension}`);
  } finally {
    poller.stop();
    await Promise.all(targets.map((target) => target.stop()));
    console.log("被测进程与临时目录已清理");
  }
};

if (import.meta.main) await main();
