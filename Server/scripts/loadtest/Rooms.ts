import { PHASE_RESULT_DISPLAY_MS } from "../../src/config/Constants";
import { RETRYABLE_CODES, CEE_STATE_EVENTS, GameSocket, ROOM_STATE_EVENTS, SONG_STATE_EVENTS } from "./Socket";
import type { CommandResult } from "./Socket";

/**
 * 三个游戏的房间驱动器：走真实 WS 协议序列，按「人类房间」的节奏推进。
 *
 * `pace` 是所有思考时间的除数：pace=1 是典型人类房间（一轮描述摊 40 s），
 * pace=24 大致等于 `test/NetworkCapacity.test.ts` 里每秒 12 次房间变化的压力模型。
 * 用它把「并发玩家承载量」与「指令吞吐上限」两个问题分开测。
 *
 * 所有指令都先读服务端状态再发：真实的客户端不会在同伴没描述完时就点「下一环」，
 * 驱动器照同样的前置条件闸门，否则测到的只是自己造出来的非法请求。
 */

export type GameKind = "faker" | "song" | "cee";

export interface RoomDiagnostics {
  failures: Map<string, number>;
  notes: string[];
}

export interface RoomOptions {
  game: GameKind;
  wsUrl: string;
  roomId: string;
  name: string;
  /** 房间内的连接数：谁是卧底为「参与者 + 1 名出题人」，另外两款为在线玩家数。 */
  seats: number;
  pace: number;
  seed: number;
  diagnostics: RoomDiagnostics;
}

export interface RoomHandle {
  game: GameKind;
  sockets: GameSocket[];
  stop(): Promise<void>;
}

const PACE = {
  faker: { ready: 1_200, describe: 40_000, vote: 24_000, over: 1_700, chat: 30_000, tick: 250 },
  song: { choose: 2_000, submit: 6_000, audio: 5_000, guess1: 15_000, guess2: 24_000, next: 6_000, chat: 40_000, tick: 250 },
  cee: { ready: 1_200, choose: 2_000, answer: 8_000, firstGuess: 18_000, guessStep: 10_000, next: 8_000, chat: 40_000, tick: 250 },
} as const;

const WORD_PAIRS: [string, string][] = [
  ["苹果", "香蕉"], ["海豚", "鲨鱼"], ["高铁", "地铁"], ["钢琴", "吉他"], ["医生", "护士"],
  ["作家", "编辑"], ["蜜蜂", "蝴蝶"], ["图书馆", "档案馆"], ["咖啡", "奶茶"], ["风筝", "气球"],
];
const DESCRIPTIONS = [
  "它是一种常见的水果", "早上经常会见到", "让人想到下雨天", "它比看起来更吵", "我昨天才碰过它",
  "它有一个不太好的外号", "小时候我很喜欢", "它其实挺贵的", "它不算安静", "我一般周末才用它",
];
const CHAT_TEXTS = [
  "这波我站他", "我觉得有内鬼", "刚才那句太明显了", "再来一局", "这题我会", "别跟着我投",
  "笑死", "我先猜一个试试", "这个 tag 太关键了", "歌词里唱过", "听前奏就出来了", "差一点就对了",
];

const createRandom = (seed: number) => {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state * 1_664_525 + 101_390_422) >>> 0;
    return state / 4_294_967_296;
  };
};

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** 可中断等待：停止信号到来时不必等完整段思考时间，否则收尾会拖成几十秒。 */
const interruptible = async (ms: number, stopped: () => boolean): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!stopped() && Date.now() < deadline) await sleep(Math.min(100, Math.max(5, deadline - Date.now())));
};

/** 把一批动作摊到 `total` 毫秒内执行，模拟房间内自然错落的操作。 */
const spread = async (total: number, count: number, stopped: () => boolean, action: (index: number) => Promise<unknown>): Promise<void> => {
  if (count <= 0) return;
  await Promise.all(Array.from({ length: count }, async (_, index) => {
    await interruptible(Math.round((total * (index + 1)) / count), stopped);
    if (stopped()) return;
    await action(index);
  }));
};

const waitFor = async (predicate: () => boolean, timeoutMs = 20_000, stepMs = 25): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return predicate();
};

interface Actor {
  socket: GameSocket;
  playerId: string;
  sessionToken: string;
}

abstract class BaseRoom implements RoomHandle {
  readonly game: GameKind;
  readonly sockets: GameSocket[] = [];
  protected readonly actors: Actor[] = [];
  protected stopped = false;
  protected running: Promise<void> | undefined;
  protected readonly random: () => number;
  protected readonly think: (key: string) => number;
  /** 房间内的等待都可被停止信号打断。 */
  protected readonly wait: (ms: number) => Promise<void>;
  /** 轮询到某个状态出现；停止信号到来时立即返回。 */
  protected readonly until: (predicate: () => boolean, timeoutMs?: number) => Promise<boolean>;

