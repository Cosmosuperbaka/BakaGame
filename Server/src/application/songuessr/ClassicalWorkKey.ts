/**
 * 古典乐的作品键：同一作品在平台上以五花八门的名字上传（英文全称、中文意译、目录号的
 * 各种写法、只写昵称），按曲名比对必然对不上。这里从一首歌的全部写法（曲名、译名、别名、
 * 歌手栏里的作曲家）解析出作品特征。
 *
 * 判定口径：**目录号相同是唯一的肯定证据**（Op./作品、BWV、K.、D.、WoO 等）；子编号与乐章、
 * 调性、体裁、作曲家只用来否决。只有「体裁 + 调性」不够：肖邦的降 E 大调夜曲就有
 * Op.9 No.2 与 Op.55 No.2 两首。通用的 Op. 编号各作曲家都有，至少还要一项特征两边对得上。
 * 判不准的一律交回调用方按非古典乐处理，宁可错过不可错配。
 */
import { toSimplified } from "../../infrastructure/ChineseConverter";

interface CatalogueRef {
  /** 目录体系；`any` 是中文「作品 N」，平台常拿它翻译任何体系的编号（`作品 1007` 即 BWV 1007）。 */
  system: string;
  number: string;
}

interface Tonality {
  /** 音名加升降号：`eb`、`c#`、`g`。 */
  pitch: string;
  mode?: "major" | "minor";
}

export interface ClassicalWorkProfile {
  catalogues: CatalogueRef[];
  /** 目录号之后的子编号与乐章号（`Op.27 No.2: I.` 记为 2 与 1），不区分层级，见 `indicesCompatible`。 */
  indices: Set<number>;
  tonalities: Tonality[];
  genres: Set<string>;
  composers: Set<string>;
}

export type ClassicalWorkVerdict = "same" | "different" | "unknown";

/** 只在 Op./作品 这类各作曲家共用的体系下需要旁证。 */
const GENERIC_SYSTEMS = new Set(["op", "any"]);

/**
 * 目录号写法。单字母体系（K. D. S. L. P.）只认大写，小写字母后跟数字在普通曲名里太常见。
 * 号码后面紧跟的子编号与乐章由 `indicesAfter` 另读。
 */
const CATALOGUE_PATTERNS: ReadonlyArray<{ system: string; pattern: RegExp }> = [
  { system: "op", pattern: /\bop(?:us)?\.?\s*(\d{1,3})(?!\d)/giu },
  { system: "any", pattern: /作品\s*(?:第\s*)?(?:op\.?\s*)?(\d{1,4})\s*号?/giu },
  { system: "bwv", pattern: /\bbwv\.?\s*(?:anh\.?\s*)?(\d{1,4})(?!\d)/giu },
  { system: "hwv", pattern: /\bhwv\.?\s*(\d{1,3})(?!\d)/giu },
  { system: "rv", pattern: /\brv\.?\s*(\d{1,3})(?!\d)/giu },
  { system: "woo", pattern: /\bwoo\.?\s*(\d{1,3})(?!\d)/giu },
  { system: "buxwv", pattern: /\bbuxwv\.?\s*(\d{1,3})(?!\d)/giu },
  { system: "sz", pattern: /\bsz\.?\s*(\d{1,3})(?!\d)/giu },
  { system: "hob", pattern: /\bhob\.?\s*([ivx]+[a-z]?\s*[:：/]?\s*\d{1,3})(?!\d)/giu },
  { system: "k", pattern: /\bKV?\.?\s*(\d{1,3})(?!\d)/gu },
  { system: "d", pattern: /\bD\.?\s*(\d{1,3})(?!\d)/gu },
  { system: "s", pattern: /\bS\.?\s*(\d{2,3})(?!\d)/gu },
  { system: "l", pattern: /\bL\.?\s*(\d{1,3})(?!\d)/gu },
  { system: "p", pattern: /\bP\.?\s*(\d{1,3})(?!\d)/gu },
];

const CHINESE_DIGITS: Readonly<Record<string, number>> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

const ROMAN_DIGITS: Readonly<Record<string, number>> = { i: 1, v: 5, x: 10 };

