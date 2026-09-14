/**
 * 歌词无效行判定的词表数据（纯数据 + 派生正则），从 `NeteaseMusicProvider.ts` 拆出。
 *
 * 条目来源：R5–R17 共 17 轮「收藏歌单随机抽样 → 疑似行人工分诊 → 修复」循环的实测沉淀，
 * 已按语义分组合并、去除重复条目与按轮注释。改动前须知：
 * - 新增条目必须同步补 `Server/test/NeteaseMusicProvider.test.ts` 用例，并跑
 *   `Agents/NeteaseMusicApi.md` 记录的探针与真实歌曲复测，细则见该文档；
 * - 部分高频词（`音乐`/`感谢`/`背景` 等）的**空格形态**是正常歌词，
 *   依赖 `SPACE_SPLIT_HEAD_DENY` 保留，删 DENY 条目前先看该表注释。
 */

/** 中文 · 词曲编录制作通用署名（含繁体写法与单字缩写）。 */
const ZH_PRODUCTION_LABELS = [
  "作词(?:人|者)?", "填词", "词曲", "词", "作曲(?:人|者)?", "谱曲", "曲", "制谱",
  "乐谱", "(?:上台)?乐手", "编曲(?:人|师|者)?", "制作人", "制作", "监制(?:人)?", "统筹",
  "发行", "出品", "策划", "企划", "承制", "制作协力", "协力", "协助", "后援", "监唱",
  "以下段落", "(?:词曲|作词|作曲)(?:提供|来源)", "改编词曲", "改编编曲", "词作",
  // 繁体写法（港台上传谱高频）：`編曲 Arrange : X`。
  "作詞(?:人)?", "編曲(?:人|师)?", "製作(?:人)?", "監製(?:人)?", "後期", "翻譯", "字幕組",
  "出品人", "发行人", "监制人", "策划人", "企划人", "指挥", "演奏指挥",
  "录制", "歌", "助理", "工程师", "翻译", "(?:英|日|韩)译", "单品策划", "人设", "加工",
  "配唱(?:编写)?", "配唱", "作品管理", "经纪", "制作人经纪", "团队", "艺人",
  // 助理/副手与总监类：`混音助理 : X`、`艺人合作总监 : X`。
  "制作助理", "混音助理", "录音助理", "配唱助理", "附加制作",
  "艺人(?:合作)?总监", "项目总监", "内容总监", "节目总监", "总监制", "总监",
  // 单字缩写（同人圈）：`编：X`、`混：X`、`母：X`、`唱：人名串`。
  "编", "混", "母", "唱",
  "(?:中文|粤语|国语)填词",
];

/** 中文 · 「音乐X」复合标签。单独枚举而不放宽「覆盖整个头部」约束，避免 `音乐响起：` 这类歌词被误杀；裸 `音乐` 在泛化组，空格形态由 DENY 保护。 */
const ZH_MUSIC_PREFIX_LABELS = [
  "音乐制作", "音乐监制", "音乐指导", "音乐统筹", "音乐总监", "音乐设计", "音乐混音",
  "音乐出品", "音乐制作人", "音乐总监制", "音乐营销", "音乐发行", "音乐监督",
  "音乐项目总监", "音乐助理", "音乐编辑", "音乐公司", "合作音乐人",
  "(?:计算机)?音乐编成", "歌词制作",
];

/** 中文 · 专辑与元信息：专辑名/歌名/原作名都是答案泄露源。 */
const ZH_META_LABELS = [
  "专辑制作", "专辑封面(?:设计)?", "封面设计", "视觉设计", "专辑",
  "歌曲原名", "原曲名", "歌曲名", "歌名", "原唱名", "本名", "曲名", "楽曲名", "タイトル",
  "bài\\s+hát", "canción", "video", "原作", "前作", "特别说明",
  "通称", "別名", "别名", "別称", "又称", "又名",
];