  constructor(protected readonly options: RoomOptions) {
    this.game = options.game;
    this.random = createRandom(options.seed);
    const table = PACE[options.game] as unknown as Record<string, number>;
    this.think = (key: string) => Math.max(5, Math.round((table[key] ?? 2_000) / Math.max(0.05, options.pace)));
    this.wait = (ms: number) => interruptible(ms, () => this.stopped);
    this.until = (predicate: () => boolean, timeoutMs = 20_000) => waitFor(() => this.stopped || predicate(), timeoutMs);
  }

  async start(): Promise<void> {
    await this.connect();
    this.running = this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    // 收尾有界：leave 发不出去也不能把整个步骤的计时拖长。
    await Promise.race([
      Promise.all(this.sockets.map((socket, index) => this.leave(socket, index))).then(() => Promise.all(this.sockets.map((socket) => socket.close()))),
      sleep(3_000),
    ]);
    this.sockets.forEach((socket) => void socket.close());
    await Promise.race([this.running, sleep(2_000)]);
  }

  protected abstract connect(): Promise<void>;
  protected abstract loop(): Promise<void>;
  protected abstract leave(socket: GameSocket, index: number): Promise<void>;
  /** 当前阶段读数：三个游戏把阶段放在快照的不同深度。 */
  protected abstract rawPhase(): string;

  /** 失败码连同命令名一起计数，否则报告里看不出是哪一条协议走不通。 */
  protected report(type: string, code: string): void {
    const key = `${type}:${code}`;
    this.options.diagnostics.failures.set(key, (this.options.diagnostics.failures.get(key) ?? 0) + 1);
    if (!this.options.diagnostics.notes.includes(key) && this.options.diagnostics.notes.length < 24) this.options.diagnostics.notes.push(key);
  }

  /**
   * 单条指令：连接断开与限流都在这里记账，前置类错误码留给 `attempt` 重发。
   * 是否计入失败率由 `GameSocket` 按同一张分类表决定，驱动器只负责记命令名。
   */
  protected async send(type: string, payload: unknown, actor: Actor, envelope?: { roomId?: string, sessionToken?: string }): Promise<CommandResult> {
    const result = await actor.socket.command(type, payload, envelope);
    if (!result.ok) {
      this.report(type, result.code);
      if (result.code === "RATE_LIMITED") await this.wait(1_100);
      if (result.code === "SOCKET_CLOSED" || result.code === "NOT_CONNECTED") this.stopped = true;
    }
    return result;
  }

  protected async run(type: string, payload: unknown, actor: Actor, envelope?: { roomId?: string, sessionToken?: string }): Promise<unknown | undefined> {
    const result = await this.send(type, payload, actor, envelope);
    return result.ok ? result.payload : undefined;
  }

  /** 带截止时间的重发：前置条件没到就等一拍再来，超过期限才认输。 */
  protected async attempt(type: string, payload: unknown, actor: Actor, envelope?: { roomId?: string, sessionToken?: string }, deadlineMs = 8_000): Promise<unknown | undefined> {
    const deadline = Date.now() + deadlineMs;
    for (;;) {
      if (this.stopped) return undefined;
      const result = await this.send(type, payload, actor, envelope);
      if (result.ok) return result.payload ?? {};
      if (this.stopped || !RETRYABLE_CODES.includes(result.code) || Date.now() > deadline) return undefined;
      await this.wait(Math.max(20, Math.round(200 / Math.max(1, this.options.pace))));
    }
  }

  /**
   * 阶段推进：确认自己确实停在 `expected` 阶段才发，发完再等服务端真的离开该阶段。
   * 不等这一步的话，下一轮读到的还是旧阶段，会连着多推一格。
   */
  protected async advanceFrom(expected: string, type: string, actor: Actor, envelope?: { roomId?: string, sessionToken?: string }, settleMs = 8_000): Promise<boolean> {
    if (this.stopped || this.rawPhase() !== expected) return false;
    if (await this.attempt(type, {}, actor, envelope) === undefined) return false;
    await this.until(() => this.rawPhase() !== expected, settleMs);
    return this.rawPhase() !== expected;
  }

