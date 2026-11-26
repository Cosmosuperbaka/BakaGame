/**
 * 排位分数重放：按系列赛结束时刻从头重放全部已计分的系列赛，用现行规则重算每个账号的分数与偏差。
 *
 * 用法：`bun run scripts/CEERankedReplay.ts [--apply] [--yes]`
 * 缺省只演算并打印新旧对照，不写库；带 `--apply` 才在一个事务里写回评级表的分数、偏差与
 * 最近对局时刻（场数与胜负平不受计分口径影响，原样保留）。审计记录是历史，一行不改。
 *
 * 规则版本换代时，旧版本留下的人机强度分口径与现行不同：这里把旧口径换算成现行的实战分
 * （换算表见下方 r2 一节，用 r2 代码在标定脚本同一参照下模拟拟合），校准偏差按现行规则在
 * 重放过程中在线估计，与线上从零开始攒样本的行为一致。
 *
 * 目标库取环境里的 DATABASE_URL（Bun 自动读 `.env`）。写库前回显「主机:端口/库名」并要求键入
 * 库名确认，非交互环境必须带 `--yes`。写回按乐观并发：重放期间有人结算过系列赛（最近对局时刻
 * 或场数变了），整笔回滚，重跑即可。
 */
import { createInterface } from "node:readline/promises";
import { and, asc, eq, sql } from "drizzle-orm";
import { CEERankedHandicap, type CEERankedBotGroup } from "../src/application/CEERankedHandicap";
import { clamp, type CEERankedPersonaId } from "../src/domain/CEERankedBotProfile";
import {
  createCEERating,
  rateCEEBotSeries,
  rateCEESeries,
  type CEERating,
  type CEESeriesScore,
} from "../src/domain/CEERankedRating";
import { createDatabase } from "../src/infrastructure/db/Database";
import {
  ceeRankedRating,
  ceeRankedSeries,
  ceeRankedSeriesPlayer,
} from "../src/infrastructure/db/Schema";
import { CEE_RANKED_RULESET } from "../src/shared/CEERanked";
import { confirmationMode, describeTarget } from "./RunOneOffSql";

export interface CEERankedReplayPlayer {
  userId: string | null;
  placement: boolean;
  score: CEESeriesScore;
  botPersona: string | null;
  botStrengthRating: number | null;
  /** 审计里的赛前分：r2 的爱噶按它定节奏，换算她的实战分要用。 */
  ratingBefore: number | null;
}

export interface CEERankedReplaySeries {
  id: string;
  ruleset: string;
  endedAt: number;
  rated: boolean;
  bot: boolean;
  players: CEERankedReplayPlayer[];
}

// ==================== r2 人机换算 ====================
// r2 的强度表与爱噶曲线都按 800～2300 夹取；下面的实战分与现行锚点同一尺度（d3 题库，基线人格
// 1400 档两版逐项相同，以它为公共参照）。

/** r2 基线人格各档位的实战分。 */
export const R2_LADDER: ReadonlyArray<{ level: number; rating: number }> = [
  { level: 800, rating: 957 },
  { level: 1100, rating: 1180 },
  { level: 1400, rating: 1400 },
  { level: 1700, rating: 1566 },
  { level: 2000, rating: 1748 },
  { level: 2300, rating: 1897 },
];
/** r2 普通人格相对基线的实战分偏移（1400 与 2000 两档的平均）。 */
export const R2_PERSONA_OFFSET: Readonly<Record<Exclude<CEERankedPersonaId, "aiga">, number>> = {
  dango: 21,
  awen: -67,
  kaoju: -48,
  mangmang: -56,
  yemao: -54,
};
/** r2 爱噶按对手分数 R 出手时，比 R 档基线人格强多少（R 夹在 800～2300）。 */
export const R2_AIGA_EDGE: ReadonlyArray<{ level: number; rating: number }> = [
  { level: 800, rating: 209 },
  { level: 1100, rating: 209 },
  { level: 1400, rating: 190 },
  { level: 1700, rating: 172 },
  { level: 2000, rating: 166 },
  { level: 2300, rating: 184 },
];

const interpolate = (
  table: ReadonlyArray<{ level: number; rating: number }>,
  level: number
): number => {
  const bounded = clamp(level, table[0].level, table[table.length - 1].level);
  let lower = 0;
  while (lower + 2 < table.length && bounded > table[lower + 1].level) lower += 1;
  const from = table[lower];
  const to = table[lower + 1];
  const ratio = (bounded - from.level) / (to.level - from.level);
  return from.rating + (to.rating - from.rating) * ratio;
};

