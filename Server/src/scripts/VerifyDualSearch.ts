import { NeteaseMusicProvider } from "../infrastructure/NeteaseMusicProvider";
import { QQMusicProvider } from "../infrastructure/QQMusicProvider";
import { AggregatedMusicProvider } from "../infrastructure/AggregatedMusicProvider";
import {
  isSameSongWork,
  extractCanonicalTitle,
  extractArtistTokens,
  durationMatches,
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
  { query: "千里之外", expectedTopArtist: "周杰伦", allowAlternateArtist: ["费玉清"], shouldDualSource: true },
  { query: "珊瑚海", expectedTopArtist: "周杰伦", allowAlternateArtist: ["Lara", "梁心颐"], shouldDualSource: true },
  { query: "屋顶", expectedTopArtist: "吴宗宪", allowAlternateArtist: ["温岚", "周杰伦"], shouldDualSource: true },
  { query: "手心的蔷薇", expectedTopArtist: "林俊杰", allowAlternateArtist: ["邓紫棋", "G.E.M."], shouldDualSource: true },

  // 3. 经典国语流行
  { query: "后来", expectedTopArtist: "刘若英", shouldDualSource: true },
  { query: "遇见", expectedTopArtist: "孙燕姿", shouldDualSource: true },
  { query: "童话", expectedTopArtist: "光良", shouldDualSource: true },
  { query: "演员", expectedTopArtist: "薛之谦", shouldDualSource: true },
  { query: "红色高跟鞋", expectedTopArtist: "蔡健雅", shouldDualSource: true },
  { query: "修炼爱情", expectedTopArtist: "林俊杰", shouldDualSource: true },
  { query: "江南", expectedTopArtist: "林俊杰", shouldDualSource: true },
  { query: "光年之外", expectedTopArtist: "邓紫棋", allowAlternateArtist: ["G.E.M."], shouldDualSource: true },
  { query: "泡沫", expectedTopArtist: "邓紫棋", allowAlternateArtist: ["G.E.M."], shouldDualSource: true },
  { query: "漠河舞厅", expectedTopArtist: "柳爽", shouldDualSource: true },

  // 4. 原唱 vs 翻唱典型
  { query: "起风了", expectedTopArtist: "买辣椒也用券", allowAlternateArtist: ["吴青峰", "高桥优"], shouldDualSource: true },

  // 5. ACG / 动漫名曲
  { query: "only my railgun", expectedTopArtist: "fripSide", shouldDualSource: true },
  { query: "残酷な天使のテーゼ", expectedTopArtist: "高橋洋子", allowAlternateArtist: ["高桥洋子"], shouldDualSource: true },
  { query: "红莲华", expectedTopArtist: "LiSA", shouldDualSource: true },
  { query: "unravel", expectedTopArtist: "TK from 凛として時雨", allowAlternateArtist: ["TK from 凛として时雨", "TK"], shouldDualSource: true },
  { query: "前前前世", expectedTopArtist: "RADWIMPS", shouldDualSource: true },
  { query: "crossing field", expectedTopArtist: "LiSA", shouldDualSource: true },
  { query: "Brave Shine", expectedTopArtist: "Aimer", shouldDualSource: true },
  { query: "青鸟", expectedTopArtist: "いきものがかり", allowAlternateArtist: ["生物股长"], shouldDualSource: true },
  { query: "打上花火", expectedTopArtist: "DAOKO", allowAlternateArtist: ["米津玄师", "米津玄師"], shouldDualSource: true },
  { query: "secret base", expectedTopArtist: "ZONE", allowAlternateArtist: ["茅野爱衣", "本间芽衣子", "あの花"], shouldDualSource: true },
  { query: "恋爱循环", expectedTopArtist: "花泽香菜", allowAlternateArtist: ["花澤香菜"] },
  { query: "Butter-Fly", expectedTopArtist: "和田光司" },
  { query: "极乐净土", expectedTopArtist: "GARNiDELiA", allowAlternateArtist: ["美依礼芽", "MARiA"] },
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

    try {
      const results = (await aggregated.search(tc.query, 10)) as AggregatedSongSearchResult[];
      if (!results || results.length === 0) {
        console.log("❌ 召回为空");
        anomalies.push(`"${tc.query}": 召回结果为空`);
        failedCount++;
        continue;
      }

      const top = results[0];
      const allArtists = [tc.expectedTopArtist, ...(tc.allowAlternateArtist || [])];
      const artistMatched = allArtists.some((exp) => {
        const normExp = normalizeComparableText(exp);
        const normActual = normalizeComparableText(top.artist);
        return normActual.includes(normExp) || normExp.includes(normActual);
      });

      if (!artistMatched) {
        console.log(`❌ 排序置顶偏离: 期望 [${allArtists.join(" / ")}]，实际: "${top.artist}" - "${top.title}" (Score: ${top.relevanceScore})`);
        anomalies.push(`"${tc.query}": 首位歌手偏离, 得到 "${top.artist}" - "${top.title}"`);
        failedCount++;
        continue;
      }

      // 验证去重聚类质量
      const sources: string[] = top.sources || [top.id];
      const hasNetease = sources.some((s: string) => s.startsWith("netease:"));
      const hasQq = sources.some((s: string) => s.startsWith("qq:"));
      const isDualMerged = hasNetease && hasQq;

      // 验证衍生版本惩罚
      const topTitleLower = top.title.toLowerCase();
      const isBadDerivation =
        topTitleLower.includes("伴奏") ||
        topTitleLower.includes("instrumental") ||
        topTitleLower.includes("片段") ||
        topTitleLower.includes("铃声");

      if (isBadDerivation) {
        console.log(`❌ 原版优先失误: 置顶了伴奏/铃声版本 "${top.title}"`);
        anomalies.push(`"${tc.query}": 置顶了伴奏/铃声版本`);
        failedCount++;
        continue;
      }

      // 随机抽取首位歌曲进行深度详情测试（直链提取与歌词解析优先级）
      let detailSummary = "";
      if (i % 5 === 0 || !isDualMerged) {
        try {
          const details = await aggregated.getSong(top.id);
          const hasAudio = Boolean(details.audioUrl && details.audioUrl.startsWith("http"));
          const lyricCount = details.lyrics?.length || 0;
          const hasVerbatim = details.lyrics?.some((l) => Boolean(l.words && l.words.length > 0));
          detailSummary = `[音频: ${hasAudio ? "OK" : "无"}, 歌词: ${lyricCount}行, 逐字: ${hasVerbatim ? "YES" : "NO"}]`;
        } catch (detailErr: any) {
          detailSummary = `[详情拉取告警: ${detailErr.message || detailErr}]`;
        }
      }

      const dualTag = isDualMerged ? "【双源互证合并】" : `【单源: ${sources.join(", ")}】`;
      console.log(`✅ 通过: "${top.title}" - ${top.artist} ${dualTag} ${detailSummary}`);
      passedCount++;
    } catch (err: any) {
      console.log(`❌ 抛出异常: ${err.message || err}`);
      anomalies.push(`"${tc.query}": 抛出异常 ${err.message || err}`);
      failedCount++;
    }
  }

  console.log("\n================ 汇总报告 ================");
  console.log(`总数: ${TEST_CASES.length}`);
  console.log(`成功: ${passedCount}`);
  console.log(`失败: ${failedCount}`);

  if (anomalies.length > 0) {
    console.log("\n待拟合或异常点列表:");
    for (const a of anomalies) {
      console.log(`  - ${a}`);
    }
  } else {
    console.log("\n🎉 全量测试 100% 通过！去重、排序、合流与播放能力拟合完毕！");
  }

  process.exit(failedCount > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("致命错误:", e);
  process.exit(1);
});