  protected chat(actor: Actor, roomId: string, sessionToken?: string): Promise<unknown> {
    if (this.stopped) return Promise.resolve(undefined);
    const text = CHAT_TEXTS[Math.floor(this.random() * CHAT_TEXTS.length)]!;
    const type = this.game === "song" ? "song.chat.send" : this.game === "cee" ? "cee.chat.send" : "chat.send";
    return this.run(type, { text }, actor, { roomId, sessionToken });
  }
}

/**
 * 谁是卧底：`seats` 名在线玩家，其中 1 人出题（参与者 = seats-1，至少 4 人）。
 *
 * 阶段环 `waiting → assigningQuestioner → wordSubmission → description → voting →
 * feedback → night → feedback → …`，服务端没有任何自动推进，每一格都要出题人（首尾两格
 * 是房主）手动 `game.advancePhase`。每天投死一名平民，残局 2 人时服务端自动判卧底胜，
 * 回合长度因此可控、扇出量稳定。
 */
export class FakerRoom extends BaseRoom {
  private host!: Actor;
  private questioner!: Actor;
  private participants: Actor[] = [];
  private readySeats: Actor[] = [];

  protected async connect(): Promise<void> {
    for (let index = 0; index < this.options.seats; index += 1) {
      const socket = new GameSocket({
        url: `${this.options.wsUrl}/api/whoisfaker/ws`,
        syncCommand: "room.requestSync",
        syncEnvelope: () => ({ roomId: this.options.roomId }),
        stateEvents: ROOM_STATE_EVENTS,
      });
      await socket.open();
      this.sockets.push(socket);
      this.actors.push({ socket, playerId: "", sessionToken: "" });
    }
    const created = await this.run("room.create", {
      roomId: this.options.roomId,
      name: this.options.name,
      visibility: "public",
      allowSpectators: true,
      userName: `${this.options.name}-1`,
      roleConfig: { undercoverCount: 1, hasAngel: false, hasBlank: false },
    }, this.actors[0]!) as { playerId: string, sessionToken: string } | undefined;
    if (!created) throw new Error("room.create 失败");
    this.actors[0]!.playerId = created.playerId;
    this.actors[0]!.sessionToken = created.sessionToken;
    for (let index = 1; index < this.actors.length; index += 1) {
      const actor = this.actors[index]!;
      const joined = await this.run("room.join", { userName: `${this.options.name}-${index + 1}` }, actor, { roomId: this.options.roomId }) as
        { playerId: string, sessionToken: string } | undefined;
      if (!joined) throw new Error("room.join 失败");
      actor.playerId = joined.playerId;
      actor.sessionToken = joined.sessionToken;
    }
    this.host = this.actors[0]!;
    this.questioner = this.actors[this.actors.length - 1]!;
    this.participants = this.actors.slice(0, -1);
    // 房主不需要准备，但出题人也是房间成员：漏掉他会让 advancePhase 一直 NOT_ALL_READY。
    this.readySeats = [...this.participants.slice(1), this.questioner];
    await this.run("lobby.subscribeRooms", {}, this.host);
  }

  private snapshot(): Record<string, unknown> | undefined {
    return this.host.socket.state("room.snapshot");
  }

  protected rawPhase(): string {
    return (this.snapshot()?.status as { phase?: string } | undefined)?.phase ?? "";
  }

  private day(): number {
    return (this.snapshot()?.status as { day?: number } | undefined)?.day ?? 0;
  }

  private speechOrder(): string[] {
    return ((this.snapshot()?.status as { speechOrder?: string[] } | undefined)?.speechOrder ?? []) as string[];
  }

  private submittedSpeech(): string[] {
    return ((this.snapshot()?.status as { submittedSpeechPlayerIds?: string[] } | undefined)?.submittedSpeechPlayerIds ?? []) as string[];
  }

  private tieBreakStage(): string {
    return ((this.snapshot()?.status as { tieBreakStage?: string } | undefined)?.tieBreakStage ?? "") as string;
  }

  private tieBreakCandidates(): string[] {
    return ((this.snapshot()?.status as { tieBreakCandidateIds?: string[] } | undefined)?.tieBreakCandidateIds ?? []) as string[];
  }

  /** 快照里的存活参与者 id：`roundStatus` 只有 alive / dead / questioner / waiting 四类。 */
  private aliveIds(): string[] {
    const players = (this.snapshot()?.players as { id: string, roundStatus: string }[] | undefined) ?? [];
    return players.filter((player) => player.roundStatus === "alive").map((player) => player.id);
  }

  /** 出题人视角里当前存活的卧底；读不到就退回空，让本轮走集体弃票。 */
  private aliveUndercover(): string | undefined {
    const view = this.questioner.socket.state<{ questionerView?: { playerId: string, role: string, alive: boolean }[] }>("game.privateState")?.questionerView;
    return view?.find((item) => item.alive && item.role === "undercover")?.playerId;
  }