/** 中文 · 机构、出版与营销：这类行给出的是机构而非歌词。 */
const ZH_ORG_LABELS = [
  "制作公司", "出品公司", "发行公司", "签约公司", "文化传媒", "传媒", "厂牌", "唱片",
  "唱片公司", "工作室", "录音室(?!$)", "企划宣传", "宣传", "推广", "营销", "营销推广",
  "商务", "商务统筹", "统筹企划", "总企划", "歌曲企划", "机构", "项目", "宣发(?:支持|执行)?",
  "联合出品", "联合推广", "特别支持", "温馨提示", "协助单位", "合作单位", "电影原声发行",
  "(?:独家)?短视频平台", "出品方", "制作方", "发行方",
];

/** 中文 · 致谢：冒号形态是署名（`感谢：X`）；空格形态是歌词（`感谢 陪伴`），由 DENY 保护。 */
const ZH_THANKS_LABELS = [
  "鸣谢", "特别鸣谢", "特别感谢", "致谢", "感谢",
];

/** 中文 · 录音、混音、母带与音频工程。 */
const ZH_RECORDING_LABELS = [
  // `录音(?:师|棚|室)?` 必须保留可选后缀形态：它同时覆盖 录音师/录音棚/录音室，
  // 改成字面并列会让取值含点的行（`录音棚：C.L.K`）掉出词表路径（结构判定因 `.` 否决）。
  "混音(?:师)?", "录音(?:师|棚|室)?", "混音室", "混音录音室", "录音棚", "录音室",
  "母带(?:处理|工程师)?", "母带制作", "母带工作室", "混音工作室", "录音工作室",
  "母带助理", "母带制作人", "母版",
  // `母带后期处理` 只保留这一条展开条目（含 录音室|制作人 两种后缀），**不要**再登记
  // 字面并列的旧形态 —— 字面长度并列时源码顺序靠前者会抢先匹配并在可选组前截断。
  "母带后期处理(?:录音室|制作人)?",
  "混音母带", "录音制作", "录音工程", "混音工程", "录音版权", "录音时间", "录音软件操作",
  "软件操作", "分轨混音", "录混", "贴混", "后期混音", "缩混", "声音剪辑", "音频编辑",
  "音频剪辑", "音频助理", "音频工程师", "音响", "前台及舞台音响", "舞台音响",
  "混音工程师", "录音工程师", "母带工程师", "声音工程师", "乐器录音师", "人声录音师",
  "人声录音工程师", "人声录音", "人声录音棚", "吉他录音", "贝斯录音", "鼓录音", "钢琴录音",
  "弦乐录音师", "主唱录音", "弦乐录音", "管乐录音", "乐器录音", "弦乐录制",
  "midi工程", "编曲工程", "人声编辑",
];

/** 中文 · 和声、伴唱与虚拟歌手。 */
const ZH_VOCAL_LABELS = [
  "虚拟人声", "虚拟歌手", "声库", "音源", "主人声", "副人声",
  "和声(?:编写)?", "和音(?:编写|配唱)?", "合音(?:编写)?", "和声配唱", "和声演唱", "和声录唱",
  "合声", "合声编写", "合声配唱", "伴唱", "编写", "和编", "合编",
  "配唱制作人", "配唱编写",
  // 民族语言伴唱署名：`苗族伴唱：X`。
  "(?:苗|侗|彝|藏|蒙|维|朝|壮|瑶|白|傣)(?:族|语)?伴唱",
];

/** 中文 · 演唱、声部与戏曲。 */
const ZH_SINGING_LABELS = [
  "演唱", "主唱", "歌手", "翻唱", "翻策", "原唱", "原曲", "本家", "v本家",
  "男", "女", "合", "合唱", "对唱", "独唱", "童声", "念白", "朗诵", "口白",
  "人声", "声乐", "说唱", "rap", "戏腔", "京剧",
  "特邀", "参演", "配音", "表演(?:者)?",
];