/**
 * 一场人机系列赛里人机的实战分（现行尺度）。现行版本记的就是实战分；r2 记的是喂进强度表的
 * 档位（未夹取），爱噶则按当时真人的赛前分定节奏。换算不了的返回 null。
 */
export function replayBotStrength(
  ruleset: string,
  bot: CEERankedReplayPlayer,
  human: CEERankedReplayPlayer
): number | null {
  if (bot.botPersona === null) return null;
  if (ruleset === CEE_RANKED_RULESET) return bot.botStrengthRating;
  if (ruleset !== "r2") return null;
  if (bot.botPersona === "aiga") {
    if (human.ratingBefore === null) return null;
    return (
      interpolate(R2_LADDER, human.ratingBefore) + interpolate(R2_AIGA_EDGE, human.ratingBefore)
    );
  }
  const offset = R2_PERSONA_OFFSET[bot.botPersona as keyof typeof R2_PERSONA_OFFSET];
  if (offset === undefined || bot.botStrengthRating === null) return null;
  return interpolate(R2_LADDER, bot.botStrengthRating) + offset;
}

export interface CEERankedReplayResult {
  ratings: Map<string, CEERating>;
  /** 换算不了强度、只能跳过的已计分人机系列赛。 */
  skipped: string[];
  bias: Record<CEERankedBotGroup, number>;
}

const groupOf = (persona: string): CEERankedBotGroup => (persona === "aiga" ? "aiga" : "regular");

/** 按结束时刻（同刻按编号）重放已计分系列赛；校准偏差在重放中在线估计，与线上同一口径。 */
export function replayCEERankedRatings(
  series: readonly CEERankedReplaySeries[]
): CEERankedReplayResult {
  const ratings = new Map<string, CEERating>();
  const handicap = new CEERankedHandicap();
  const skipped: string[] = [];
  const ratingOf = (userId: string): CEERating => ratings.get(userId) ?? createCEERating();
  const ordered = [...series].sort((a, b) => a.endedAt - b.endedAt || a.id.localeCompare(b.id));
  for (const item of ordered) {
    if (!item.rated) continue;
    if (!item.bot) {
      const [a, b] = item.players;
      if (!a?.userId || !b?.userId) continue;
      const [nextA, nextB] = rateCEESeries(
        ratingOf(a.userId),
        ratingOf(b.userId),
        a.score,
        item.endedAt
      );
      ratings.set(a.userId, nextA);
      ratings.set(b.userId, nextB);
      continue;
    }
    const human = item.players.find((player) => player.userId !== null);
    const bot = item.players.find((player) => player.userId === null && player.botPersona !== null);
    if (!human?.userId || !bot?.botPersona) {
      skipped.push(item.id);
      continue;
    }
    const strength = replayBotStrength(item.ruleset, bot, human);
    if (strength === null) {
      skipped.push(item.id);
      continue;
    }
    const group = groupOf(bot.botPersona);
    const before = ratingOf(human.userId);
    ratings.set(
      human.userId,
      rateCEEBotSeries(before, strength + handicap.bias(group), human.score, item.endedAt)
    );
    handicap.add({
      group,
      userId: human.userId,
      placement: human.placement,
      playerRating: before.rating,
      playerRd: before.rd,
      strengthRating: strength,
      score: human.score,
    });
  }
  return {
    ratings,
    skipped,
    bias: { regular: handicap.bias("regular"), aiga: handicap.bias("aiga") },
  };
}

// ==================== 读写库 ====================

interface StoredRating {
  userId: string;
  rating: number;
  rd: number;
  seriesPlayed: number;
  lastPlayedAt: Date | null;
}

const confirm = async (args: string[], target: { label: string; database: string }) => {
  const mode = confirmationMode(args, Boolean(process.stdin.isTTY && process.stdout.isTTY));
  if (mode === "skip") return;
  if (mode === "refuse")
    throw new Error(`非交互环境必须显式带 --yes 才会写库；目标库：${target.label}`);
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await reader.question(
      `将覆盖全部排位分数。键入库名「${target.database}」确认：`
    );
    if (answer.trim() !== target.database) throw new Error("库名不符，已取消，没有写库");
  } finally {
    reader.close();
  }
};

