import { createRoom, GameKind, MIN_SEATS, RoomDiagnostics, RoomHandle } from "./Rooms";

/**
 * 一个发压分片：只负责「把 N 个房间跑起来并如实计数」，不做任何判定。
 *
 * 分片进程与目标进程严格分离，是为了让发压机自己的 CPU 不混进被测方指标 ——
 * 报告里的 `generator` 字段就是用来证明「瓶颈不在生成器侧」的。
 */

export interface WorkerOptions {
  wsUrl: string;
  game: GameKind;
  rooms: number;
  seats: number;
  pace: number;
  roomIdBase: number;
  namePrefix: string;
  /** 房间建立摊开的时间，避免所有连接同时握手。 */
  staggerMs: number;
  warmupMs: number;
  measureMs: number;
}

interface Counters {
  bytesSent: number;
  bytesReceived: number;
  framesSent: number;
  framesReceived: number;
  commandsSent: number;
  acks: number;
  errors: number;
  timeouts: number;
  /** 前置类错误码：驱动等一拍重发，不计入失败率。 */
  retries: number;
  /** 收尾窗口内被丢弃的应答：既不是成功也不算失败。 */
  ignored: number;
}

export interface WorkerResult {
  game: GameKind;
  rooms: number;
  roomsStarted: number;
  seats: number;
  players: number;
  pace: number;
  windowStartAt: number;
  windowEndAt: number;
  windowMs: number;
  counters: Counters;
  latency: { count: number, p50: number, p95: number, p99: number, max: number };
  samples: number[];
  failures: Record<string, number>;
  notes: string[];
  generator: { cpuUserMs: number, cpuSystemMs: number, cores: number, rssBytes: number, heapUsedBytes: number };
}

const emptyCounters = (): Counters => ({
  bytesSent: 0, bytesReceived: 0, framesSent: 0, framesReceived: 0,
  commandsSent: 0, acks: 0, errors: 0, timeouts: 0, retries: 0, ignored: 0,
});

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

const parseArgs = (argv: string[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) continue;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) out[token.slice(2)] = "true";
    else { out[token.slice(2)] = next; index += 1; }
  }
  return out;
};

const percentile = (sorted: readonly number[], ratio: number): number =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.ceil(ratio * sorted.length) - 1)]!;

const summarize = (samples: number[]): WorkerResult["latency"] => {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: Math.round(percentile(sorted, 0.5) * 10) / 10,
    p95: Math.round(percentile(sorted, 0.95) * 10) / 10,
    p99: Math.round(percentile(sorted, 0.99) * 10) / 10,
    max: Math.round((sorted[sorted.length - 1] ?? 0) * 10) / 10,
  };
};

/** 蓄水池抽样把跨连接样本压到固定条数，保证一行 stdout 也放得下。 */
const reservoir = (values: number[], size: number): number[] => {
  if (values.length <= size) return values;
  const out = values.slice(0, size);
  for (let index = size; index < values.length; index += 1) {
    const target = Math.floor(Math.random() * (index + 1));
    if (target < size) out[target] = values[index]!;
  }
  return out;
};

const collect = (handles: RoomHandle[]): { counters: Counters, samples: number[] } => {
  const counters = emptyCounters();
  const samples: number[] = [];
  for (const handle of handles) {
    for (const socket of handle.sockets) {
      counters.bytesSent += socket.stats.bytesSent;
      counters.bytesReceived += socket.stats.bytesReceived;
      counters.framesSent += socket.stats.framesSent;
      counters.framesReceived += socket.stats.framesReceived;
      counters.commandsSent += socket.stats.commandsSent;
      counters.acks += socket.stats.acks;
      counters.errors += socket.stats.errors;
      counters.timeouts += socket.stats.timeouts;
      counters.retries += socket.stats.retries;
      counters.ignored += socket.stats.ignored;
      samples.push(...socket.latencySamples);
    }
  }
  return { counters, samples };
};

export async function runWorker(options: WorkerOptions): Promise<WorkerResult> {
  const seats = Math.max(MIN_SEATS[options.game], options.seats);
  const diagnostics: RoomDiagnostics = { failures: new Map(), notes: [] };
  const cpuBase = process.cpuUsage();

  const handles = Array.from({ length: options.rooms }, (_, index) =>
    createRoom({
      game: options.game,
      wsUrl: options.wsUrl,
      roomId: String(options.roomIdBase + index).padStart(4, "0"),
      // 用户名在房间内查重，房名又被截到 32 字：直接用四位房号做前缀，保证跨房间不撞名。
      name: `LT-${options.game}-${String(options.roomIdBase + index).padStart(4, "0")}`,
      seats,
      pace: options.pace,
      seed: (options.roomIdBase + index) * 2_654_435_761,
      diagnostics,
    }));

  let roomsStarted = 0;
  // 房间逐个铺开：同一刻建立几十个房间会把握手本身算进压力里。
  await Promise.all(handles.map(async (handle, index) => {
    await sleep(Math.round((options.staggerMs * index) / Math.max(1, handles.length)));
    try {
      await handle.start();
      roomsStarted += 1;
    } catch (error) {
      diagnostics.notes.push(`${handle.game}.start: ${String(error)}`);
      diagnostics.failures.set("ROOM_START", (diagnostics.failures.get("ROOM_START") ?? 0) + 1);
      await handle.stop().catch(() => {});
    }
  }));

  await sleep(options.warmupMs);
  for (const handle of handles) for (const socket of handle.sockets) socket.beginWindow();
  const windowStartAt = Date.now();
  await sleep(options.measureMs);
  const windowEndAt = Date.now();

  const { counters, samples } = collect(handles);
  await Promise.all(handles.map((handle) => handle.stop().catch(() => {})));

  const cpu = process.cpuUsage(cpuBase);
  const windowMs = windowEndAt - windowStartAt;
  const memory = process.memoryUsage();
  return {
    game: options.game,
    rooms: options.rooms,
    roomsStarted,
    seats,
    players: roomsStarted * seats,
    pace: options.pace,
    windowStartAt,
    windowEndAt,
    windowMs,
    counters,
    latency: summarize(samples),
    samples: reservoir(samples, 512).map((value) => Math.round(value * 10) / 10),
    failures: Object.fromEntries(diagnostics.failures),
    notes: diagnostics.notes.slice(0, 8),
    generator: {
      cpuUserMs: Math.round(cpu.user / 100) / 10,
      cpuSystemMs: Math.round(cpu.system / 100) / 10,
      cores: Math.round(((cpu.user + cpu.system) / 1_000 / Math.max(1, windowMs)) * 100) / 100,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
    },
  };
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const readNumber = (key: string, fallback: number): number => {
    const raw = args[key];
    if (raw === undefined) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  };
  const game = (args.game ?? "faker") as GameKind;
  const options: WorkerOptions = {
    wsUrl: args["ws-url"] ?? "ws://127.0.0.1:4850",
    game,
    rooms: readNumber("rooms", 1),
    seats: readNumber("seats", MIN_SEATS[game]),
    pace: readNumber("pace", 1),
    roomIdBase: readNumber("room-base", 2000),
    namePrefix: args["name-prefix"] ?? "LT",
    staggerMs: readNumber("stagger", 2_000),
    warmupMs: readNumber("warmup", 20_000),
    measureMs: readNumber("measure", 30_000),
  };
  const result = await runWorker(options);
  // 单行输出：主控按行前缀取结果，其余行走日志。
  process.stdout.write(`LT_RESULT ${JSON.stringify(result)}\n`);
  process.exit(0);
}