  private actorById(id: string): Actor | undefined {
    return this.actors.find((actor) => actor.playerId === id);
  }

  /** 还没点准备的人：快照里房主恒为已准备，所以这一句天然跳过 host。 */
  private async ensureReady(): Promise<void> {
    const players = (this.snapshot()?.players as { id: string, isReady: boolean, membership: string }[] | undefined) ?? [];
    const pending = players
      .filter((player) => player.membership === "active" && !player.isReady)
      .map((player) => this.actorById(player.id))
      .filter((actor): actor is Actor => !!actor);
    await spread(this.think("ready"), pending.length, () => this.stopped, async (index) => {
      await this.run("player.setReady", { ready: true }, pending[index]!);
    });
  }

  /** 平票第二轮：候选人没有投票资格，而且只能投给候选人。 */
  private inTieBreakVote(): boolean {
    return this.rawPhase() === "tieBreak" && this.tieBreakStage() === "vote";
  }

  /** 本轮该投给谁：白天全员集中到同一名非卧底，保证每天恰好淘汰一人且不制造平票。 */
  private voteTarget(voterId: string): string {
    const alive = this.aliveIds();
    if (!alive.length) return "abstain";
    const pool = this.inTieBreakVote()
      ? alive.filter((id) => this.tieBreakCandidates().includes(id))
      : alive.filter((id) => id !== this.aliveUndercover());
    const pick = pool[this.day() % pool.length] ?? pool[0];
    // 被选中的人改投弃票：弃票不计数，但仍算完成投票。
    return pick && pick !== voterId ? pick : "abstain";
  }

  /** 描述 / 平票 PK 共用一条指令：只补 `speechOrder` 里还没交过的人。 */
  private async fillSpeech(): Promise<void> {
    const todo = this.speechOrder().filter((id) => !this.submittedSpeech().includes(id));
    const actors = todo.map((id) => this.actorById(id)).filter((actor): actor is Actor => !!actor);
    await spread(this.think("describe"), actors.length, () => this.stopped, async (index) => {
      await this.run("game.submitDescription", { text: `${DESCRIPTIONS[(index + this.day()) % DESCRIPTIONS.length]}（${this.day()}-${index}）` }, actors[index]!);
    });
  }

  private async fillVotes(): Promise<void> {
    const tieBreak = this.inTieBreakVote();
    const actors = this.aliveIds()
      .filter((id) => !tieBreak || !this.tieBreakCandidates().includes(id))
      .map((id) => this.actorById(id))
      .filter((actor): actor is Actor => !!actor);
    await spread(this.think("vote"), actors.length, () => this.stopped, async (index) => {
      const actor = actors[index]!;
      await this.run("game.submitVote", { targetId: this.voteTarget(actor.playerId) }, actor);
    });
  }

  /** 夜晚：没有天使和白板时所有人都活着提交「空刀」，白天才不会被连环淘汰打断。 */
  private async fillNight(): Promise<void> {
    const actors = this.aliveIds().map((id) => this.actorById(id)).filter((actor): actor is Actor => !!actor);
    await spread(this.think("vote"), actors.length, () => this.stopped, async (index) => {
      await this.run("game.submitNightAction", { targetId: null }, actors[index]!);
    });
  }

  protected async loop(): Promise<void> {
    let round = 0;
    while (!this.stopped) {
      round += 1;
      await this.ensureReady();
      if (!await this.advanceFrom("waiting", "game.advancePhase", this.host)) { await this.wait(this.think("tick")); continue; }
      await this.attempt("game.assignQuestioner", { playerId: this.questioner.playerId }, this.host);
      const pair = WORD_PAIRS[round % WORD_PAIRS.length]!;
      await this.attempt("game.submitWords", { words: [pair[0], pair[1]] }, this.questioner);

      let guard = 0;
      while (!this.stopped && this.rawPhase() !== "gameOver" && guard < 80) {
        guard += 1;
        await this.tickMiddlePhase(pair);
        if (this.random() < 0.15) await this.chat(this.participants[guard % this.participants.length]!, this.options.roomId);
      }

      // 结算页有 1500ms 的服务端展示锁，比这更早推进只会刷出一串 PHASE_RESULT_PENDING。
      await this.wait(Math.max(this.think("over"), PHASE_RESULT_DISPLAY_MS + 100));
      await this.advanceFrom("gameOver", "game.advancePhase", this.host, undefined, 20_000);
    }
  }