/** 账号编号只露前 6 位：终端输出会被复制到别处，不必带全量标识。 */
const shortId = (userId: string): string => `${userId.slice(0, 6)}…`;

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const url = Bun.env.DATABASE_URL;
  if (!url) throw new Error("请先设置 DATABASE_URL");
  const target = describeTarget(url);
  console.log(`目标库：${target.label}（${apply ? "演算后写回" : "只演算，不写库"}）`);
  const database = createDatabase(url);
  try {
    const db = await database.client();
    const seriesRows = await db
      .select({
        id: ceeRankedSeries.id,
        ruleset: ceeRankedSeries.ruleset,
        endedAt: ceeRankedSeries.endedAt,
        rated: ceeRankedSeries.rated,
        bot: ceeRankedSeries.bot,
      })
      .from(ceeRankedSeries)
      .orderBy(asc(ceeRankedSeries.endedAt));
    const playerRows = await db
      .select({
        seriesId: ceeRankedSeriesPlayer.seriesId,
        seat: ceeRankedSeriesPlayer.seat,
        userId: ceeRankedSeriesPlayer.userId,
        placement: ceeRankedSeriesPlayer.placement,
        score: ceeRankedSeriesPlayer.score,
        botPersona: ceeRankedSeriesPlayer.botPersona,
        botStrengthRating: ceeRankedSeriesPlayer.botStrengthRating,
        ratingBefore: ceeRankedSeriesPlayer.ratingBefore,
      })
      .from(ceeRankedSeriesPlayer)
      .orderBy(asc(ceeRankedSeriesPlayer.seriesId), asc(ceeRankedSeriesPlayer.seat));
    const stored: StoredRating[] = await db
      .select({
        userId: ceeRankedRating.userId,
        rating: ceeRankedRating.rating,
        rd: ceeRankedRating.rd,
        seriesPlayed: ceeRankedRating.seriesPlayed,
        lastPlayedAt: ceeRankedRating.lastPlayedAt,
      })
      .from(ceeRankedRating);

    const playersBySeries = new Map<string, CEERankedReplayPlayer[]>();
    for (const row of playerRows) {
      const list = playersBySeries.get(row.seriesId) ?? [];
      list.push({ ...row, score: row.score as CEESeriesScore });
      playersBySeries.set(row.seriesId, list);
    }
    const result = replayCEERankedRatings(
      seriesRows.map((row) => ({
        ...row,
        endedAt: row.endedAt.getTime(),
        players: playersBySeries.get(row.id) ?? [],
      }))
    );

    console.log(`系列赛 ${seriesRows.length} 场，跳过 ${result.skipped.length} 场`);
    console.log(
      `重放结束时的校准偏差：普通人格 ${result.bias.regular.toFixed(1)}，爱噶 ${result.bias.aiga.toFixed(1)}`
    );
    console.log("账号 | 场数 | 旧分 / 偏差 | 新分 / 偏差");
    const changes = stored
      .map((row) => ({ row, next: result.ratings.get(row.userId) }))
      .filter((item): item is { row: StoredRating; next: CEERating } => item.next !== undefined)
      .sort((a, b) => b.next.rating - a.next.rating);
    for (const { row, next } of changes)
      console.log(
        `${shortId(row.userId)} | ${row.seriesPlayed} | ${row.rating.toFixed(0)} / ${row.rd.toFixed(0)} | ${next.rating.toFixed(0)} / ${next.rd.toFixed(0)}`
      );
    if (!apply) {
      console.log("只演算完成；确认无误后带 --apply 写回。");
      return;
    }
    await confirm(args, target);
    await db.transaction(async (tx) => {
      for (const { row, next } of changes) {
        const [header] = await tx
          .update(ceeRankedRating)
          .set({
            rating: next.rating,
            rd: next.rd,
            lastPlayedAt: next.lastPlayedAt === null ? null : new Date(next.lastPlayedAt),
          })
          .where(
            and(
              eq(ceeRankedRating.userId, row.userId),
              eq(ceeRankedRating.seriesPlayed, row.seriesPlayed),
              row.lastPlayedAt === null
                ? sql`${ceeRankedRating.lastPlayedAt} is null`
                : eq(ceeRankedRating.lastPlayedAt, row.lastPlayedAt)
            )
          );
        if (header.affectedRows !== 1)
          throw new Error(
            `账号 ${shortId(row.userId)} 在重放期间又结算过系列赛，已整笔回滚，请重跑`
          );
      }
    });
    console.log(`已写回 ${changes.length} 个账号。`);
  } finally {
    await database.close();
  }
};

if (import.meta.main) await main();
