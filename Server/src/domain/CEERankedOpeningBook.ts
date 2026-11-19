import type { CEECharacterView, CEESettings } from "../shared/CEE";
import { type CEERankedCandidate, rankCEEOpeningGuesses } from "./CEERankedSolver";

/**
 * 排位人机的开局谱：离线开局分析（2026-10-13，本地数据集全库评估）里挑出的开局角色。
 *
 * - `solver`：在近五年热门前 20 / 50 / 100 作品的主角池上精确评估的前 30，以及热度不低于 10、
 *   不低于 100 的全库池与几种全集池里「知名角色」的前列；
 * - `famous`：高知名度精选名单，人类玩家最常用来开局的一类角色。
 *
 * 运行期按本场题库重新评估这些开局的切分效果并排序（见题库端口的 `openings`），名单本身不随题库变化。
 * 热度低于 `CEE_RANKED_OPENING_POPULARITY_MIN` 的开局在运行期剔除：人机不用冷门角色开局。
 */
export interface CEERankedOpeningBookEntry {
  id: number;
  name: string;
  solver: boolean;
  famous: boolean;
}

/** 开局角色的热度下限。 */
export const CEE_RANKED_OPENING_POPULARITY_MIN = 100;

/**
 * 人机开局候选：开局谱条目 + 运行期按本场题库评估出的切分效果。
 *
 * 定义在领域层是因为两边都要用：题库端口回的就是这个形状，人机第一手只认它。
 */
export interface CEERankedOpening {
  id: number;
  /** 按本场题库权重抽到答案时，猜完这一手期望还剩几个候选。 */
  expectedRemaining: number;
  worstClass: number;
  /** 离线分析里切分效果好的开局。 */
  solver: boolean;
  /** 人类最常用的高知名度开局。 */
  famous: boolean;
  /** 开局角色自身热度：弱档按它加权挑开局。 */
  popularity: number;
}

/**
 * 把开局谱装配到某一档题库上：热度达标的条目按切分效果排序成 `openings`，
 * 题库之外的开局视图（含 `extraIds`，它们不受热度下限约束）按 id 升序回传。
 *
 * `viewOf` 取不到角色时返回 undefined，该条目跳过：开局谱来自全库离线分析，
 * 某档题库或本地数据集里可能没有她。装配放领域层是为了 worker 与标定脚本同口径。
 */
export async function assembleCEERankedOpenings(input: {
  candidates: readonly CEERankedCandidate[];
  settings: CEESettings;
  viewOf: (id: number) => Promise<CEECharacterView | undefined>;
  /** 开局谱之外还要尝试取视图的角色（爱噶的首猜）。 */
  extraIds?: readonly number[];
}): Promise<{ openings: CEERankedOpening[]; extras: CEECharacterView[] }> {
  const pool = new Map(input.candidates.map((item) => [item.character.id, item.character]));
  const ids = new Set<number>(CEE_RANKED_OPENING_BOOK.map((entry) => entry.id));
  for (const id of input.extraIds ?? []) ids.add(id);
  const views = new Map<number, CEECharacterView>();
  for (const id of ids) {
    const inPool = pool.get(id);
    if (inPool) views.set(id, inPool);
    else {
      const view = await input.viewOf(id);
      if (view) views.set(id, view);
    }
  }
  const entryById = new Map(CEE_RANKED_OPENING_BOOK.map((entry) => [entry.id, entry]));
  const choices = [...views.values()].flatMap((view) => {
    const entry = entryById.get(view.id);
    // 冷门开局不上场，但视图仍留在 extras 里。
    if (!entry || view.popularity < CEE_RANKED_OPENING_POPULARITY_MIN) return [];
    return [{ view, entry }];
  });
  const metaById = new Map(choices.map((choice) => [choice.view.id, choice]));
  const openings = rankCEEOpeningGuesses(
    choices.map((choice) => choice.view),
    input.candidates,
    input.settings
  ).flatMap((result) => {
    const meta = metaById.get(result.id);
    if (!meta) return [];
    return [
      {
        ...result,
        solver: meta.entry.solver,
        famous: meta.entry.famous,
        popularity: meta.view.popularity,
      },
    ];
  });
  const extras = [...views.values()]
    .filter((view) => !pool.has(view.id))
    .sort((a, b) => a.id - b.id);
  return { openings, extras };
}