  /** 一局中段：按当前阶段把在场的人喂满，再交给出题人推进；`wordSubmission` 只缺出题人补交词。 */
  private async tickMiddlePhase(pair: [string, string]): Promise<void> {
    const phase = this.rawPhase();
    if (phase === "wordSubmission") {
      await this.attempt("game.submitWords", { words: [pair[0], pair[1]] }, this.questioner);
      return;
    }
    if (phase === "description" || phase === "tieBreak") {
      await (phase === "tieBreak" && this.tieBreakStage() === "vote" ? this.fillVotes() : this.fillSpeech());
    } else if (phase === "voting") {
      await this.fillVotes();
    } else if (phase === "night") {
      await this.fillNight();
    } else if (phase !== "feedback") {
      // 认不出的阶段不硬推（推进只会刷 INVALID_PHASE），等下一拍重读。
      await this.wait(this.think("tick"));
      return;
    }
    await this.advanceFrom(phase, "game.advancePhase", this.questioner);
  }

  protected leave(socket: GameSocket): Promise<void> {
    return socket.leave("room.leave");
  }
}

/**
 * 猜歌：`seats` 名玩家轮流提交歌曲并猜。每人每轮先猜错一次再猜对，
 * 这样 `guesses` 数组与反馈补丁的量级接近真实对局（只猜对会把流量测低）。
 *
 * 一局的阶段环只有 `waiting` 需要 `song.game.start`，之后 `nextRound` 直接落在
 * `choosingSubmitter` / `submittingSong`，所以开局只在环首出现一次。
 */
export class SongRoom extends BaseRoom {
  private host!: Actor;
  private roomId!: string;
  private started = false;
  /** 已发出的曲目数：`answer` 是本局服务端认可的正确曲目号。 */
  private deal = 0;
  private answer = "";

  protected async connect(): Promise<void> {
    for (let index = 0; index < this.options.seats; index += 1) {
      const socket = new GameSocket({
        url: `${this.options.wsUrl}/api/songuessr/ws`,
        syncCommand: "song.room.requestSync",
        syncEnvelope: () => ({ roomId: this.roomId, sessionToken: this.actors[index]?.sessionToken }),
        stateEvents: SONG_STATE_EVENTS,
      });
      await socket.open();
      this.sockets.push(socket);
      this.actors.push({ socket, playerId: "", sessionToken: "" });
    }
    this.host = this.actors[0]!;
    this.roomId = this.options.roomId;
    await this.run("song.lobby.subscribeRooms", {}, this.host);
    const created = await this.run("song.room.create", {
      roomId: this.roomId,
      name: this.options.name,
      visibility: "public",
      allowSpectators: true,
      userName: `${this.options.name}-1`,
    }, this.host) as { playerId: string, sessionToken: string } | undefined;
    if (!created) throw new Error("song.room.create 失败");
    this.host.playerId = created.playerId;
    this.host.sessionToken = created.sessionToken;
    await this.run("song.auth.useCookie", { platform: "netease", cookie: "MUSIC_U=loadtest" }, this.host, { roomId: this.roomId, sessionToken: this.host.sessionToken });
    await this.run("song.room.updateSettings", {
      questionType: "song",
      questionMode: "manual",
      autoRotateSubmitter: false,
      maxGuessesPerRound: 3,
      guessDurationSeconds: 60,
      lyricsLineCount: 5,
      showLyrics: true,
      showGuessTimer: true,
    }, this.host, { roomId: this.roomId, sessionToken: this.host.sessionToken });
    for (let index = 1; index < this.actors.length; index += 1) {
      const actor = this.actors[index]!;
      const joined = await this.run("song.room.join", { userName: `${this.options.name}-${index + 1}` }, actor, { roomId: this.roomId }) as
        { playerId: string, sessionToken: string } | undefined;
      if (!joined) throw new Error("song.room.join 失败");
      actor.playerId = joined.playerId;
      actor.sessionToken = joined.sessionToken;
      await this.run("song.player.setReady", { ready: true }, actor, { roomId: this.roomId, sessionToken: actor.sessionToken });
    }
  }

  private snapshot(): Record<string, unknown> | undefined {
    return this.host.socket.state("song.room.snapshot");
  }

  protected rawPhase(): string {
    return (this.snapshot()?.phase as string | undefined) ?? "";
  }

  /** 服务端只在 `playing` 时下发 `currentRound`，其中的 roundNumber 是 audioReady 的校验值。 */
  private currentRound(): { roundNumber: number, submitterPlayerId: string } | undefined {
    const round = this.snapshot()?.currentRound as { roundNumber?: number, submitterPlayerId?: string } | undefined;
    return round?.roundNumber === undefined ? undefined : { roundNumber: round.roundNumber, submitterPlayerId: round.submitterPlayerId ?? "" };
  }

