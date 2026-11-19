/**
 * 噪声行分类器：间奏、符号、数字、舞台指示、版权声明、技术信息、归属、平台、对唱角色等
 * 与署名无关的无效歌词行。只吃字符串，不认上游响应形状。
 */
import { normalizeLyricComparable } from "./LyricText";

const INSTRUMENTAL_MARKERS = new Set([
  "music",
  "instrumental",
  "interlude",
  "intro",
  "outro",
  "inst",
  "伴奏",
  "间奏",
  "前奏",
  "尾奏",
  "纯音乐",
  "器乐",
]);

/** 过滤 LRC 中表示间奏/纯音乐的占位行，避免把无歌词段落当作可猜片段。 */
export const isInstrumentalLyricLine = (text: string) => {
  const normalized = normalizeLyricComparable(text);
  if (INSTRUMENTAL_MARKERS.has(normalized)) return true;
  // 网易云会把间奏写成 Music1、[Music] 或 Music - Instrumental 等占位文本。
  if (/^(?:music|instrumental|interlude|intro|outro|inst)(?:\d+)?$/.test(normalized)) return true;
  if (
    /^(?:music|instrumental|interlude|intro|outro|inst)(?:music|instrumental|interlude|intro|outro|inst)$/.test(
      normalized
    )
  )
    return true;
  // `纯音乐，请欣赏`、`纯音乐 请欣赏`、`本曲为纯音乐，请欣赏` 这类带后缀的占位说明。
  // `normalizeLyricComparable` 会保留逗号，因此整串不等于 `纯音乐`，需要单独按前缀判定。
  return /^(?:本曲为|本首歌为|此曲为)?(?:纯音乐|純音樂|纯音乐请欣赏)/.test(normalized);
};

/** 纯符号行（`~~~~`、`...`、`— — —`、`· · ·`）没有任何可猜信息。 */
export const isSymbolOnlyLyricLine = (text: string) =>
  /^[\s\u3000~～·•*＊=＝+＋#＃\-—–─_＿.,，。!！?？…、;；:：'"“”‘’()（）[\]【】<>《》/／\\|｜]+$/u.test(
    text
  );

/** 只由数字与单位/括号构成的行（如 `00:12`、`120 bpm`）不承载歌词内容。 */
export const isNumericOnlyLyricLine = (text: string) => {
  const stripped = text
    .normalize("NFKC")
    .replace(/[\s\u3000()（）[\]【】,.，、:：]/gu, "")
    .replace(/(?:s|sec|min|kbps|hz|bpm|khz|fps)/giu, "");
  return stripped.length > 0 && /^\d+$/u.test(stripped);
};

/**
 * 占位遮罩行：整行由**同一个 ASCII 字母重复 ≥3 次**构成（`XXXXXXXXX`、`xxx`、`OOOOOO`）。
 *
 * 网易云上大量用户上传谱会把未填写的段落写成这种遮罩，它没有任何可猜信息。
 * 判定要求「整行（去掉空白与**全部标点/符号**后）只由同一字母组成且长度 ≥3」，
 * 这样 `X你太美`、`xxxxx我爱你`、`XXXXXXXXXXXXXXXXXX你好` 这类含实际文字的行不会被误杀；
 * 同时能覆盖 `～∧o∧o@∧o@∧o～...` 这类**符号夹单字母**的颜文字噪声行
 * （剥掉 `～∧@-` 后只剩重复的 `o`）。`U.S.A.`、`O.O` 剥后不足 3 位或非单字母，保留。
 */
export const isPlaceholderMaskLyricLine = (text: string): boolean => {
  const stripped = text.normalize("NFKC").replace(/[\s\u3000\p{P}\p{S}]/gu, "");
  if (stripped.length < 3) return false;
  return /^([A-Za-z])\1+$/u.test(stripped);
};