/** 中文 · 演奏、编制与指挥。 */
const ZH_ENSEMBLE_LABELS = [
  "演奏", "独奏", "合奏", "伴奏", "实录", "弦乐实录", "弦乐(?:编写)?", "弦乐演奏",
  "弦乐乐团", "管弦乐团", "管弦乐", "弦乐团", "乐队", "乐团", "乐队队长", "队长", "首席",
  "弦乐指挥", "弦乐编写", "弦乐统筹", "弦乐翻译", "配器", "编程", "程序编排", "谱务",
];

/** 中文 · 乐器（西洋、民族、日系）。 */
const ZH_INSTRUMENT_LABELS = [
  "吉他", "贝斯", "鼓", "乐器", "电?贝斯", "贝司", "电贝司", "低音吉他", "民谣吉他",
  "木吉他", "电吉他", "原声吉他", "古典吉他", "钢琴", "电钢", "电子琴", "键盘", "键盘手",
  "合成器", "(?:电子|仿音)合成器", "键琴", "合成", "架子鼓", "爵士鼓", "手鼓",
  "(?:新疆)?手鼓", "铃鼓", "三角铁", "钟琴", "打击乐", "萨克斯", "长笛", "短笛", "口琴",
  "口哨", "笛子", "笛箫", "箫", "唢呐", "竖笛", "竖琴", "管风琴", "管乐", "器乐", "铜管",
  "弦乐", "英国管", "曼陀林", "尤克里里", "西塔尔琴", "班苏里笛", "萨兹琴",
  "小提琴", "第一小提琴", "第二小提琴", "中提琴", "大提琴", "低音提琴",
  "长号", "小号", "圆号", "大号", "双簧管", "单簧管", "巴松",
  "古筝", "古琴", "琵琶", "二胡", "三弦", "扬琴", "柳琴", "阮", "笙", "箏", "马头琴",
  "手风琴", "热瓦普", "冬不拉", "班卓琴", "民乐", "中国笛", "爱尔兰哨笛", "哨笛",
  "尺八", "三味线", "太鼓",
];

/** 中文 · 美术、视频与同人圈分工。 */
const ZH_ART_LABELS = [
  "画师", "绘画", "绘", "绘图", "曲绘", "插画", "美工", "题字", "排版", "设计",
  "黑胶设计", "海报", "封面", "后期", "视频", "压制", "字幕", "轴", "校对", "文案",
  "调教", "调校", "语调教", "调声", "调音", "采样", "混响", "音效", "pv",
  "导演", "调色", "服装", "监督", "注", "社团", "物料", "二创效果",
  // 单字缩写（同人圈）：`调：X`（调教）、`影：X`（影像制作）。
  "调", "影",
  "歌词传导", "翻译传导",
];

/** 中文 · 高频泛化署名词：这些词同时是高频歌词开头（`音乐 我的生命` 是歌词排比），空格形态由 SPACE_SPLIT_HEAD_DENY 保护，只信冒号形态。 */
const ZH_GENERIC_LABELS = [
  "音乐", "歌词", "故事", "视觉", "鼓手", "背景", "贡献者", "特别合作", "宣推",
];

/** 中文 · 版权。 */
const ZH_COPYRIGHT_LABELS = [
  "版权管理方", "版权", "版权方", "版权代理", "授权", "录音作品", "录音制品",
];