export const CEE_RANKED_OPENING_BOOK: readonly CEERankedOpeningBookEntry[] = [
  { id: 8, name: "坂上智代", solver: true, famous: true },
  { id: 48, name: "凉宫春日", solver: false, famous: true },
  { id: 273, name: "阿尔托莉雅·潘德拉贡", solver: false, famous: true },
  { id: 362, name: "来谷唯湖", solver: true, famous: false },
  { id: 878, name: "空条承太郎", solver: false, famous: true },
  { id: 951, name: "夏娜", solver: true, famous: true },
  { id: 1000, name: "美坂栞", solver: true, famous: false },
  { id: 1762, name: "逢坂大河", solver: false, famous: true },
  { id: 2162, name: "漩涡鸣人", solver: false, famous: true },
  { id: 2215, name: "夜神月", solver: false, famous: true },
  { id: 2358, name: "蒙奇·D·路飞", solver: false, famous: true },
  { id: 2359, name: "罗罗诺亚·索隆", solver: false, famous: true },
  { id: 2360, name: "娜美", solver: false, famous: true },
  { id: 2372, name: "妮可·罗宾", solver: false, famous: true },
  { id: 2414, name: "桂雏菊", solver: true, famous: false },
  { id: 2629, name: "茵蒂克斯", solver: true, famous: false },
  { id: 3215, name: "间桐樱", solver: false, famous: true },
  { id: 3221, name: "卫宫切嗣", solver: true, famous: true },
  { id: 3320, name: "黑崎一护", solver: false, famous: true },
  { id: 3345, name: "孙悟空", solver: true, famous: false },
  { id: 3453, name: "江户川柯南", solver: false, famous: true },
  { id: 3499, name: "毛利兰", solver: true, famous: true },
  { id: 3575, name: "御坂美琴", solver: false, famous: true },
  { id: 3576, name: "白井黑子", solver: true, famous: false },
  { id: 4363, name: "朽木露琪亚", solver: false, famous: true },
  { id: 6500, name: "宇智波佐助", solver: false, famous: true },
  { id: 6536, name: "旗木卡卡西", solver: false, famous: true },
  { id: 6827, name: "春野樱", solver: false, famous: true },
  { id: 6911, name: "宇智波鼬", solver: true, famous: false },
  { id: 7043, name: "灰原哀", solver: false, famous: true },
  { id: 7251, name: "哆啦A梦", solver: false, famous: true },
  { id: 7259, name: "野比大雄", solver: false, famous: true },
  { id: 7260, name: "源静香", solver: false, famous: true },
  { id: 9531, name: "纪田正臣", solver: true, famous: false },
  { id: 10570, name: "两仪式", solver: false, famous: true },
  { id: 10596, name: "远坂凛", solver: false, famous: true },
  { id: 10609, name: "立华奏", solver: false, famous: true },
  { id: 10612, name: "仲村由理", solver: true, famous: false },
  { id: 10628, name: "芳冈由依", solver: true, famous: false },
  { id: 12082, name: "此花露西娅", solver: true, famous: false },
  { id: 12392, name: "冈部伦太郎", solver: false, famous: true },
  { id: 12393, name: "牧濑红莉栖", solver: false, famous: true },
  { id: 12469, name: "最后之作", solver: true, famous: false },
  { id: 12566, name: "神崎·H·亚里亚", solver: true, famous: false },
  { id: 13742, name: "髅髅宫歌留多", solver: true, famous: false },
  { id: 14822, name: "折木奉太郎", solver: true, famous: true },
  { id: 14823, name: "千反田爱瑠", solver: false, famous: true },
  { id: 14824, name: "福部里志", solver: true, famous: false },
  { id: 16490, name: "亚丝娜／结城明日奈", solver: false, famous: true },
  { id: 17588, name: "堀京子", solver: true, famous: false },
  { id: 17591, name: "吉川由纪", solver: true, famous: false },
  { id: 17960, name: "北白川玉子", solver: true, famous: false },
  { id: 18101, name: "艾伦·耶格尔", solver: false, famous: true },
  { id: 18102, name: "三笠·阿克曼", solver: false, famous: true },
  { id: 19040, name: "雪之下雪乃", solver: true, famous: true },
  { id: 19041, name: "由比滨结衣", solver: false, famous: true },
  { id: 19243, name: "埼玉", solver: true, famous: true },
  { id: 19525, name: "夜刀神十香", solver: true, famous: false },
  { id: 19526, name: "鸢一折纸", solver: true, famous: false },
  { id: 19527, name: "五河琴里", solver: true, famous: false },
  { id: 19528, name: "冰芽川四糸乃", solver: true, famous: false },
  { id: 19529, name: "时崎狂三", solver: true, famous: true },
  { id: 19546, name: "利威尔", solver: false, famous: true },
  { id: 19658, name: "游佐惠美", solver: true, famous: false },
  { id: 20481, name: "爱丽丝·卡塔雷特", solver: true, famous: false },
  { id: 20589, name: "涅普迪努", solver: true, famous: false },
  { id: 20893, name: "名濑美月", solver: true, famous: false },
  { id: 21627, name: "姬柊雪菜", solver: true, famous: false },
  { id: 21628, name: "蓝羽浅葱", solver: true, famous: false },
  { id: 21631, name: "南宫那月", solver: true, famous: false },
  { id: 22520, name: "和泉纱雾", solver: true, famous: false },
  { id: 23651, name: "桐间纱路", solver: true, famous: false },
  { id: 24094, name: "加藤惠", solver: false, famous: true },
  { id: 25201, name: "雾岛董香", solver: true, famous: false },
  { id: 25240, name: "诗乃／朝田诗乃", solver: true, famous: false },
  { id: 26002, name: "有马公生", solver: true, famous: false },
  { id: 26090, name: "一色彩羽", solver: false, famous: true },
  { id: 26456, name: "诺艾尔", solver: true, famous: false },
  { id: 27412, name: "结城友奈", solver: true, famous: false },
  { id: 27601, name: "玛露西尔", solver: true, famous: true },
  { id: 29212, name: "赫斯缇雅", solver: true, famous: false },
  { id: 29284, name: "川岛绿辉", solver: true, famous: false },
  { id: 29511, name: "友利奈绪", solver: true, famous: false },
  { id: 33392, name: "雅儿贝德", solver: true, famous: false },
  { id: 35608, name: "艾米莉娅", solver: false, famous: true },
  { id: 35615, name: "蕾姆", solver: false, famous: true },
  { id: 35647, name: "远藤沙耶", solver: true, famous: false },
  { id: 35681, name: "惠惠", solver: false, famous: true },
  { id: 35980, name: "樱岛麻衣", solver: true, famous: false },
  { id: 36495, name: "八神光", solver: true, famous: false },
  { id: 36560, name: "芙蕾雅·薇恩", solver: true, famous: false },
  { id: 37242, name: "宫水三叶", solver: true, famous: true },
  { id: 37455, name: "无名", solver: true, famous: false },
  { id: 37457, name: "四方川菖蒲", solver: true, famous: false },
  { id: 39850, name: "莱欧斯", solver: true, famous: false },
  { id: 43164, name: "花园多惠", solver: true, famous: false },
  { id: 43168, name: "市谷有咲", solver: true, famous: false },
  { id: 47658, name: "小林小姐", solver: true, famous: false },
  { id: 47659, name: "托尔", solver: true, famous: false },
  { id: 47696, name: "艾露玛", solver: true, famous: true },
  { id: 47697, name: "露科亚", solver: true, famous: false },
  { id: 50576, name: "特别周", solver: true, famous: false },
  { id: 53770, name: "一之濑帆波", solver: true, famous: false },
  { id: 54297, name: "法琳", solver: true, famous: false },
  { id: 55355, name: "樱之宫莓香", solver: true, famous: false },
  { id: 57305, name: "灶门炭治郎", solver: false, famous: true },
  { id: 57306, name: "灶门祢豆子", solver: false, famous: true },
  { id: 57307, name: "我妻善逸", solver: false, famous: true },
  { id: 57312, name: "栗花落香奈乎", solver: true, famous: false },
  { id: 57673, name: "尤莉", solver: true, famous: false },
  { id: 57715, name: "弗拉迪蕾娜·米丽洁", solver: true, famous: true },
  { id: 61405, name: "中野二乃", solver: true, famous: false },
  { id: 61406, name: "中野三玖", solver: true, famous: false },
  { id: 61551, name: "双叶理央", solver: true, famous: false },
  { id: 63019, name: "邪神酱", solver: true, famous: false },
  { id: 63863, name: "畔美岬", solver: true, famous: false },
  { id: 64641, name: "新条茜", solver: true, famous: false },
  { id: 66614, name: "岩永琴子", solver: true, famous: false },
  { id: 66717, name: "荻原沙优", solver: true, famous: false },
  { id: 66728, name: "白咲花", solver: true, famous: false },
  { id: 66899, name: "四宫辉夜", solver: true, famous: true },
  { id: 66900, name: "白银御行", solver: true, famous: false },
  { id: 67410, name: "早坂爱", solver: true, famous: false },
  { id: 71337, name: "玛奇玛", solver: false, famous: true },
  { id: 71477, name: "劳埃德·福杰", solver: true, famous: false },
  { id: 71478, name: "约尔·福杰", solver: false, famous: true },
  { id: 71479, name: "阿尼亚·福杰", solver: false, famous: true },
  { id: 72349, name: "卡塔丽娜·克拉斯", solver: true, famous: false },
  { id: 72994, name: "妮妮姆·拉雷", solver: true, famous: false },
  { id: 73338, name: "钉崎野蔷薇", solver: true, famous: false },
  { id: 74068, name: "后藤姬", solver: true, famous: false },
  { id: 74243, name: "五条悟", solver: false, famous: true },
  { id: 74330, name: "蒂诺·薛德", solver: true, famous: false },
  { id: 77208, name: "唐可可", solver: true, famous: false },
  { id: 86246, name: "芙莉莲", solver: false, famous: true },
  { id: 87821, name: "羽前京香", solver: true, famous: false },
  { id: 87825, name: "出云天花", solver: true, famous: false },
  { id: 87973, name: "伊地知虹夏", solver: true, famous: true },
  { id: 87974, name: "山田凉", solver: false, famous: true },
  { id: 87975, name: "喜多郁代", solver: false, famous: true },
  { id: 88670, name: "大户爱", solver: true, famous: false },
  { id: 91630, name: "星崎理香", solver: true, famous: false },
  { id: 91632, name: "桐生紫乃", solver: true, famous: false },
  { id: 101318, name: "式守都", solver: true, famous: false },
  { id: 101793, name: "王冢真唯", solver: true, famous: false },
  { id: 101794, name: "濑名紫阳花", solver: true, famous: true },
  { id: 101795, name: "琴纱月", solver: true, famous: false },
  { id: 102125, name: "阿库亚 / 星野爱久爱海", solver: true, famous: false },
  { id: 106384, name: "戴尔塔", solver: true, famous: false },
  { id: 111329, name: "烧盐柠檬", solver: true, famous: false },
  { id: 111918, name: "斯莱塔·墨丘利", solver: true, famous: false },
  { id: 111919, name: "米奥莉奈·伦布兰", solver: true, famous: false },
  { id: 112127, name: "绫濑桃", solver: true, famous: false },
  { id: 112131, name: "白鸟爱罗", solver: true, famous: false },
  { id: 114317, name: "渡边星", solver: true, famous: false },
  { id: 115899, name: "出云风子", solver: true, famous: false },
  { id: 123758, name: "缇娜夏", solver: true, famous: false },
  { id: 127790, name: "高松灯", solver: false, famous: true },
  { id: 127791, name: "千早爱音", solver: false, famous: true },
  { id: 127792, name: "要乐奈", solver: false, famous: true },
  { id: 130664, name: "井芹仁菜", solver: true, famous: true },
  { id: 132476, name: "丰川祥子", solver: false, famous: true },
  { id: 132477, name: "若叶睦", solver: false, famous: true },
  { id: 132479, name: "三角初华", solver: false, famous: true },
  { id: 132525, name: "荣逢凪乃", solver: true, famous: false },
  { id: 132838, name: "希露法", solver: true, famous: false },
  { id: 132924, name: "八幡海铃", solver: true, famous: true },
  { id: 152267, name: "爱尔法利亚·亚尔维斯·赛尔佛特", solver: true, famous: false },
  { id: 152841, name: "珂蕾特·罗瓦尔", solver: true, famous: false },
  { id: 153903, name: "虎视虎子", solver: true, famous: false },
  { id: 164316, name: "荒砥凪", solver: true, famous: false },
  { id: 165411, name: "风卷花", solver: true, famous: false },
  { id: 183861, name: "仲町阿拉蕾", solver: true, famous: false },
];