/** 舞台指示/编辑注记的固定词汇：`(Repeat)`、`（以下反复）`、`(silence)`、`(间奏)`。 */
const STAGE_DIRECTION_SOURCE = [
  "repeat",
  "silence",
  "silent",
  "instrumental",
  "interlude",
  "intro",
  "outro",
  "fade",
  "fadeout",
  "fade in",
  "fade out",
  "spoken",
  "whisper",
  "echo",
  // `(Music)`、`(Music♂)` 这类括号内间奏占位。
  "music",
  "以下反复",
  "以下重复",
  "间奏",
  "前奏",
  "尾奏",
  "反复",
  "重复",
  "此处",
  "略",
  "待补",
  "待定",
  "无歌词",
  "看不懂",
  "听不清",
  "念白",
  // 多语言段落标记：`(Припев:)`（俄语副歌）、`(Coro:)`（西/意）、`(Refrain)`（法语）、
  // `(サビ)`（日语副歌）、`(간주)`（韩语间奏）。这些在网易云外语曲目里很常见。
  "припев",
  "куплет",
  "chorus",
  "verse",
  "bridge",
  "pre-chorus",
  "hook",
  "coro",
  "estribillo",
  "refrain",
  "pont",
  "サビ",
  "aメロ",
  "bメロ",
  "間奏",
  "간주",
  "후렴",
  "절",
].join("|");

/** 括号内的制作方标注：`（烛光制作）`、`(某某出品)`、`（原创团队献上）`。 */
const BRACKET_PRODUCTION_SUFFIX_PATTERN =
  /^[\u4e00-\u9fffA-Za-z0-9·]{1,12}(?:制作|出品|原创|献上|呈献|作品)$/u;

const STAGE_DIRECTION_PATTERN = new RegExp(`^(?:${STAGE_DIRECTION_SOURCE})$`, "i");

/**
 * 整行被一对括号完整包裹的舞台指示行。
 *
 * 网易云上大量上传谱把说明性文字整行写在括号里，例如
 * `(何が綴られていたのか、私たちの文明では到底理解できない)`、`（以下反复）`、`(Repeat)`、
 * `(Припев:)`。这些句子不含任何可猜的歌词内容，且**会暴露段落结构**，必须剔除。
 *
 * 但括号在真实歌词里同样常见（和声、重复句、英文衬词），所以判定必须保守：
 * 只有满足以下任一条才剔除：
 * 1. 内层命中舞台指示词表（含多语言段落标记）；
 * 2. 内层形如「标签 + 冒号」（`Припев:`、`Verse 1:`、`Chorus：`），冒号后为空 ——
 *    这是段落标记的通用形态，任何真实歌词括号内容都不会以「单个词 + 冒号结尾」出现；
 * 3. 内层含 `、`/`,`/`，` 这类**并列或断句**标点（真实歌词的括号内容极少是长句）。
 *
 * `（啦啦啦）`、`(你是我的眼)`、`(Oh yeah baby)`、`（爱してる）` 都因不满足以上条件而保留。
 */
export const isBracketedStageDirectionLine = (text: string): boolean => {
  const wrapped = /^[（([【「『《<]\s*([\s\S]*?)\s*[）)\]】」』》>]$/u.exec(text.trim());
  if (!wrapped) return false;
  const inner = wrapped[1].trim();
  if (!inner) return false;

  // 内层若本身是纯符号/纯遮罩，交给各自的判定，避免重复归类。
  if (/^[\p{P}\p{S}\s\u3000]+$/u.test(inner)) return false;

  // 去掉尾部的冒号后再比对词表，兼容 `(Припев:)`、`(Repeat:)` 形态。
  const withoutTrailingColon = inner.replace(/[:：]\s*$/u, "").trim();
  // 剥掉**两端**装饰符号，兼容 `(Music♂)`、`(*music*)` 这类带符号的间奏占位。
  const withoutSymbols = withoutTrailingColon.replace(/^[\p{S}\p{P}]+|[\p{S}\p{P}]+$/gu, "").trim();
  if (STAGE_DIRECTION_PATTERN.test(withoutSymbols)) return true;

  // 括号内的制作方标注：`（烛光制作）`、`(某某出品)`。
  if (BRACKET_PRODUCTION_SUFFIX_PATTERN.test(inner)) return true;

  // 括号内的原曲信息：`（飞机场的10:30 - 陶喆）`。
  // 形态特征高度特异：内层含「分:秒」式时间戳，随后是破折号 + 短人名尾，
  // 真实歌词的括号和声/衬词不会长这样。
  if (/^[^：:]{1,30}\d{1,2}:\d{2}\s*[-–—]\s*[^-–—]{1,20}$/u.test(inner)) return true;

  // 「单词 + 冒号结尾」的段落标记形态（`Verse 1:`、`Припев:`），冒号后无内容。
  if (/^[^\s:：,，、;；]{1,20}(?:\s\d{1,2})?\s*[:：]\s*$/u.test(inner)) return true;

  // 并列/断句标点：真实歌词的括号内容极少出现需要断句的长句。
  return /[、,，;；]/u.test(inner);
};