/** 英文 · 通用署名、职位与「X by」动作形态。 */
const EN_PRODUCTION_LABELS = [
  "program", "program(?:ming)?", "programmed", "programmed\\s+by", "programming",
  "pgm", "md", "pd", "rec", "recording", "recording\\s+time", "recording\\s+pd",
  "arrangement", "arrangements?", "arrange", "arranged", "arranger", "arrangers?",
  "arranger\\s+by",
  "composer", "composers?", "composed\\s+by", "composer\\s+by",
  "arranged\\s+by",
  "lyric(?:s|ist)?", "lyricists?", "lyrics?\\s+by", "lyricist\\s+by", "music\\s+by",
  "producer", "producers?", "produced\\s+by", "producer\\s+by", "produce", "prodused",
  "vocal(?:s|ist)?", "vocaloid", "voice", "vocal", "vocal\\s+artist",
  "publisher", "publishers?", "publishing", "sub\\s+publishing",
  "mixing", "mastering", "mixed\\s+by", "mastered\\s+by",
  "engineers?(?:ing)?", "illustration", "artwork", "movie",
  "cast", "staff", "op", "sp",
  "assistant", "assistant\\s+engineer", "editing\\s+engineer",
  "musical\\s+supervisor", "supervisor", "coordinator", "management", "manager",
  "director", "directed\\s+by", "artists?", "scoring", "programmers?", "studios?", "sound",
  "compositions?", "renditions?", "instrumental", "production",
  "production\\s+coordination", "production\\s+co-ordination",
  "personnel", "operators?", "planner", "verse",
  "thanks?(?:\\s+to)?", "special\\s+thanks", "soloists?", "solos?",
  "recorded\\s+at", "engineered\\s+by",
  "written\\s+by", "performed\\s+by", "vocals?\\s+recorded\\s+at",
  "mixers?", "mix\\s*down", "mix\\s+engineering", "promotions?", "products?",
  "digital\\s+edited\\s+by", "audio\\s+editing", "project\\s+lead",
  "marketing", "marketing\\s+coordination", "agencies", "writers?",
  "opera\\s+tune", "vocal\\s?production", "present\\s+by",
  // 真实 LRC 高频错拼：`Arragement`、`backing vocal arrangemet`、`Hormony`。
  "arragement", "arrangemet", "hormony",
];

/** 英文 · 编排、配器与复合标签限定词（限定词单独出现不足以判署名，供逐词复合判定使用）。 */
const EN_ARRANGEMENT_LABELS = [
  "orchestration", "orchestral", "orchestra", "orchestrators?", "instrumentation",
  "conducting", "conductor", "band", "quartet", "ensemble", "choir",
  "harmony", "harmonies", "strings?", "horns?", "woodwinds?", "woodwind", "brass",
  "string", "rhythm", "music", "musical",
  "synthesizers?", "synthesizer", "synthesizer\\s+programming",
  "orchestral\\s+arrangements?", "vocal\\s+arrangements?", "vocal\\s+arrangement",
  "rhythm\\s+arrangements?", "string\\s+arranger(?:\\s*&\\s*conductor)?",
  "tuning", "chorus", "synth",
];

/** 英文 · 乐器与音源。 */
const EN_INSTRUMENT_LABELS = [
  "guitars?", "bass", "drums?", "piano", "keyboards?", "keyboards?(?:\\s*&\\s*programming)?",
  "violin", "violins?", "viola", "cello", "violoncello", "contrabass", "organ", "harpsichord",
  "accordion", "vocoder", "percussion", "flute", "sax(?:ophone)?", "trumpet", "trombone",
  "oboe", "chamberlin", "piccolo", "erhu", "acoustic", "electric", "electronic",
  "acoustic\\s+guitar", "classical\\s+guitar", "electric\\s+guitar",
  "guzheng", "pipa", "dizi", "sitar", "saz", "bansuri", "koto", "shamisen", "taiko",
  "shakuhachi", "tenor", "baritone", "linn\\s+drum", "talk\\s*box", "b-?box",
  "lyricon", "rhodes", "e-mu", "emulator", "yamaha", "midi", "atmos",
  "1st\\s+violin", "2nd\\s+violin",
];

/** 英文 · 多词工程师/录音室与和声署名。 */
const EN_STUDIO_LABELS = [
  "mixing\\s+engineer", "mastering\\s+engineer", "recording\\s+engineers?",
  "instrumental\\s+recording\\s+engineers?", "vocal\\s+recording\\s+studio",
  "recording\\s+studio", "background\\s+vocals?", "background\\s+vocal\\s+arrangements?",
  "lead\\s+vocals?",
];