  private actorById(id: string): Actor | undefined {
    return this.actors.find((actor) => actor.playerId === id);
  }

  private envelope(actor: Actor): { roomId: string, sessionToken: string } {
    return { roomId: this.roomId, sessionToken: actor.sessionToken };
  }

  private async ensureReady(): Promise<void> {
    const players = (this.snapshot()?.players as { id: string, isReady: boolean, membership: string }[] | undefined) ?? [];
    const pending = players
      .filter((player) => player.membership !== "spectator" && player.membership !== "kicked" && !player.isReady)
      .map((player) => this.actorById(player.id))
      .filter((actor): actor is Actor => !!actor);
    await spread(this.think("submit"), pending.length, () => this.stopped, async (index) => {
      await this.run("song.player.setReady", { ready: true }, pending[index]!, this.envelope(pending[index]!));
    });
  }

  /** 一个猜测者的一轮：先报音频就绪，再猜错一次、猜对一次，服务端按此生成逐人反馈补丁。 */
  private async playGuess(roundNumber: number, answer: string, wrong: string, actor: Actor, slot: number, count: number): Promise<void> {
    if (this.stopped || this.rawPhase() !== "playing") return;
    await this.run("song.game.audioReady", { roundNumber }, actor, this.envelope(actor));
    // 出手时刻按人在整局窗口里等分：座位再多也不会把一轮拉成「人数 × 思考时间」。
    await this.wait(Math.round((this.think("guess1") * slot) / count));
    if (this.stopped || this.rawPhase() !== "playing") return;
    await this.run("song.game.guess", { songId: wrong }, actor, this.envelope(actor));
    await this.wait(Math.round((this.think("guess2") * slot) / count));
    if (this.stopped || this.rawPhase() !== "playing") return;
    await this.run("song.game.guess", { songId: answer }, actor, this.envelope(actor));
  }

  protected async loop(): Promise<void> {
    let cycle = 0;
    while (!this.stopped) {
      cycle += 1;
      await this.tick(cycle);
    }
  }

  /**
   * 一拍只处理一个阶段：出手完就交回循环，状态变了下一拍自然走别的分支。
   * `cycle` 只用来轮流挑提交人，让每局都有不同的人出手。
   */
  private async tick(cycle: number): Promise<void> {
    const phase = this.rawPhase();
    if (phase === "waiting") return this.tickWaiting();
    if (phase === "choosingSubmitter") return this.tickChooseSubmitter(cycle);
    if (phase === "submittingSong") return this.tickSubmitSong();
    if (phase === "playing") return this.tickPlay();
    if (phase === "roundResult") return this.tickRoundResult();
    await this.wait(this.think("tick"));
  }

  private async tickWaiting(): Promise<void> {
    await this.ensureReady();
    if (this.started) { await this.wait(this.think("tick")); return; }
    if (await this.advanceFrom("waiting", "song.game.start", this.host, this.envelope(this.host))) this.started = true;
  }

  private async tickChooseSubmitter(cycle: number): Promise<void> {
    const submitter = this.actors[cycle % this.actors.length]!;
    await this.attempt("song.game.chooseSubmitter", { playerId: submitter.playerId }, this.host, this.envelope(this.host));
  }

  private async tickSubmitSong(): Promise<void> {
    const pendingId = (this.snapshot()?.pendingSubmitterPlayerId as string | undefined)
      ?? (this.snapshot()?.players as { id: string, roundStatus: string }[] | undefined)?.find((player) => player.roundStatus === "submitter")?.id;
    const submitter = pendingId ? this.actorById(pendingId) : this.host;
    if (!submitter) { await this.wait(this.think("tick")); return; }
    // 曲目号在提交成功那一刻才发号：`playing` 阶段的对错判定必须用同一个 id。
    if (await this.attempt("song.game.submitSong", { songId: `netease:${900 + this.deal + 1}` }, submitter, this.envelope(submitter), 20_000) !== undefined) {
      this.deal += 1;
      this.answer = `netease:${900 + this.deal}`;
    }
  }

  private async tickPlay(): Promise<void> {
    const round = this.currentRound();
    if (!round) { await this.wait(this.think("tick")); return; }
    const guessers = this.actors.filter((actor) => actor.playerId !== round.submitterPlayerId);
    await Promise.all(guessers.map(async (actor, index) => {
      await interruptible(Math.round((this.think("audio") * (index + 1)) / guessers.length), () => this.stopped);
      await this.playGuess(round.roundNumber, this.answer, `netease:${600 + this.deal}`, actor, index + 1, guessers.length);
    }));
    await this.until(() => this.rawPhase() === "roundResult", 12_000);
  }