/**
 * 有效字符过短的行。
 *
 * 注意：单个汉字/假名在真实歌词里确实存在（`啊`、`喂`、`一`、`二`），
 * 因此这条规则只用于「非中日文字符且有效字符不足 2 个」的情形，
 * 避免把合法的单字歌词一并剔除。判定垃圾行主要依赖署名与符号/数字规则。
 */
export const isTooShortLyricLine = (text: string) => {
  const meaningful = text.normalize("NFKC").replace(/[\s\u3000\p{P}\p{S}]/gu, "");
  if (meaningful.length >= 2) return false;
  // 单个中日文字符不视为垃圾行。
  return !/^[\u4e00-\u9fff\u3040-\u30ff]$/u.test(meaningful);
};

/**
 * 版权与法律声明的固定短语。
 *
 * 这类行既不像「标签：取值」（`词版权管理方：` 的头部是扩展短语），也不含任何人名，
 * 但它同样把版方/录音制品信息暴露给出题者，必须剔除。用**包含**判定而非前缀判定，
 * 因为实际形态多样：`词版权管理方：X`、`录音作品及MV版权：X`、`（未经许可,不得翻唱或使用）`。
 */
const COPYRIGHT_NOTICE_SOURCE = [
  "版权管理方",
  "版权代理",
  "版权方",
  "录音作品",
  "录音制品",
  "录音制作者",
  "未经许可",
  "未经授权",
  "不得翻唱",
  "不得使用",
  "不得转载",
  "禁止翻唱",
  "版权所有",
  "all rights reserved",
  "copyright",
  "℗",
  "©",
  "词版权",
  "曲版权",
  "词曲版权",
  "op：",
  "sp：",
  // 商用授权/搬运声明：`已获商用授权`、`未经著作权人许可禁止搬运`、`禁止翻录`、`禁止Remix`。
  "商用授权",
  "著作权人",
  "禁止搬运",
  "禁止翻录",
  "禁止转载",
  "翻录",
  "remix",
  "仅供个人学习",
  "不得用于商业",
  // 出版方行：`/ EMI Music Publishing (S.E. Asia) Ltd, Taiwan Branch` —— 唱片内页
  // 连排出版信息被拆成的碎片行，`publishing` 一词在真实歌词里不会出现。
  "music publishing",
  "publishing\\s*\\(",
  // 授权/改编声明：`——正版授权，改编自《Counting stars》——`。
  "正版授权",
  "改编自",
  "翻唱自",
  "原曲出自",
  // 出处声明：`本歌曲来自〖云上工作室〗`。不要求平台名命中 ——
  // 「本歌曲来自 X」是发行侧固定句式，真实歌词不会这么说。
  "本(?:歌曲|作品|音乐)来自",
  // R8 实测补漏：`已买版权 禁止二改二传`、`版权公司：X`、
  // `Used by permission of ...`（内页授权套话）、`X reserved.`（省略
  // all rights 的页脚碎片；`Spot is forever reserved` 这类无句点歌词不受影响）。
  "已买版权",
  "版权公司",
  "used\\s+by\\s+permission",
  "reserved\\.",
  // R10 实测补漏：`(Admin. by Warner/Chappell Music Korea)`（版权管理代理套话）。
  "admin\\.?\\s+by",
].join("|");

const COPYRIGHT_NOTICE_PATTERN = new RegExp(COPYRIGHT_NOTICE_SOURCE, "i");

/** 版权/法律声明行：整行命中固定短语即判定无效。 */
export const isCopyrightNoticeLine = (text: string): boolean => {
  const normalized = text
    .normalize("NFKC")
    .replace(/[\s\u3000]+/g, " ")
    .trim();
  if (!normalized) return false;
  return COPYRIGHT_NOTICE_PATTERN.test(normalized);
};

/**
 * 技术参数与联系信息行：`ISRC：TWA451498702`、`UPC：...`、
 * `合作：st399@vip.163.com`、`联系：xxx@qq.com`、`https://...`。
 *
 * 这类行不含任何歌词语义，却会被出题者看到唱片编号与联系方式。
 * 判定分两支：**编号类标签**（ISRC/UPC/ISWC/EAN/barcode）与
 * **邮箱/网址**（含 `@` 且形如邮箱，或含协议/域名）。
 * 注意 `@` 判定要足够具体，避免误伤歌词里的 `@`（如 `Sing @ the top`）。
 */