/** 英文 · 泛化限定词（逐词复合判定用；单独出现不判署名）。 */
const EN_GENERIC_LABELS = [
  "lead", "backing", "tracking", "editing", "digital", "audio", "house", "company",
  "additional", "additional\\s+engineering", "all",
];

/** 英文 · 元信息与原曲标注（OT/OA/RIT 家族直接泄露原曲信息）。 */
const EN_META_LABELS = [
  "ot", "oa", "original", "rit", "album", "isrc(?:\\s+no)?", "co-?production",
  "released?\\s+on",
];

/** 中文 + 英文全部署名标签，合并为正则可选分支源。 */
const CREDIT_LABEL_SOURCE = [
  ...ZH_PRODUCTION_LABELS,
  ...ZH_MUSIC_PREFIX_LABELS,
  ...ZH_META_LABELS,
  ...ZH_ORG_LABELS,
  ...ZH_THANKS_LABELS,
  ...ZH_RECORDING_LABELS,
  ...ZH_VOCAL_LABELS,
  ...ZH_SINGING_LABELS,
  ...ZH_ENSEMBLE_LABELS,
  ...ZH_INSTRUMENT_LABELS,
  ...ZH_ART_LABELS,
  ...ZH_GENERIC_LABELS,
  ...ZH_COPYRIGHT_LABELS,
  ...EN_PRODUCTION_LABELS,
  ...EN_ARRANGEMENT_LABELS,
  ...EN_INSTRUMENT_LABELS,
  ...EN_STUDIO_LABELS,
  ...EN_GENERIC_LABELS,
  ...EN_META_LABELS,
].join("|");

/**
 * 正则的可选分支按「先长后短」排序，避免短标签抢先匹配。
 * 例：`sp` 会以忽略大小写的方式吃掉 `Special Thanks` 的开头，`曲` 会吃掉 `曲绘`。
 *
 * **必须按字面匹配长度排序，而不是源码字符串长度**：`混音(?:师)?` 源码长度 10，
 * 但实际只匹配 2~3 个字符；若按源码长度排序，它会排到 `混音母带`（字面 4 字）之前，
 * 在 `^` 锚定下先吃掉 `混音` 两个字符就停下，导致 `混音母带：X` 整条掉出词表。
 * 因此剥离正则元字符后按**字面长度**排序（可选组 `?(...)` 内的字面一律不计，
 * 否则 `混音(?:师)?` 会被算成 4 而凭源码顺序抢先）。
 */
const sortLongestFirst = (source: string): string => {
  const splitAlternatives = (value: string): string[] => {
    const parts: string[] = [];
    let depth = 0;
    let current = "";
    for (let index = 0; index < value.length; index += 1) {
      const char = value[index];
      if (char === "\\") {
        current += char + (value[index + 1] ?? "");
        index += 1;
        continue;
      }
      if (char === "(") depth += 1;
      if (char === ")") depth -= 1;
      if (char === "|" && depth === 0) {
        parts.push(current);
        current = "";
        continue;
      }
      current += char;
    }
    parts.push(current);
    return parts;
  };

  const literalLength = (alternative: string): number => {
    const required = alternative.replace(/\(\?:[^()]*\)\?/g, "");
    return required.replace(/\\(.)/g, "$1").replace(/[()|^$.*+?[\]{}]/g, "").length;
  };

  return splitAlternatives(source)
    .sort((a, b) => literalLength(b) - literalLength(a))
    .join("|");
};

const CREDIT_LABEL_ALTERNATIVES = sortLongestFirst(CREDIT_LABEL_SOURCE);

