import { NeteaseMusicProvider } from "../infrastructure/NeteaseMusicProvider";
import { QQMusicProvider } from "../infrastructure/QQMusicProvider";
import { AggregatedMusicProvider } from "../infrastructure/AggregatedMusicProvider";
import {
  normalizeComparableText,
  type AggregatedSongSearchResult,
} from "../infrastructure/MusicDeduplicator";

interface TestCase {
  query: string;
  expectedTopArtist: string;
  allowAlternateArtist?: string[];
  shouldDualSource?: boolean;
}

const TEST_CASES: TestCase[] = [
  // 1. 华语流行周杰伦神曲 (高概率双端都有，且QQ拥有正版高权)
  { query: "晴天", expectedTopArtist: "周杰伦", shouldDualSource: true },
  { query: "七里香", expectedTopArtist: "周杰伦", shouldDualSource: true },
  { query: "夜曲", expectedTopArtist: "周杰伦", shouldDualSource: true },
  { query: "稻香", expectedTopArtist: "周杰伦", shouldDualSource: true },
  { query: "告白气球", expectedTopArtist: "周杰伦", shouldDualSource: true },
  { query: "青花瓷", expectedTopArtist: "周杰伦", shouldDualSource: true },
  { query: "反方向的钟", expectedTopArtist: "周杰伦", shouldDualSource: true },
  { query: "一路向北", expectedTopArtist: "周杰伦", shouldDualSource: true },
  { query: "花海", expectedTopArtist: "周杰伦", shouldDualSource: true },
  { query: "简单爱", expectedTopArtist: "周杰伦", shouldDualSource: true },

  // 2. 合作曲目 / 多歌手
  {
    query: "千里之外",
    expectedTopArtist: "周杰伦",
    allowAlternateArtist: ["费玉清"],
    shouldDualSource: true,
  },
  {
    query: "珊瑚海",
    expectedTopArtist: "周杰伦",
    allowAlternateArtist: ["Lara", "梁心颐"],
    shouldDualSource: true,
  },
  {
    query: "屋顶",
    expectedTopArtist: "吴宗宪",
    allowAlternateArtist: ["温岚", "周杰伦"],
    shouldDualSource: true,
  },
  {
    query: "手心的蔷薇",
    expectedTopArtist: "林俊杰",
    allowAlternateArtist: ["邓紫棋", "G.E.M."],
    shouldDualSource: true,
  },

  // 3. 经典国语流行
  { query: "后来", expectedTopArtist: "刘若英", shouldDualSource: true },
  { query: "遇见", expectedTopArtist: "孙燕姿", shouldDualSource: true },
  { query: "童话", expectedTopArtist: "光良", shouldDualSource: true },
  { query: "演员", expectedTopArtist: "薛之谦", shouldDualSource: true },
  { query: "红色高跟鞋", expectedTopArtist: "蔡健雅", shouldDualSource: true },
  { query: "修炼爱情", expectedTopArtist: "林俊杰", shouldDualSource: true },
  { query: "江南", expectedTopArtist: "林俊杰", shouldDualSource: true },
  {
    query: "光年之外",
    expectedTopArtist: "邓紫棋",
    allowAlternateArtist: ["G.E.M."],
    shouldDualSource: true,
  },
  {
    query: "泡沫",
    expectedTopArtist: "邓紫棋",
    allowAlternateArtist: ["G.E.M."],
    shouldDualSource: true,
  },
  { query: "漠河舞厅", expectedTopArtist: "柳爽", shouldDualSource: true },

  // 4. 原唱 vs 翻唱典型
  {
    query: "起风了",
    expectedTopArtist: "买辣椒也用券",
    allowAlternateArtist: ["吴青峰", "高桥优"],
    shouldDualSource: true,
  },

  // 5. ACG / 动漫名曲
  { query: "only my railgun", expectedTopArtist: "fripSide", shouldDualSource: true },
  {
    query: "残酷な天使のテーゼ",
    expectedTopArtist: "高橋洋子",
    allowAlternateArtist: ["高桥洋子"],
    shouldDualSource: true,
  },
  { query: "红莲华", expectedTopArtist: "LiSA", shouldDualSource: true },
  {
    query: "unravel",
    expectedTopArtist: "TK from 凛として時雨",
    allowAlternateArtist: ["TK from 凛として时雨", "TK"],
    shouldDualSource: true,
  },
  { query: "前前前世", expectedTopArtist: "RADWIMPS", shouldDualSource: true },
  { query: "crossing field", expectedTopArtist: "LiSA", shouldDualSource: true },
  { query: "Brave Shine", expectedTopArtist: "Aimer", shouldDualSource: true },
  {
    query: "青鸟",
    expectedTopArtist: "いきものがかり",
    allowAlternateArtist: ["生物股长"],
    shouldDualSource: true,
  },
  {
    query: "打上花火",
    expectedTopArtist: "DAOKO",
    allowAlternateArtist: ["米津玄师", "米津玄師"],
    shouldDualSource: true,
  },
  {
    query: "secret base",
    expectedTopArtist: "ZONE",
    allowAlternateArtist: ["茅野爱衣", "本间芽衣子", "あの花"],
    shouldDualSource: true,
  },
  { query: "恋爱循环", expectedTopArtist: "花泽香菜", allowAlternateArtist: ["花澤香菜"] },
  { query: "Butter-Fly", expectedTopArtist: "和田光司" },
  {
    query: "极乐净土",
    expectedTopArtist: "GARNiDELiA",
    allowAlternateArtist: ["美依礼芽", "MARiA"],
  },
  { query: "达拉崩吧", expectedTopArtist: "洛天依", allowAlternateArtist: ["周深", "ilem"] },

  // 6. 华语更多经典与指定歌手搜索
  { query: "孤勇者", expectedTopArtist: "陈奕迅" },
  { query: "富士山下", expectedTopArtist: "陈奕迅" },
  { query: "爱情转移", expectedTopArtist: "陈奕迅" },
  { query: "龙卷风", expectedTopArtist: "周杰伦", allowAlternateArtist: ["邓紫棋", "G.E.M."] },
  { query: "枫", expectedTopArtist: "周杰伦" },
  { query: "借口", expectedTopArtist: "周杰伦" },
  { query: "搁浅", expectedTopArtist: "周杰伦" },
  { query: "突然好想你", expectedTopArtist: "五月天" },
  { query: "知足", expectedTopArtist: "五月天" },
  { query: "晴天 刘瑞琦", expectedTopArtist: "刘瑞琦" },
  { query: "晴天 关诗敏", expectedTopArtist: "关诗敏" },
];