  private async tickRoundResult(): Promise<void> {
    if (this.random() < 0.5) await this.chat(this.host, this.roomId, this.host.sessionToken);
    await this.wait(this.think("next"));
    const advanced = await this.attempt("song.game.nextRound", {}, this.host, this.envelope(this.host)) as { waiting?: boolean } | undefined;
    if (advanced?.waiting) this.started = false;
  }

  protected leave(socket: GameSocket, index: number): Promise<void> {
    return socket.leave("song.room.leave", { roomId: this.roomId, sessionToken: this.actors[index]?.sessionToken });
  }
}

/**
 * 猜番：`seats` 名玩家 1v1 起步的自由混战。手动出题（答案由驱动器掌握），
 * 每人先猜 3 次不中，最后由第一名猜题者猜中收束本局。
 *
 * `nonstopMode` 关闭时第一个正确答案就结算整局，所以其余人每次出手前都重新读阶段；
 * `globalPick` 打开会让后出手的人吃到 CHARACTER_BANNED，压力模型不需要这条规则。
 */
export class CeeRoom extends BaseRoom {
  private host!: Actor;
  private roomId!: string;
  /** 已开出的局数：题号由它推导，猜测阶段与出题阶段共用同一个值。 */
  private deal = 0;

  protected async connect(): Promise<void> {
    for (let index = 0; index < this.options.seats; index += 1) {
      const socket = new GameSocket({
        url: `${this.options.wsUrl}/api/cee/ws`,
        syncCommand: "cee.room.requestSync",
        syncEnvelope: () => ({ roomId: this.roomId, sessionToken: this.actors[index]?.sessionToken }),
        stateEvents: CEE_STATE_EVENTS,
      });
      await socket.open();
      this.sockets.push(socket);
      this.actors.push({ socket, playerId: "", sessionToken: "" });
    }
    this.host = this.actors[0]!;
    this.roomId = this.options.roomId;
    await this.run("cee.lobby.subscribeRooms", {}, this.host);
    const created = await this.run("cee.room.create", {
      source: "native",
      roomId: this.roomId,
      name: this.options.name,
      userName: `${this.options.name}-1`,
      visibility: "public",
      password: null,
      allowSpectators: true,
    }, this.host) as { sessionToken: string, privateState?: { playerId?: string } } | undefined;
    if (!created) throw new Error("cee.room.create 失败");
    this.host.sessionToken = created.sessionToken;
    // CEE 的进入结果不给 playerId，只有私有状态里有：chooseSetter 必须要它。
    this.host.playerId = created.privateState?.playerId ?? "";
    const year = new Date().getFullYear();
    await this.run("cee.room.settings", {
      settings: {
        startYear: year - 5, endYear: year, topNSubjects: 20, useSubjectPerYear: false,
        metaTags: ["", "", ""], useIndex: false, indexId: null, addedSubjects: [],
        mainCharacterOnly: true, characterNum: 6, maxAttempts: 8, timeLimit: 60,
        subjectSearch: true, subjectTagNum: 4, characterTagNum: 4, useHints: [4], useImageHint: 0,
        globalPick: false, tagBan: false, syncMode: false, nonstopMode: false, answerMode: "manual",
      },
    }, this.host, { roomId: this.roomId, sessionToken: this.host.sessionToken });
    for (let index = 1; index < this.actors.length; index += 1) {
      const actor = this.actors[index]!;
      const joined = await this.run("cee.room.join", { userName: `${this.options.name}-${index + 1}`, password: null }, actor, { roomId: this.roomId }) as
        { sessionToken: string, privateState?: { playerId?: string } } | undefined;
      if (!joined) throw new Error("cee.room.join 失败");
      actor.sessionToken = joined.sessionToken;
      actor.playerId = joined.privateState?.playerId ?? "";
      await this.run("cee.player.ready", { ready: true }, actor, { roomId: this.roomId, sessionToken: actor.sessionToken });
    }
    if (!this.host.playerId || this.actors.some((actor) => !actor.playerId)) throw new Error("cee 私有状态缺 playerId");
  }

  private snapshot(): Record<string, unknown> | undefined {
    return this.host.socket.state("cee.room.snapshot");
  }

  protected rawPhase(): string {
    return (this.snapshot()?.phase as string | undefined) ?? "";
  }

  private roundNumber(): number {
    return (this.snapshot()?.roundNumber as number | undefined) ?? 0;
  }

  private setterId(): string {
    return (this.snapshot()?.setterPlayerId as string | undefined) ?? "";
  }