/** 阿拉伯数字、中文数字（一到九十九）与罗马数字（i 到 xxxix）转成数字；认不出返回 undefined。 */
const readIndex = (raw: string): number | undefined => {
  const text = raw.trim().toLowerCase();
  if (/^\d{1,2}$/u.test(text)) return Number(text);
  if (/^[一二三四五六七八九十]{1,3}$/u.test(text)) {
    const [tens, ones] = text.includes("十") ? text.split("十") : ["", text];
    const value =
      (text.includes("十") ? (CHINESE_DIGITS[tens!] ?? 1) * 10 : 0) + (CHINESE_DIGITS[ones!] ?? 0);
    return value || undefined;
  }
  if (/^[ivx]{1,6}$/u.test(text)) {
    let value = 0;
    for (let index = 0; index < text.length; index += 1) {
      const current = ROMAN_DIGITS[text[index]!]!;
      const next = ROMAN_DIGITS[text[index + 1] ?? ""] ?? 0;
      value += current < next ? -current : current;
    }
    return value > 0 && value < 40 ? value : undefined;
  }
  return undefined;
};

const INDEX_TOKEN = String.raw`(\d{1,2}|[一二三四五六七八九十]{1,3}|[ivx]{1,6})`;

/** 任何位置都算数的乐章写法：`第一乐章`、`3rd Movement`、`Movement 2`。 */
const MOVEMENT_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`第\s*${INDEX_TOKEN}\s*乐章`, "giu"),
  /\b(\d{1,2})\s*(?:st|nd|rd|th)\s+movement\b/giu,
  new RegExp(String.raw`\bmovement\s+${INDEX_TOKEN}\b`, "giu"),
];

/**
 * 紧跟在目录号之后的编号：`No. 2`、`第二号`、`第3首`、`之2`、`-2`、`: II.`、`- 3.`。
 * 目录号**之前**的「第 N 号」不读：那是体裁内的总序号（`第14号钢琴奏鸣曲，作品27`），
 * 平台的译名有时又把它写成作品内的子编号，两种口径混用，读进来只会互相否决。
 */
const INDEX_AFTER_CATALOGUE_PATTERNS: readonly RegExp[] = [
  /(?:^|[\s,，、])(?:no|nr|n°|#)\.?\s*(\d{1,2})(?!\d)/giu,
  new RegExp(String.raw`第\s*${INDEX_TOKEN}\s*[号首]`, "giu"),
  /^\s*(?:之|[-–—/])\s*(\d{1,2})(?!\d)/giu,
  new RegExp(String.raw`[:：\-–—]\s*${INDEX_TOKEN}\s*(?=[.．、)）]|\s+[^\s\p{L}]|$)`, "giu"),
];

const collectIndices = (text: string, patterns: readonly RegExp[], into: Set<number>) => {
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = readIndex(match[1] ?? "");
      if (value !== undefined && value <= 60) into.add(value);
    }
  }
};