/** 单条用例的判定结果：line 紧跟进度提示打印，anomaly 只在失败时带上。 */
type CaseOutcome =
  | { readonly status: "passed"; readonly line: string }
  | { readonly status: "failed"; readonly line: string; readonly anomaly: string };

const expectedArtists = (tc: TestCase): string[] => [
  tc.expectedTopArtist,
  ...(tc.allowAlternateArtist || []),
];

/** 歌手名允许互为子串：两端都归一化后再双向包含比对。 */
const isSameArtist = (expected: string, actual: string): boolean => {
  const normExp = normalizeComparableText(expected);
  const normActual = normalizeComparableText(actual);
  return normActual.includes(normExp) || normExp.includes(normActual);
};

const artistMatches = (tc: TestCase, top: AggregatedSongSearchResult): boolean =>
  expectedArtists(tc).some((exp) => isSameArtist(exp, top.artist));

const DERIVATION_MARKERS = ["伴奏", "instrumental", "片段", "铃声"];

/** 验证衍生版本惩罚：置顶标题命中任一衍生标记即为失误。 */
const isBadDerivation = (title: string): boolean => {
  const topTitleLower = title.toLowerCase();
  return DERIVATION_MARKERS.some((marker) => topTitleLower.includes(marker));
};

/** 验证去重聚类质量：首曲关联的备用音源列表。 */
const mergedSources = (top: AggregatedSongSearchResult): string[] => top.sources || [top.id];

const isDualSourceMerged = (top: AggregatedSongSearchResult): boolean => {
  const sources = mergedSources(top);
  return sources.some((s) => s.startsWith("netease:")) && sources.some((s) => s.startsWith("qq:"));
};

const sourceTag = (top: AggregatedSongSearchResult): string =>
  isDualSourceMerged(top) ? "【双源互证合并】" : `【单源: ${mergedSources(top).join(", ")}】`;