  /** 本人还能不能出手：`canGuess` 已经把阶段、席位与剩余次数算清楚了。 */
  private canGuess(actor: Actor): boolean {
    return actor.socket.state<{ canGuess?: boolean }>("cee.game.privateState")?.canGuess === true;
  }

  private readyPending(): Actor[] {
    const players = (this.snapshot()?.players as { id: string, ready: boolean, membership: string }[] | undefined) ?? [];
    return players
      .filter((player) => !player.ready && player.membership !== "spectator")
      .map((player) => this.actors.find((actor) => actor.playerId === player.id))
      .filter((actor): actor is Actor => !!actor);
  }

  private envelope(actor: Actor): { roomId: string, sessionToken: string } {
    return { roomId: this.roomId, sessionToken: actor.sessionToken };
  }

  protected async loop(): Promise<void> {
    let cycle = 0;
    while (!this.stopped) {
      cycle += 1;
      const phase = this.rawPhase();

      if (phase === "waiting") {
        const pending = this.readyPending();
        await spread(this.think("ready"), pending.length, () => this.stopped, async (index) => {
          const actor = pending[index]!;
          await this.run("cee.player.ready", { ready: true }, actor, this.envelope(actor));
        });
        await this.attempt("cee.game.start", {}, this.host, this.envelope(this.host));
        continue;
      }

      if (phase === "choosingSetter") {
        const candidates = (this.host.socket.state<{ setterCandidateIds?: string[] }>("cee.game.privateState")?.setterCandidateIds ?? [])
          .map((id) => this.actors.find((actor) => actor.playerId === id))
          .filter((actor): actor is Actor => !!actor);
        const setter = candidates.length ? candidates[cycle % candidates.length]! : this.actors[1] ?? this.host;
        await this.attempt("cee.game.chooseSetter", { playerId: setter.playerId }, this.host, this.envelope(this.host));
        continue;
      }

      if (phase === "answering") {
        const setter = this.actors.find((actor) => actor.playerId === this.setterId()) ?? this.host;
        // 题号在 setAnswer 成功时才落定，猜测阶段要用同一个号才知道谁是正确答案。
        if (await this.attempt("cee.game.setAnswer", { characterId: 100_000 + (this.deal + 1) * 13, hints: ["她来自海边的小镇"] }, setter, this.envelope(setter)) !== undefined) this.deal += 1;
        continue;
      }

      if (phase === "guessing") {
        const answer = 100_000 + this.deal * 13;
        const guessers = this.actors.filter((actor) => actor.playerId !== this.setterId());
        // 同一队伍在服务端是串行的（ACTION_PENDING），所以每个单位自己排队，单位之间按整局窗口错开。
        await Promise.all(guessers.map(async (actor, actorIndex) => {
          const step = this.think("guessStep");
          await interruptible(Math.round((this.think("firstGuess") * (actorIndex + 1)) / guessers.length), () => this.stopped);
          for (let attempt = 0; attempt < 3; attempt += 1) {
            if (this.stopped || this.rawPhase() !== "guessing" || !this.canGuess(actor)) return;
            await this.run("cee.game.guess", { characterId: 200_000 + this.deal * 97 + actorIndex * 11 + attempt }, actor, this.envelope(actor));
            await interruptible(step, () => this.stopped);
          }
          // 由错开到最后的那个人猜中：整局在第一个正确答案处收束，其余人自动退出。
          if (actorIndex !== guessers.length - 1 || this.stopped || this.rawPhase() !== "guessing" || !this.canGuess(actor)) return;
          await this.run("cee.game.guess", { characterId: answer }, actor, this.envelope(actor));
        }));
        await this.until(() => this.rawPhase() === "settled", 12_000);
        continue;
      }

      if (phase === "settled") {
        if (this.random() < 0.5) await this.chat(this.host, this.roomId, this.host.sessionToken);
        await this.wait(this.think("next"));
        await this.attempt("cee.game.next", {}, this.host, this.envelope(this.host));
        continue;
      }

      await this.wait(this.think("tick"));
    }
  }

  protected leave(socket: GameSocket, index: number): Promise<void> {
    return socket.leave("cee.room.leave", { roomId: this.roomId, sessionToken: this.actors[index]?.sessionToken });
  }
}

export const createRoom = (options: RoomOptions): BaseRoom =>
  options.game === "faker" ? new FakerRoom(options) : options.game === "song" ? new SongRoom(options) : new CeeRoom(options);

/** 各游戏的最小合法座位数：谁是卧底 4 名参与者 + 1 名出题人。 */
export const MIN_SEATS: Record<GameKind, number> = { faker: 5, song: 2, cee: 2 };