/** 调性：英文 `in E-flat major`、中文 `降E大调`、日文 `変ホ長調`（已转简体）。 */
const ENGLISH_TONALITY_PATTERN =
  /\bin\s+([a-g])(?:\s*-?\s*(flat|sharp)\b|\s*([♭♯#])|(b)(?!\p{L}))?(?:\s*-?\s*(major|minor|dur|moll)\b)?/giu;
const CHINESE_TONALITY_PATTERN = /([升降]?)\s*([a-g])\s*(大调|小调)/giu;
const JAPANESE_TONALITY_PATTERN = /([婴变]?)([ハニホヘトイロ])\s*(长调|短调)/gu;
const JAPANESE_PITCHES: Readonly<Record<string, string>> = {
  ハ: "c",
  ニ: "d",
  ホ: "e",
  ヘ: "f",
  ト: "g",
  イ: "a",
  ロ: "b",
};
/** 英文写法没写大小调时，`in G` 后面必须是标点、结尾或目录号，否则 `in a dream` 也会被当成调性。 */
const BARE_PITCH_FOLLOW_PATTERN =
  /^\s*(?:$|[,，:：;；()（）"'“”‘’\-–—]|op\b|no\b|bwv|kv?\b|hwv|rv|woo|[dslp]\.?\s*\d)/iu;

const accidentalOf = (raw: string | undefined): string => {
  if (!raw) return "";
  if (/^(?:flat|♭|b|降|变)$/iu.test(raw)) return "b";
  if (/^(?:sharp|♯|#|升|婴)$/iu.test(raw)) return "#";
  return "";
};

const modeOf = (raw: string | undefined): Tonality["mode"] => {
  if (!raw) return undefined;
  return /^(?:major|dur|大调|长调)$/iu.test(raw) ? "major" : "minor";
};

const readTonalities = (text: string): Tonality[] => {
  const found: Tonality[] = [];
  for (const match of text.matchAll(ENGLISH_TONALITY_PATTERN)) {
    const [whole, letter, word, symbol, attachedFlat, mode] = match;
    const accidental = word ?? symbol ?? attachedFlat;
    if (!accidental && !mode) {
      const rest = text.slice((match.index ?? 0) + whole.length);
      if (!BARE_PITCH_FOLLOW_PATTERN.test(rest)) continue;
    }
    found.push({
      pitch: `${letter!.toLowerCase()}${accidentalOf(accidental)}`,
      mode: modeOf(mode),
    });
  }
  for (const [, accidental, letter, mode] of text.matchAll(CHINESE_TONALITY_PATTERN)) {
    found.push({
      pitch: `${letter!.toLowerCase()}${accidentalOf(accidental)}`,
      mode: modeOf(mode),
    });
  }
  for (const [, accidental, pitch, mode] of text.matchAll(JAPANESE_TONALITY_PATTERN)) {
    found.push({
      pitch: `${JAPANESE_PITCHES[pitch!]}${accidentalOf(accidental)}`,
      mode: modeOf(mode),
    });
  }
  return found;
};

/** 体裁词表：只用来否决（两边都认出体裁且毫无交集），以及给通用 Op. 编号作旁证。 */
const GENRE_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["nocturne", /\bnocturnes?\b|\bnotturno\b|(?<!小)夜曲|夜想曲|ノクターン/iu],
  ["sonata", /\bsonat[ae]\b|奏鸣曲|ソナタ/iu],
  ["waltz", /\bwaltz(?:es)?\b|\bvalses?\b|\bwalzer\b|圆舞曲|ワルツ/iu],
  ["etude", /\b[eé]tudes?\b|练习曲|エチュード/iu],
  ["prelude", /\bpr[eé]ludes?\b|\bpraeludium\b|前奏曲|プレリュード/iu],
  ["suite", /\bsuites?\b|组曲/iu],
  ["serenade", /\bserenad[ea]\b|\bserenata\b|\bständchen\b|小夜曲|セレナーデ/iu],
  ["symphony", /\bsymphon(?:y|ie)\b|\bsinfonia\b|交响曲/iu],
  ["concerto", /\bconcerto\b|\bkonzert\b|协奏曲/iu],
  ["ballade", /\bballades?\b|叙事曲/iu],
  ["mazurka", /\bmazurkas?\b|玛祖卡|马祖卡/iu],
  ["polonaise", /\bpolonaises?\b|波兰舞曲|波洛奈兹/iu],
  ["impromptu", /\bimpromptus?\b|即兴曲/iu],
  ["scherzo", /\bscherzo\b|谐谑曲/iu],
  ["canon", /\bcanon\b|\bkanon\b|卡农|カノン/iu],
  ["fugue", /\bfug(?:ue|a)\b|赋格/iu],
  ["bagatelle", /\bbagatelles?\b|バガテル/iu],
  ["variations", /\bvariations?\b|变奏曲/iu],
  ["rhapsody", /\brhapsod(?:y|ie)\b|狂想曲/iu],
];

/**
 * 作曲家别名表：拉丁字母按整词匹配，中日文按子串。只收误伤小的写法；
 * 「施特劳斯」这类一姓多人、「马勒」这类在普通中文里容易撞上的名字不收。
 */
const COMPOSERS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["chopin", ["chopin", "肖邦", "萧邦", "ショパン"]],
  ["beethoven", ["beethoven", "贝多芬", "ベートーヴェン", "ベートーベン"]],
  ["mozart", ["mozart", "莫扎特", "モーツァルト"]],
  ["bach", ["bach", "巴赫", "バッハ"]],
  ["debussy", ["debussy", "德彪西", "ドビュッシー"]],
  ["pachelbel", ["pachelbel", "帕赫贝尔", "帕海贝尔", "帕卡贝尔", "パッヘルベル"]],
  ["liszt", ["liszt", "李斯特"]],
  ["schubert", ["schubert", "舒伯特", "シューベルト"]],
  ["schumann", ["schumann", "舒曼", "シューマン"]],
  ["tchaikovsky", ["tchaikovsky", "tschaikowsky", "柴可夫斯基", "チャイコフスキー"]],
  ["vivaldi", ["vivaldi", "维瓦尔第", "韦瓦第", "ヴィヴァルディ"]],
  ["handel", ["handel", "händel", "haendel", "亨德尔", "ヘンデル"]],
  ["haydn", ["haydn", "海顿", "ハイドン"]],
  ["brahms", ["brahms", "勃拉姆斯", "ブラームス"]],
  ["mendelssohn", ["mendelssohn", "门德尔松", "メンデルスゾーン"]],
  ["rachmaninoff", ["rachmaninoff", "rachmaninov", "拉赫玛尼诺夫", "ラフマニノフ"]],
  ["dvorak", ["dvorak", "dvořák", "德沃夏克", "德沃扎克", "ドヴォルザーク"]],
  ["grieg", ["grieg", "格里格", "グリーグ"]],
  ["satie", ["satie", "萨蒂", "サティ"]],
  ["ravel", ["ravel", "拉威尔", "ラヴェル"]],
  ["paganini", ["paganini", "帕格尼尼", "パガニーニ"]],
  ["saintsaens", ["saint-saëns", "saint-saens", "圣桑"]],
  ["elgar", ["elgar", "埃尔加", "エルガー"]],
  ["rimskykorsakov", ["rimsky-korsakov", "里姆斯基-科萨科夫", "里姆斯基科萨科夫"]],
  ["albinoni", ["albinoni", "阿尔比诺尼"]],
  ["boccherini", ["boccherini", "博凯里尼", "鲍凯利尼"]],
];

const LATIN_ALIAS_PATTERN = /^[\p{Script=Latin}\-' ]+$/u;
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const COMPOSER_MATCHERS = COMPOSERS.map(([id, aliases]) => ({
  id,
  aliases,
  pattern: new RegExp(
    aliases
      .map((alias) =>
        LATIN_ALIAS_PATTERN.test(alias)
          ? String.raw`(?<![\p{L}\p{N}])${escapeRegExp(alias)}(?![\p{L}\p{N}])`
          : escapeRegExp(alias)
      )
      .join("|"),
    "iu"
  ),
}));

/**
 * 名曲昵称：只写昵称的上传（「致爱丽丝」「小狗圆舞曲」）没有目录号可读。昵称必须与
 * 作曲家同时出现才生效：同名流行歌很多（毛不易的《小狗圆舞曲》、陈珊妮的《离别曲》），
 * 不带作曲家的昵称不能当成古典乐。昵称按「去掉作曲家、括号与填充词后的整个曲名」比对。
 */
const NICKNAMES: ReadonlyArray<{
  composer: string;
  names: readonly string[];
  catalogue: CatalogueRef;
  indices?: readonly number[];
}> = [
  {
    composer: "beethoven",
    names: ["月光奏鸣曲", "月光曲", "月光", "moonlightsonata", "moonlight", "mondscheinsonate"],
    catalogue: { system: "op", number: "27" },
    indices: [2],
  },
  {
    composer: "beethoven",
    names: [
      "致爱丽丝",
      "献给爱丽丝",
      "给爱丽丝",
      "fürelise",
      "furelise",
      "forelise",
      "pourelise",
      "エリーゼのために",
    ],
    catalogue: { system: "woo", number: "59" },
  },
  {
    composer: "beethoven",
    names: ["悲怆奏鸣曲", "悲怆", "pathétique", "pathetique", "pathetiquesonata"],
    catalogue: { system: "op", number: "13" },
  },
  {
    composer: "chopin",
    names: ["离别曲", "离别", "离别练习曲", "tristesse"],
    catalogue: { system: "op", number: "10" },
    indices: [3],
  },
  {
    composer: "chopin",
    names: ["革命练习曲", "革命", "revolutionaryetude", "revolutionary"],
    catalogue: { system: "op", number: "10" },
    indices: [12],
  },
  {
    composer: "chopin",
    names: ["小狗圆舞曲", "小狗", "minutewaltz", "minute"],
    catalogue: { system: "op", number: "64" },
    indices: [1],
  },
  {
    composer: "chopin",
    names: ["雨滴前奏曲", "雨滴", "raindropprelude", "raindrop"],
    catalogue: { system: "op", number: "28" },
    indices: [15],
  },
  {
    composer: "chopin",
    names: ["幻想即兴曲", "fantaisieimpromptu", "fantasieimpromptu"],
    catalogue: { system: "op", number: "66" },
  },
  {
    composer: "chopin",
    names: ["英雄波兰舞曲", "heroicpolonaise", "heroic"],
    catalogue: { system: "op", number: "53" },
  },
  {
    composer: "mozart",
    names: ["小夜曲", "弦乐小夜曲", "einekleinenachtmusik", "alittlenightmusic"],
    catalogue: { system: "k", number: "525" },
  },
  {
    composer: "mozart",
    names: ["土耳其进行曲", "rondoallaturca", "turkishmarch"],
    catalogue: { system: "k", number: "331" },
    indices: [3],
  },
  {
    composer: "debussy",
    names: ["月光", "clairdelune"],
    catalogue: { system: "l", number: "75" },
    indices: [3],
  },
  {
    composer: "debussy",
    names: ["亚麻色头发的少女", "lafilleauxcheveuxdelin"],
    catalogue: { system: "l", number: "117" },
    indices: [8],
  },
  {
    composer: "pachelbel",
    names: ["卡农", "d大调卡农", "canon", "canonind", "kanon", "canonandgigue", "カノン"],
    catalogue: { system: "p", number: "37" },
  },
  {
    composer: "bach",
    names: ["g弦上的咏叹调", "g弦咏叹调", "aironthegstring"],
    catalogue: { system: "bwv", number: "1068" },
    indices: [2],
  },
  {
    composer: "liszt",
    names: ["钟", "钟声", "lacampanella", "campanella"],
    catalogue: { system: "s", number: "141" },
    indices: [3],
  },
];

/** 昵称比对前要去掉的填充词：上传者爱在曲名里堆的乐器、音质与版本说明。 */
const NICKNAME_FILLER_PATTERN =
  /钢琴曲|钢琴版|钢琴|纯音乐|完整版|无损|经典版|经典|世界名曲|名曲|古典|piano|version|乐章|\bfull\b/giu;
const BRACKET_PATTERN = /[（(【[「『][^）)】\]」』]*[）)】\]」』]/gu;
const MOVEMENT_PHRASE_PATTERN = new RegExp(
  [
    String.raw`第\s*${INDEX_TOKEN}\s*乐章`,
    String.raw`\b\d{1,2}\s*(?:st|nd|rd|th)\s+movement\b`,
    String.raw`\bmovement\s+${INDEX_TOKEN}\b`,
  ].join("|"),
  "giu"
);

const prepare = (value: string) => toSimplified(value).normalize("NFKC");
const compactLetters = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

const nicknameResidual = (name: string, composerPattern: RegExp): string =>
  compactLetters(
    name
      .replace(BRACKET_PATTERN, " ")
      .replace(MOVEMENT_PHRASE_PATTERN, " ")
      .replace(new RegExp(composerPattern.source, "giu"), " ")
      .replace(NICKNAME_FILLER_PATTERN, " ")
  );

/**
 * 一首歌的古典乐特征：`names` 是曲名与译名、别名，`artist` 只用来认作曲家
 * （平台常把作曲家挂在歌手栏里）。
 */
export const classicalWorkProfile = (
  names: readonly string[],
  artist: string | undefined
): ClassicalWorkProfile => {
  const profile: ClassicalWorkProfile = {
    catalogues: [],
    indices: new Set(),
    tonalities: [],
    genres: new Set(),
    composers: new Set(),
  };
  const texts = names.map(prepare).filter(Boolean);
  const artistText = prepare(artist ?? "");
  for (const { id, pattern } of COMPOSER_MATCHERS) {
    if ([...texts, artistText].some((text) => pattern.test(text))) profile.composers.add(id);
  }
  for (const text of texts) {
    const matches = CATALOGUE_PATTERNS.flatMap(({ system, pattern }) =>
      [...text.matchAll(pattern)].map((match) => ({
        system,
        number: match[1]!.toLowerCase().replace(/[\s:：/]+/gu, ":"),
        start: match.index ?? 0,
        end: (match.index ?? 0) + match[0].length,
      }))
    ).sort((left, right) => left.start - right.start);
    matches.forEach((match, order) => {
      profile.catalogues.push({ system: match.system, number: match.number });
      const next = matches.slice(order + 1).find((other) => other.start >= match.end);
      collectIndices(
        text.slice(match.end, next?.start ?? text.length).toLowerCase(),
        INDEX_AFTER_CATALOGUE_PATTERNS,
        profile.indices
      );
    });
    collectIndices(text, MOVEMENT_PATTERNS, profile.indices);
    profile.tonalities.push(...readTonalities(text));
    for (const [genre, pattern] of GENRE_PATTERNS)
      if (pattern.test(text)) profile.genres.add(genre);
  }
  for (const nickname of NICKNAMES) {
    const matcher = COMPOSER_MATCHERS.find(({ id }) => id === nickname.composer);
    if (!matcher || !profile.composers.has(nickname.composer)) continue;
    const residuals = texts.map((text) => nicknameResidual(text, matcher.pattern));
    if (!residuals.some((residual) => nickname.names.includes(residual))) continue;
    profile.catalogues.push(nickname.catalogue);
    for (const index of nickname.indices ?? []) profile.indices.add(index);
  }
  return profile;
};

const sameCatalogue = (left: CatalogueRef, right: CatalogueRef) =>
  left.number === right.number &&
  (left.system === right.system || left.system === "any" || right.system === "any");

const tonalitiesCompatible = (left: Tonality, right: Tonality) =>
  left.pitch === right.pitch && (!left.mode || !right.mode || left.mode === right.mode);

/**
 * 编号集合互相包含即视为相容：`Op.9 No.2` 与 `Op.9: II.` 都是 {2}；`Op.27 No.2: I.` 是 {2, 1}，
 * 只写 `Op.27: I.` 的译名是 {1}，是它的子集；第一乐章 {2, 1} 与第三乐章 {2, 3} 互不包含。
 * 一侧没有编号时不否决。
 */
const indicesCompatible = (left: Set<number>, right: Set<number>) =>
  left.size === 0 ||
  right.size === 0 ||
  [...left].every((value) => right.has(value)) ||
  [...right].every((value) => left.has(value));

const intersects = (left: Set<string>, right: Set<string>) =>
  [...left].some((value) => right.has(value));

/**
 * 两首歌是否同一古典作品：两边都认出目录号才下结论（`same` / `different`），
 * 否则 `unknown`，交回调用方按普通曲名规则判。
 */
export const compareClassicalWorks = (
  left: ClassicalWorkProfile,
  right: ClassicalWorkProfile
): ClassicalWorkVerdict => {
  if (left.catalogues.length === 0 || right.catalogues.length === 0) return "unknown";
  const shared = left.catalogues.filter((ref) =>
    right.catalogues.some((other) => sameCatalogue(ref, other))
  );
  if (shared.length === 0) return "different";
  if (!indicesCompatible(left.indices, right.indices)) return "different";
  const tonalityKnown = left.tonalities.length > 0 && right.tonalities.length > 0;
  const tonalityMatch =
    tonalityKnown &&
    left.tonalities.some((tonality) =>
      right.tonalities.some((other) => tonalitiesCompatible(tonality, other))
    );
  if (tonalityKnown && !tonalityMatch) return "different";
  const composerKnown = left.composers.size > 0 && right.composers.size > 0;
  const composerMatch = composerKnown && intersects(left.composers, right.composers);
  if (composerKnown && !composerMatch) return "different";
  const genreKnown = left.genres.size > 0 && right.genres.size > 0;
  const genreMatch = genreKnown && intersects(left.genres, right.genres);
  if (genreKnown && !genreMatch) return "different";
  const specific = shared.some((ref) => !GENERIC_SYSTEMS.has(ref.system));
  if (specific || composerMatch || tonalityMatch || genreMatch) return "same";
  return "unknown";
};