/** 单个署名标签，允许两类常见复合形态：
 * - 中英混排后缀：`词Lyricist`、`曲Composer`、`翻唱Cover`
 * - 多标签连接：`策划/统筹`、`作词、作曲`、`监制&混音`、`Mixed & Mastered`
 */
export const CREDIT_LABEL_PATTERN = new RegExp(
  `^(?:${CREDIT_LABEL_ALTERNATIVES})(?:\\s*(?:&|＆|and|with)\\s*(?:${CREDIT_LABEL_ALTERNATIVES}))*`,
  "i",
);

/** 紧随中文标签的英文单后缀（`词Lyricist`、`曲Composer`）。 */
export const CREDIT_LABEL_SUFFIX_PATTERN = /^(?:[a-z]{2,20})$/i;

/** 多标签连接符：`策划/统筹`、`作词、作曲`、`监制&混音`、`和音编写及演唱`。
 * `及` 也算连接符：它只在头部拆分用，且拆出的**每段都必须是标签**，
 * 歌词头（`早餐及午餐：`）拆出的非标签段会自然否决。
 * **`和` 不能进通用 joiner**：它同时是 `和声`/`和音`/`和编` 等标签的首字，
 * 单字符切分会把 `吉他、贝司、和声` 切出孤立 `声` 段而整条漏网 ——
 * `和` 的拆分见 isCreditLabelOnly 末尾的独立分支。
 * `+` 需半/全角两个码位并存（`和声＋和声编写`）。 */
export const CREDIT_LABEL_JOINER_PATTERN = /[/／、,，&＆及+＋]/;

/** 可与并列词组合成复合署名的动作词：`Arranged & Conducted by`、`Mixed & Mastered by`、`Co-produced by`。 */
const CREDIT_ACTION_WORDS = [
  "arranged", "conducted", "mixed", "mastered", "recorded",
  "produced", "written", "composed", "performed", "programmed",
  "edited", "co-?produced",
];
// 注意必须用括号包住整组可选分支，否则 `^a|b|...|z$` 只会锚定首尾两项。
export const CREDIT_ACTION_PATTERN = new RegExp(`^(?:${CREDIT_ACTION_WORDS.join("|")})$`, "i");

/**
 * 英文制作署名短标签（Discogs 风格实体唱片信息）：
 * `Mixed At – Enterprise Studios`、`Distributed By – EMI (Taiwan) Ltd.`、`A&R – ...`。
 * 这类行分隔符是 en dash 而非冒号，且整体不是单个已知标签，词表与结构判定双双漏网。
 * 判定必须用**显式枚举**而不能放宽成「`<任意词> At/By`」——
 * 否则 `Killed By – the storm` 这类歌词会被整行误杀。
 */
export const EN_CREDIT_SHORT_LABELS = [
  "a&r", "a & r", "executive-producer", "executive producer", "presenter",
  "presented by", "backing vocals", "backing vocal", "vocal edite", "vocal edit",
  "art direction", "artwork by", "design by", "photography", "photography by",
  "liner notes", "booklet", "management by", "booking",
  "licensed by", "license", "market", "marketing",
  "distributed by", "manufactured by", "pressed by", "published by",
  "recorded at", "mixed at", "mastered at", "remixed at",
];

/** `EN_CREDIT_SHORT_LABELS` 的行首前缀形态，长分支优先避免被短分支截断。 */
export const EN_CREDIT_PREFIX_PATTERN = new RegExp(
  `^(?:${[...EN_CREDIT_SHORT_LABELS]
    .sort((left, right) => right.length - left.length)
    .join("|")})(?:\\s|$)`,
  "i",
);

/**
 * 无分隔符的英文署名行首标签：`Recorded at ...`、`Engineered by ...`、
 * `Special Thanks ...`（纯致谢行可能完全没有分隔符）。
 * 行首锚定 + 后随空白或行尾，避免吞掉词中巧合。
 */