const TECHNICAL_ID_PATTERN =
  /^(?:isrc|upc|ean|iswc|isbn|barcode|条形码)\s*[:：]?\s*[A-Z0-9-]{6,}$/i;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const URL_PATTERN = /https?:\/\/|www\.[A-Za-z0-9-]+\.[A-Za-z]{2,}/i;

export const isTechnicalInfoLine = (text: string): boolean => {
  const normalized = text
    .normalize("NFKC")
    .replace(/[\s\u3000]+/g, " ")
    .trim();
  if (!normalized) return false;
  if (TECHNICAL_ID_PATTERN.test(normalized)) return true;
  if (EMAIL_PATTERN.test(normalized)) return true;
  if (URL_PATTERN.test(normalized)) return true;
  // `ISRC :` / `UPC：` 这类只有标签、取值另起/缺失的残留行。
  return /^(?:isrc|upc|ean|iswc|isbn|barcode)\s*[:：]\s*$/i.test(normalized);
};

/**
 * 团体/工作室归属署名：`朗梓朔@维伴音乐`、`王皓@WONDERWALL`、`洪信杰@牛班NEWBAND`。
 *
 * 网易云近年大量出现「人名 @ 团队名」的归属写法，用于标注乐手所属厂牌或乐队。
 * 它既不含冒号（`splitCreditHead` 拆不出标签），也不是邮箱（`@` 后无 TLD），
 * 因此会从词表、结构、技术信息三条路径全部漏出。
 *
 * 判定必须严格，避免误伤歌词里的 `@`：
 * 1. `@` 两侧**紧贴**（不允许空白），排除 `Sing @ the top`、`I'll be there @ 3am`；
 * 2. `@` 右侧是**团队名形态**：含至少一个 ASCII 大写字母且长度 ≥3
 *    （`WONDERFALL`、`NEWBAND`、`牛班NEWBAND`、`BrandNew`），或全中文（`维伴音乐`、`爱之音`）。
 *    这自然排除 `me@you`、`love@first`、`你@我`（右侧无大写或过短）；
 *    `@` 左侧允许人名形态（中文名、英文名、`张人杰Andy` 这类中英混排）；
 * 3. 整行**只由归属片段构成**（允许 `/`、空白、顿号分隔多个片段），
 *    排除夹在句子里的 `Send it to me @ midnight` 这类歌词。
 */
const AFFILIATION_SEGMENT_PATTERN =
  /^(?:[\u4e00-\u9fff]{1,12}[A-Za-z0-9]*|[A-Za-z][A-Za-z0-9]*[\u4e00-\u9fff]{1,12}|[A-Za-z][A-Za-z0-9]*|[A-Za-z0-9]*[A-Za-z])@(?:[\u4e00-\u9fffA-Za-z0-9]+)$/u;

export const isAffiliationCreditLine = (text: string): boolean => {
  const normalized = text.normalize("NFKC").trim();
  if (!normalized || !normalized.includes("@")) return false;
  // 团队名常含空格（`Kevin刘瀚文@Soundhub Studios`）：先把它后面的
  // 机构词并回 @ 片段（去掉空格粘连成 `@SoundhubStudios`），否则空格拆分
  // 会把 `Studios` 甩成无 @ 的独立片段而整行判定失败。
  // 只并回明确的机构后缀词，`Sing @ the top of my lungs` 不受影响。
  const merged = normalized.replace(
    /(@[\u4e00-\u9fffA-Za-z0-9]+)[\s\u3000]+((?:Studios?|Records?|Music|Entertainment|Company|Corporation|Corp\.?|Ltd\.?|Limited|Group|Band|Production|Productions|Studio)\b)/gu,
    "$1$2"
  );
  const segments = merged.split(/[\s\u3000/／,，、|｜]+/u).filter(Boolean);
  if (segments.length === 0) return false;
  return segments.every((segment) => {
    const match = AFFILIATION_SEGMENT_PATTERN.exec(segment);
    if (!match) return false;
    // `@` 右侧的团队名必须是「团队形态」：≥3 个 ASCII 字母且含大写，
    // 或 ≥2 个汉字。仅此一条即可排除 `me@you`、`love@first`、`你@我`。
    const team = match[0].slice(match[0].lastIndexOf("@") + 1);
    const ascii = team.replace(/[^A-Za-z]/g, "");
    if (/^[\u4e00-\u9fff]+$/u.test(team)) return team.length >= 2;
    return ascii.length >= 3 && /[A-Z]/.test(ascii);
  });
};