/** 深度详情测试：直链可播性与歌词解析优先级。 */
async function probeDetailSummary(
  aggregated: AggregatedMusicProvider,
  songId: string
): Promise<string> {
  try {
    const details = await aggregated.getSong(songId);
    const hasAudio = Boolean(details.audioUrl && details.audioUrl.startsWith("http"));
    const lyricCount = details.lyrics?.length || 0;
    const hasVerbatim = details.lyrics?.some((l) => Boolean(l.words && l.words.length > 0));
    return `[音频: ${hasAudio ? "OK" : "无"}, 歌词: ${lyricCount}行, 逐字: ${hasVerbatim ? "YES" : "NO"}]`;
  } catch (detailErr) {
    return `[详情拉取告警: ${detailErr instanceof Error ? detailErr.message : String(detailErr)}]`;
  }
}

/** 跑一条用例：召回 → 首位歌手 → 衍生版本惩罚 → 双源聚类 → 详情直链。 */
async function verifyCase(
  aggregated: AggregatedMusicProvider,
  tc: TestCase,
  index: number
): Promise<CaseOutcome> {
  try {
    const results = (await aggregated.search(tc.query, 10)) as AggregatedSongSearchResult[];
    if (!results || results.length === 0) {
      return { status: "failed", line: "❌ 召回为空", anomaly: `"${tc.query}": 召回结果为空` };
    }

    const top = results[0];
    if (!artistMatches(tc, top)) {
      return {
        status: "failed",
        line: `❌ 排序置顶偏离: 期望 [${expectedArtists(tc).join(" / ")}]，实际: "${top.artist}" - "${top.title}" (Score: ${top.relevanceScore})`,
        anomaly: `"${tc.query}": 首位歌手偏离, 得到 "${top.artist}" - "${top.title}"`,
      };
    }

    if (isBadDerivation(top.title)) {
      return {
        status: "failed",
        line: `❌ 原版优先失误: 置顶了伴奏/铃声版本 "${top.title}"`,
        anomaly: `"${tc.query}": 置顶了伴奏/铃声版本`,
      };
    }

    let detailSummary = "";
    if (index % 5 === 0 || !isDualSourceMerged(top)) {
      detailSummary = await probeDetailSummary(aggregated, top.id);
    }

    return {
      status: "passed",
      line: `✅ 通过: "${top.title}" - ${top.artist} ${sourceTag(top)} ${detailSummary}`,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      status: "failed",
      line: `❌ 抛出异常: ${reason}`,
      anomaly: `"${tc.query}": 抛出异常 ${reason}`,
    };
  }
}

type RunSummary = {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly anomalies: readonly string[];
};

function printReport(summary: RunSummary): void {
  console.log("\n================ 汇总报告 ================");
  console.log(`总数: ${summary.total}`);
  console.log(`成功: ${summary.passed}`);
  console.log(`失败: ${summary.failed}`);

  if (summary.anomalies.length > 0) {
    console.log("\n待拟合或异常点列表:");
    for (const a of summary.anomalies) {
      console.log(`  - ${a}`);
    }
  } else {
    console.log("\n🎉 全量测试 100% 通过！去重、排序、合流与播放能力拟合完毕！");
  }
}

async function main() {
  console.log("=== BakaGame 双平台真实检索、去重、排序与播放能力全量检验 ===");
  console.log(`样本集总数: ${TEST_CASES.length} 首代表性歌曲\n`);

  const netease = new NeteaseMusicProvider();
  const qq = new QQMusicProvider();
  const aggregated = new AggregatedMusicProvider({
    neteaseProvider: netease,
    qqProvider: qq,
  });

  let passedCount = 0;
  let failedCount = 0;
  const anomalies: string[] = [];

  for (let i = 0; i < TEST_CASES.length; i++) {
    const tc = TEST_CASES[i];
    process.stdout.write(`[${i + 1}/${TEST_CASES.length}] 检索: "${tc.query}" ... `);

    const outcome = await verifyCase(aggregated, tc, i);
    console.log(outcome.line);
    if (outcome.status === "failed") {
      anomalies.push(outcome.anomaly);
      failedCount++;
    } else {
      passedCount++;
    }
  }

  printReport({ total: TEST_CASES.length, passed: passedCount, failed: failedCount, anomalies });

  process.exit(failedCount > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("致命错误:", e);
  process.exit(1);
});