const EN_LINE_START_CREDIT_LABELS = [
  "production\\s+coordination",
  "special\\s+thanks?(?:\\s+to)?", "thanks?(?:\\s+to)?",
  "recorded\\s+at", "recorded\\s+by", "engineered\\s+by", "mixed\\s+by", "mastered\\s+by",
  "mixing\\s+at", "mastering\\s+at", "recording\\s+at",
  "lyrics?\\s+by", "music\\s+by", "written\\s+by", "produced\\s+by",
  "composed\\s+by", "arranged\\s+by", "performed\\s+by",
  "vocals?\\s+recorded\\s+at",
  // `Digital Edited by X` 无冒号无分隔，词表条目只在头部路径生效，必须走整行前缀判定。
  "digital\\s+edited\\s+by",
];

/** 无分隔符英文署名的整行前缀判定。 */
export const STARTS_WITH_CREDIT_ENGLISH_PATTERN = new RegExp(
  `^(?:${EN_LINE_START_CREDIT_LABELS.join("|")})(?:\\s|$)`,
  "i",
);

/**
 * 空格分隔下**不可信**的头部：这些词虽是署名标签，但同样是高频歌词开头。
 * 空格分隔只在头部是纯制作行话时才信任，`感谢 陪伴`、`设计 一场相遇` 这类
 * 「标签词 + 歌词」的组合必须保留（冒号形态不受影响，`感谢：X` 仍会剔除）。
 */
export const SPACE_SPLIT_HEAD_DENY = new Set([
  "感谢", "特别感谢", "鸣谢", "致谢", "谢谢", "感激",
  "策划", "设计", "宣传", "推广", "邀请", "呈现",
  // `导演` 被歌词借用作隐喻（`导演 我的人生这一场戏`）。
  "导演",
  // `背景 夜色沉沉` 是歌词，`背景：绘师串` 是冒号署名。
  "背景",
  // `专辑 里的歌` 是歌词，`专辑：最好的时代` 是元信息署名。
  "专辑",
  // `翻译 爱的语言`、`录制 这一刻` 是歌词写法，冒号形态仍是署名。
  "翻译", "录制",
  // 泛化组（音乐/歌词/故事/视觉/鼓手）空格形态是歌词排比写法，冒号形态仍是署名。
  "音乐", "歌词", "故事", "视觉", "鼓手",
]);

/** 署名标签与取值之间的分隔符（在标签之后首次出现的位置切分）。
 * 半角连字符 `-` 只在**非字母数字夹心**时才当分隔符：`Mixed - Mastered by X`
 * 是并列署名，而 `Production Co-ordination`、`G-Eazy`、`L-O-V-E`（拼写歌词）
 * 里的连字符是词内成分 —— 裸 `-` 会把标签在词中切碎（`Production Co|ordination`）
 * 导致整条署名漏网。全角 `—`/`–` 不受约束（中文标签不会夹用）。 */
export const CREDIT_SEPARATOR_PATTERN = /(?::|：|—|–|\||｜|\/|／|(?<![A-Za-z0-9])-(?![A-Za-z0-9]))/;

/** 会出现在真实歌词里的高频虚词/实义词，用于否决结构判定，避免误杀正常歌词。 */
export const LYRIC_STOP_WORDS = [
  "的", "了", "吗", "吧", "呢", "啊", "呀", "哦", "嘛", "么", "着", "过", "得",
  "我", "你", "他", "她", "它", "们", "谁", "这", "那", "什么", "怎么", "为",
  "是", "不", "没", "有", "在", "就", "都", "很", "会", "说", "想", "要", "能",
  "起", "来", "去", "给", "被", "让", "把", "和", "但", "也", "还", "又", "只",
  "如", "若", "却", "而", "与", "或", "每", "各", "些", "个", "里", "外",
  "心", "爱", "梦", "风", "雨", "夜", "天", "光", "声", "家", "人", "情",
  "the", "and", "you", "me", "we", "is", "are", "to", "of", "in", "on", "for",
];