/**
 * 平台/企划出品声明：`网易云音乐特别企划“回声不息”出品`、`本歌曲来自〖网易音乐人〗`。
 *
 * 这类行既非署名也非版权，但会把「这是网易云自制的企划曲」这一背景信息泄露给猜题者，
 * 且行末常带书名号/引号包裹的企划名，词表永远追不全。按**平台名 + 出品/来自**结构判定。
 */
const PLATFORM_CREDIT_PATTERN =
  /(?:网易(?:音乐人|云音乐|云|音乐)?|qq音乐|酷狗音乐|咪咕音乐|bilibili)/iu;

export const isPlatformCreditLine = (text: string): boolean => {
  const normalized = text
    .normalize("NFKC")
    .replace(/[\s\u3000]+/g, " ")
    .trim();
  if (!normalized) return false;
  // 整行被括号包裹且内层含平台名：`【bilibili音乐·2022虚拟歌手贺岁纪】`。
  // 这类企划行没有出品/来自等关键词也必须判定 —— 平台名本身已是泄露源。
  // 必须要求平台名命中，否则 `【副歌】` 这类段落标注会被整行误杀。
  if (
    PLATFORM_CREDIT_PATTERN.test(normalized) &&
    /^[【[（(][^【[（()）】\]]{1,40}[】\])）]$/u.test(normalized)
  ) {
    return true;
  }
  if (!PLATFORM_CREDIT_PATTERN.test(normalized)) return false;
  // `from` 是发行侧英文关键词：`From 爱你的网易云音乐`。大小写都要接住，必须带 i。
  return /出品|来自|企划|独家|首发|联合|制作|from/i.test(normalized);
};

/**
 * 对唱角色标注行（`男：`、`女：`、`合：`、`合唱：`、`戏腔：`，以及任意演唱人名的 `徐良L:`、`Ty：`）。
 *
 * 这类行给出的是**演唱分工而非歌词内容**，且右侧为空，
 * `splitCreditHead` 会因「取值缺失」直接返回 undefined 而漏网。
 *
 * 判定放宽为「**短标签 + 冒号结尾且右侧为空**」，而不是固定词表 —— 因为
 * `戏腔`/`京剧`/`徐良L`/`Ty` 这类分工名永远枚举不完，而「空取值」这一结构特征本身
 * 就足以判定它不含可猜内容。
 *
 * 标签允许含空格以覆盖英文演唱者（`Ariana Grande：`），
 * 也允许 `、/／` 连接多人分工（`封茗囧菌、双笙：`），但要求不含句末标点、
 * 不含引号、每段长度 ≤20，避免把 `Say: "..."` 这类带取值的行误判
 * （右侧非空天然不命中）。
 */
const EMPTY_VALUE_LABEL_PATTERN =
  /^[^\s:：'"，。！？、；]{1,20}(?:[\s、／/][^\s:：'"，。！？、；]{1,20}){0,3}\s*[:：]\s*$/u;

/**
 * 包裹式角色标注：`【合】`、`（男）`、`[女]`，内层只有一个角色词且**没有取值**。
 *
 * 必须要求「括号内仅含角色词」：`【合】有英雄漂泊异乡` 是「角色标记 + 真实歌词」，
 * 放宽会把整行真歌词误杀。
 */
const WRAPPED_DUET_ROLE_PATTERN =
  /^[【[（(「『《<]\s*(?:男|女|合|合唱|对唱|独唱|童声|念白|所有人|大家一起)\s*[】\]）)」』》>]\s*$/u;

export const isDuetRoleLine = (text: string): boolean => {
  const trimmed = text.trim();
  return EMPTY_VALUE_LABEL_PATTERN.test(trimmed) || WRAPPED_DUET_ROLE_PATTERN.test(trimmed);
};

/**
 * 注音符号行（`ㄅㄆㄇㄈㄉㄊㄋㄌ`）。
 *
 * 周杰伦《反方向的钟》开头有一段注音符号口白，网易云把它当歌词上传。
 * 它既非符号、也非数字、也不短，但没有任何可猜的中文/日文/拉丁语义。
 */
export const isBopomofoOnlyLyricLine = (text: string): boolean => {
  const stripped = text.normalize("NFKC").replace(/[\s\u3000\p{P}\p{S}]/gu, "");
  return stripped.length > 0 && /^[\u3105-\u312f\u31a0-\u31bf]+$/u.test(stripped);
};
