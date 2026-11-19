/**
 * 署名行分类器：判断一行歌词是否在暴露创作人员。
 *
 * 子判定之间相互递归，并共用同一份记忆表，必须留在同一个模块里。
 */
import {
  CREDIT_ACTION_PATTERN,
  CREDIT_LABEL_JOINER_PATTERN,
  CREDIT_LABEL_PATTERN,
  CREDIT_LABEL_SUFFIX_PATTERN,
  CREDIT_SEPARATOR_PATTERN,
  EN_CREDIT_PREFIX_PATTERN,
  EN_CREDIT_SHORT_LABELS,
  LYRIC_STOP_WORDS,
  SPACE_SPLIT_HEAD_DENY,
  STARTS_WITH_CREDIT_ENGLISH_PATTERN,
} from "./LyricVocabulary";

/**
 * 署名行会暴露创作人员，属于必须剔除的无效歌词。
 *
 * 判定必须分层：先剥离行首装饰、合并多标签，得到规范化的标签头部；词表命中即判署名；
 * 未命中的再走结构判定 `isCreditStructuredLine`，用「短标签 + 分隔符 + 空格分隔的人名串」
 * 兜底，否则词表永远追不上新造的同人圈标签。
 *
 * 词表数据与派生正则见 `./LyricVocabulary.ts`。
 */

/**
 * 判断头部是否形如 `(乐器)? 动作词 ((&|and) 动作词)* by`，
 * 例如 `Strings Arranged & Conducted by`、`Mixed & Mastered by`。
 * `by` 之后可以还有取值（`Strings Arranged & Conducted by 某某`）。
 */
const isCreditActionPhrase = (value: string): boolean => {
  const normalized = value.trim().replace(/[\s\u3000]+/g, " ");
  // `by` 后面允许紧跟取值，取第一个 `by` 之前的部分作为标签区。
  const byMatch = /^(.*?)\s+by(?:\s|$)/i.exec(normalized);
  if (!byMatch) return false;
  const beforeBy = byMatch[1].trim();
  if (!beforeBy) return false;
  // 允许最前面有一个乐器/声部限定词，随后必须全部是动作词。
  const tokens = beforeBy.split(/\s+/);
  const actionTokens = tokens.filter((token) => !/^[&＆]$/i.test(token) && !/^and$/i.test(token));
  if (actionTokens.length === 0) return false;
  // 首词可以是乐器/声部，其余必须是动作词。
  const actions = CREDIT_ACTION_PATTERN.test(actionTokens[0])
    ? actionTokens
    : actionTokens.slice(1);
  if (actions.length === 0) return false;
  return actions.every((token) => CREDIT_ACTION_PATTERN.test(token));
};

/**
 * `<乐器/声部> 录音地点` 形态的英文署名行：
 * `Drums Recorded at Aroom Studio`、`Strings Recorded at 广州中国唱片社录音室`、
 * `Vocals & Piano Recorded at Avon Studios,`、`Music & Vocals Recorded at Avon Acoustic Ltd`、
 * `Strings Recording Co-ordination by Stanley Leung`。
 *
 * 这些行以**乐器词开头**，`STARTS_WITH_CREDIT_ENGLISH_PATTERN` 的 `Recorded at`
 * 是行首锚定、接不住；且头部 `Strings Recorded` 整体不是任何单个标签，词表也接不住。
 * 判定：行首是一串已知英文乐器/声部词（`&` **或空格**连接，覆盖
 * `Solo Cello` 这类多词乐器），随后紧跟
 * `Recorded/Mixed/Mastered (at|by)` 或 `Recording`（录音事务说明）。
 * 乐器词必须逐词命中英文标签，`Drums are beating at dawn` 这类歌词
 * （第二词是 be 动词）不会命中。
 */
const isInstrumentRecordingHead = (value: string): boolean => {
  const normalized = value.trim().replace(/[\s\u3000]+/g, " ");
  const match =
    /^([A-Za-z]+(?:[\s&＆]+[A-Za-z]+)*)\s+(?:(?:recorded|mixed|mastered)\s+(?:at|by)\b|recording\b)/i.exec(
      normalized
    );
  if (!match) return false;
  const words = match[1].split(/[\s&＆]+/i).filter(Boolean);
  return (
    words.length > 0 &&
    words.every(
      (word) =>
        CREDIT_LABEL_PATTERN.exec(word)?.[0]
          .replace(/[\s\u3000]+/g, "")
          .toLowerCase() === word.toLowerCase()
    )
  );
};

/** 行首装饰：书名号、括号、项目符号与空白。署名行常带这些前缀，必须先剥离。 */
const LEADING_DECORATION_PATTERN = /^[\s\u3000\-—–~～·•*＊=＝+＋|｜/]+|^[【[（(「『《<]+/;

/** 包裹式标签：`【翻唱】某某`、`（后期）某某`、`[Mixing] John`。 */
const WRAPPED_CREDIT_LABEL_PATTERN =
  /^[【[（(「『《<]\s*([^】\]）)」』》>]{1,12}?)\s*[】\]）)」』》>]\s*(.+)$/u;

/** 判断取值片段是否含歌词高频虚词；命中则说明它更像正常歌词而非人名。 */
const hasLyricStopWord = (value: string): boolean =>
  LYRIC_STOP_WORDS.some((word) => value.includes(word));

/**
 * 剥离行首装饰或包裹式括号后返回 `标签\u0000取值`；无法拆分时返回 undefined。
 * 顺序很重要：包裹式标签必须先于装饰剥离判断，否则 `【翻唱】X` 会被剥成 `翻唱】X`。
 */
const splitCreditHead = (text: string): string | undefined => {
  const trimmed = text.trim();

  // 包裹式：`【翻唱】某某` 没有分隔符，靠括号定位标签边界。
  const wrapped = WRAPPED_CREDIT_LABEL_PATTERN.exec(trimmed);
  if (wrapped) return `${wrapped[1].trim()}\u0000${wrapped[2].trim()}`;

  const undecorated = trimmed.replace(LEADING_DECORATION_PATTERN, "").trim();
  const separatorMatch = CREDIT_SEPARATOR_PATTERN.exec(undecorated);
  if (separatorMatch) {
    const head = undecorated.slice(0, separatorMatch.index).trim();
    const tail = undecorated.slice(separatorMatch.index + separatorMatch[0].length).trim();
    if (head && tail) return `${head}\u0000${tail}`;
  }

  // 空格分隔的署名行：`制作人 徐鲤`、`录音师 韦生@鲸升音乐`、`录音棚 鲸升音乐`。
  // 空格是极弱的分隔符，**绝不能**无条件当分隔符用：
  // 1. 只信任**中文头部** —— `Piano in the dark`、`Drums are beating` 这类
  //    「英文乐器词 + 空格 + 歌词」是真实歌词的常见开头，英文头一律不拆
  //    （英文署名有 `Mixed by X` 的专用路径覆盖，不需要空格兜底）；
  // 2. 头部至少 2 个字符 —— 单字标签（`曲 终人散`、`词 爱恨`）是歌词写法，不拆；
  // 3. 头部不在 SPACE_SPLIT_HEAD_DENY：`感谢`/`设计` 这类**同时是高频歌词开头**
  //    的词，`感谢 陪伴` 是歌词而非署名（冒号形态不受影响，`感谢：X` 仍会剔除）。
  const spaceMatch = /^(\S+)[\s\u3000]+(\S.*)$/u.exec(undecorated);
  if (
    spaceMatch &&
    /[\u4e00-\u9fff\u3040-\u30ff]/u.test(spaceMatch[1]) &&
    [...spaceMatch[1]].length >= 2 &&
    !SPACE_SPLIT_HEAD_DENY.has(spaceMatch[1]) &&
    isCreditLabelOnly(spaceMatch[1])
  ) {
    return `${spaceMatch[1]}\u0000${spaceMatch[2].trim()}`;
  }
  return undefined;
};

/**
 * 裸机构名单行（无冒号、整行独占）：`太合音乐集团`、`朴林西思文化传媒`、
 * `北京国际音乐产业大会`、`主题歌音乐专辑工作团队`。以**强机构后缀**收尾的
 * 短行是制作名单页脚。刻意不收录 `唱片`/`娱乐`/`音乐` 等弱词 ——
 * `发霉的旧唱片` 这类歌词结尾必须保留；主体至少 3 字也排除 `某某公司` 式巧合。
 */
const BARE_ORG_SUFFIX_PATTERN =
  /^[\u4e00-\u9fffA-Za-z0-9·]{3,20}(?:集团|文化传媒|传媒|有限公司|公司|产业大会|工作团队)$/u;

/** 中文录音/混音机构粘连英文机构名：`升赫录音棚Soundhub Studio`。
 * 中文段以强设施词收尾 + 英文段是「首字母大写词 + Studio(s) 收尾」的机构形态；
 * 英文侧必须带 Studio(s) 后缀，`Love音乐` 这类非机构粘连不会命中。 */
const ZH_STUDIO_EN_ORG_PATTERN =
  /^[\u4e00-\u9fff]{2,20}(?:录音棚|录音室|工作室)[\s\u3000]*[A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*)*\s+Studios?$/u;

/** 最外层 `isCreditLabelOnly` 调用期间共享的递归记忆表；返回即丢弃。 */
let creditLabelMemo: Map<string, boolean> | undefined;

/**
 * 判断标签头部是否「完全由署名标签构成」。
 *
 * 判定按制作名单的书写形态分组，**规则次序即原优先级**，任一命中即判为署名行；
 * 全部落空后回到「连接符分段」兜底。各子判定只读 `value`，无副作用。
 */
const isCreditLabelOnly = (value: string): boolean => {
  // 粘连拆分、括号剥离、词缀剥离会对同一批子串反复递归，不记忆化时每多一个字耗时翻倍。
  // 判定是同步纯函数：最外层调用建一张表，递归期间共享，返回时丢弃，不跨调用持有状态。
  if (creditLabelMemo) {
    const known = creditLabelMemo.get(value);
    if (known !== undefined) return known;
    const result = classifyCreditLabel(value);
    creditLabelMemo.set(value, result);
    return result;
  }
  creditLabelMemo = new Map();
  try {
    return classifyCreditLabel(value);
  } finally {
    creditLabelMemo = undefined;
  }
};

const classifyCreditLabel = (value: string): boolean => {
  if (!value) return false;
  if (
    isSpacedBilingualLabel(value) ||
    isGluedBilingualLabel(value) ||
    isReversedBilingualLabel(value)
  )
    return true;
  if (isEnglishLabelVocabularyMatch(value)) return true;
  if (isCreditOrgLabel(value)) return true;
  if (isNumberedSlotLabel(value) || isBracketQualifiedLabel(value)) return true;
  if (isGluedChineseLabelPair(value) || isOpSpCopyrightPersonLabel(value)) return true;
  if (isAffixStrippedLabel(value)) return true;
  if (isLocationQualifiedActionLabel(value)) return true;
  // `Violin 1st` 这类序数尾缀，以及 `Arranged & Conducted by` 这类并列动作短语。
  if (isOrdinalSuffixStrippedLabel(value) || isCreditActionPhrase(value)) return true;
  if (isDotOrHeSegmentedLabel(value)) return true;
  return areAllCreditLabelSegments(value);
};

/** 带空格的中英对照署名：`制作人 Producer`、`混音师 Mixing Engineer`、`制谱 Music Copyist`。 */
const isSpacedBilingualLabel = (value: string): boolean => {
  // 中英混排：中文标签拼接英文标签，如 `曲Composer`、`词Lyricist`、`翻唱Cover`；
  // 网易云大量使用**带空格**的写法：`制作人 Producer`、`混音师 Mixing Engineer`、
  // `母带制作 Mastering Engineer`、`木吉他 Acoustic Guitar`。
  // 因此中文段要**整体捕获**（不止首字），中英之间允许空白；否则 `制作人 Producer`
  // 会被切成 `制` + `作人 Producer`，中文段过短而整条掉出词表。
  // 首字符必须是中日文字符，否则 `Special Thanks` 会被误拆成 `S` + `pecial Thanks`。
  // 英文段允许数字开头（`第一小提琴 1st Violin : X` 的双语序数形态）。
  const composite = /^([\u4e00-\u9fff\u3040-\u30ff]+)[\s\u3000]+([A-Za-z0-9][A-Za-z0-9\s]*)$/u.exec(
    value
  );
  if (!composite) return false;
  if (isCreditLabelOnly(composite[1]) && isCreditLabelOnly(composite[2].trim())) return true;
  // 中文标签 + 英文对照翻译（TitleCase）：`制谱 Music Copyist`、`企划 Creative Planning`、
  // `古琴 Guqin`。对照词永远追不完词表（copyist/planning/guqin…），而 TitleCase 是
  // 双语署名的强特征：句中歌词的英文短语几乎必含小写虚词，逐词首字母大写的
  // 短语只会出现在对照署名里。每词 ≥2 字母排除 `设计 A Story` 这类歌词，词数 ≤4。
  return (
    isCreditLabelOnly(composite[1]) &&
    /^(?:[A-Z][A-Za-z]{1,19})(?:\s+[A-Z][A-Za-z]{1,19}){0,3}$/u.test(composite[2].trim())
  );
};

/** 无空格粘连的中英对照署名：`曲Composer`、`二创效果Edit`、`音频编辑Audio Edited by`。 */
const isGluedBilingualLabel = (value: string): boolean => {
  // 无空格粘连形态：`曲Composer`、`词Lyricist`（英文字母紧贴中文）。
  const glued = /^([\u4e00-\u9fff\u3040-\u30ff]+)([A-Za-z][A-Za-z\s]*)$/u.exec(value);
  if (!glued) return false;
  if (isCreditLabelOnly(glued[1]) && isCreditLabelOnly(glued[2].trim())) return true;
  // 英文侧是普通英文单词后缀：`二创效果Edit`。与 joiner 段级的
  // 「已知标签 + 英文单后缀」同语义；中文侧必须是完整标签，
  // `Love音乐` 这类非标签中文侧不会命中。
  if (isCreditLabelOnly(glued[1]) && CREDIT_LABEL_SUFFIX_PATTERN.test(glued[2].trim())) return true;
  // 英文侧是 TitleCase 对照翻译：`统筹制作人Coordinating Producer : X`。
  // 与 composite（带空格）的 TitleCase 分支同语义，覆盖无空格粘连形态。
  if (
    isCreditLabelOnly(glued[1]) &&
    /^(?:[A-Z][A-Za-z]{1,19})(?:\s+[A-Z][A-Za-z]{1,19}){0,3}$/u.test(glued[2].trim())
  ) {
    return true;
  }
  // 英文侧是动作短语：`音频编辑Audio Edited by : X`。
  return isCreditLabelOnly(glued[1]) && isCreditActionPhrase(glued[2].trim());
};

/** 反向粘连：英文标签在前 + 中文标签紧贴，如 `Vocal录音室`、`Vocal制作助理`。 */
const isReversedBilingualLabel = (value: string): boolean => {
  // 正向（中文在前）由上面的 glued 覆盖；两侧都必须各自是完整标签，
  // `Love音乐` 这类（Love 非标签）不会命中。
  const reversed = /^([A-Za-z][A-Za-z\s]*?)([\u4e00-\u9fff\u3040-\u30ff]+)$/u.exec(value);
  if (!reversed) return false;
  return isCreditLabelOnly(reversed[1].trim()) && isCreditLabelOnly(reversed[2]);
};

/** 纯英文署名：整体命中词表、「限定词 + 角色」复合标签、短标签集合。 */
const isEnglishLabelVocabularyMatch = (value: string): boolean => {
  // 多词英文标签：`Special Thanks`、`Mixed By`、`Production Coordination`。
  // 匹配前压掉空格，兼容 `specialthanks` 这类上游已去掉空格的形式。
  const compact = value.replace(/[\s\u3000]+/g, "");
  const wholeLabel = CREDIT_LABEL_PATTERN.exec(value)?.[0].replace(/[\s\u3000]+/g, "");
  if (wholeLabel === compact) return true;

  // 英文「限定词 + 角色」：`Music Producer`、`Musical Supervisor`、`Vocal Arrangements`。
  // 逐词判定 —— 每个词都必须是已知英文标签，才能合成一个复合标签。
  // 旧实现只覆盖中文打头的复合形态（`制作人 Producer`），纯英文复合全部漏网。
  // `and`/`with` 是并列连接词而非标签：`Marketing and promotion agencies`
  // 的语义是「A and B + 中心词」，连接词剔除后剩余词全部命中词表才判。
  // 歌词（`you and me`、`and I love you`）剔完连接词后剩余词不是标签，自然否决。
  if (/^[A-Za-z][A-Za-z0-9\s-]*$/u.test(value)) {
    const words = value
      .trim()
      .split(/[\s\u3000]+/u)
      .filter(Boolean)
      .filter((word) => !/^(?:and|with|&)$/i.test(word));
    // R16 型号豁免：设备署名常带型号（`Yamaha CS-80 Synthesizer : X`），
    // 型号 token 永远不进词表。至多允许 1 个「字母-数字」形态的型号，
    // 其余词必须全部命中词表；歌词头（`Top-10 hits：X`）其余词非标签，自然否决。
    let modelSeen = false;
    const allLabeled = words.every((word) => {
      if (CREDIT_LABEL_PATTERN.exec(word)?.[0].replace(/[\s\u3000]+/g, "") === word) return true;
      if (!modelSeen && /^[A-Za-z]{1,6}-\d{1,4}[a-zA-Z]?$/u.test(word)) {
        modelSeen = true;
        return true;
      }
      return false;
    });
    if (words.length >= 2 && allLabeled) {
      return true;
    }
  }

  // 英文制作署名短标签：`A&R`、`Executive-Producer`、`Mixed At`（整体命中集合）。
  const normalizedForSet = value
    .normalize("NFKC")
    .trim()
    .replace(/[\s\u3000]+/g, " ")
    .toLowerCase();
  return EN_CREDIT_SHORT_LABELS.includes(normalizedForSet);
};

/** 设施词技术标签与机构名页脚：`弦乐线上录音系统…`、`升赫录音棚Soundhub Studio`、`太合音乐集团`。 */
const isCreditOrgLabel = (value: string): boolean => {
  // 长复合技术标签：`弦乐线上录音系统及弦乐档案编辑 : Leonard Fong`。
  // 结构判定限头 6 字、词表追不全这类展开写法；用「纯中文 + 强技术词」判定：
  // 只有含**录音/混音/母带的具体设施词**（系统/棚/室/工作室）才算，
  // `回忆的录音` 这类歌词化表达不含设施词、不会命中。
  if (
    /^[\u4e00-\u9fff]{2,24}$/u.test(value) &&
    /录音系统|录音棚|录音室|混音室|混音棚|混音师|录音师|母带处理|母带工程|工作室|导演团队/u.test(
      value
    )
  ) {
    return true;
  }
  // 中文设施词机构名 + 英文机构名粘连：`升赫录音棚Soundhub Studio`（见常量注释）。
  if (ZH_STUDIO_EN_ORG_PATTERN.test(value)) {
    return true;
  }

  // 裸机构名单行：`太合音乐集团`、`朴林西思文化传媒`、`北京国际音乐产业大会`、
  // `主题歌音乐专辑工作团队`。以**强机构后缀**收尾的短行是制作名单页脚。
  // 刻意不收录 `唱片`/`娱乐`/`音乐` 等弱词 —— `发霉的旧唱片` 这类歌词结尾
  // 必须保留；主体至少 3 字也排除 `某某公司` 式的两字巧合。
  return BARE_ORG_SUFFIX_PATTERN.test(value);
};

/** 编号/字母槽位：`键盘2`、`吉他1`、`人声录音棚A`。 */
const isNumberedSlotLabel = (value: string): boolean => {
  // 大编制制作名单会把同类乐器/录音棚按编号排布，词表里的 `键盘` 覆盖不到 `键盘2`。
  // 只允许在**已登记标签**后追加 1~2 位数字或单个大写字母，
  // 小写字母不放宽（`词a` 这类更像打字残渣以外的正常内容）。
  const compact = value.replace(/[\s\u3000]+/g, "");
  const slot = /^(.+?)(?:\d{1,2}|[A-Z])$/u.exec(compact);
  return !!slot && CREDIT_LABEL_PATTERN.exec(slot[1])?.[0].replace(/[\s\u3000]+/g, "") === slot[1];
};

/** 括号限定词：`Assistant Engineer (香港)`、`人声&吉他&鼓（打击乐）录音棚`。 */
const isBracketQualifiedLabel = (value: string): boolean => {
  // 制作名单常用括号标注地区/棚号等限定信息，剥离后若剩余部分是纯标签即命中。
  const withoutQualifier = value.replace(/[\s\u3000]*[（(][^（()）]{1,20}[)）]\s*$/u, "").trim();
  if (withoutQualifier && withoutQualifier !== value && isCreditLabelOnly(withoutQualifier))
    return true;
  // 中部括号限定词：`人声&吉他&鼓（打击乐）录音棚`。限定语夹在标签组合中间，
  // 剥离后各段仍是标签（`鼓录音棚` 走粘连拆分）即命中；歌词 `爱（真的）你`
  // 剥出 `爱你` 非标签，不受影响。
  const withoutMiddleQualifier = value.replace(/[（(][^（()）]{1,20}[)）]/u, "").trim();
  return (
    !!withoutMiddleQualifier &&
    withoutMiddleQualifier !== value &&
    isCreditLabelOnly(withoutMiddleQualifier)
  );
};

/** 纯中文标签粘连：`小提琴演奏`、`制作统筹`、`音乐出品发行公司`。 */
const isGluedChineseLabelPair = (value: string): boolean => {
  // 这类头由**两个已知标签直接拼接**而成（中间无连接符），逐段拆分接不住。
  // 枚举全部切分点，任一侧组合都命中词表才算；两侧都必须是完整登记标签，
  // 因此 `曲终人散`（曲|终人散，右侧非标签）、`说唱脸谱`（说唱|脸谱）等歌词头不受影响。
  if (!/^[\u4e00-\u9fff]{2,12}$/u.test(value)) return false;
  for (let cut = 1; cut < value.length; cut += 1) {
    if (isCreditLabelOnly(value.slice(0, cut)) && isCreditLabelOnly(value.slice(cut))) return true;
  }
  return false;
};

/** 版权代理行「人名 + OP/SP」固定写法：`梁翘柏OP`、`AlbertSP`。 */
const isOpSpCopyrightPersonLabel = (value: string): boolean => {
  // 这是版权代理行的固定写法（「词曲版权人 + OP/SP 缩写」），人名不可能进词表，
  // 只能按「中文人名或首字母大写英文名 + OP/SP 结尾」这一版权特有结构判定。
  return /^(?:[\u4e00-\u9fff]{2,6}|[A-Z][a-z]{1,11})(?:OP|SP)$/u.test(value);
};

/** 剥离首尾限定词后递归判定：`Chorus by`、`1st Violins`、`原制作人`。 */
const isAffixStrippedLabel = (value: string): boolean => {
  // 尾缀署名介词：`Chorus by : 陈奕迅`。剥离 ` by` 后按纯标签判定；
  // 递归兜底保证 `Kiss by` 这类剥出的词不是标签时不会误判。
  const withoutBy = value.replace(/\s+by$/i, "").trim();
  if (withoutBy && withoutBy !== value && isCreditLabelOnly(withoutBy)) return true;

  // 序数前缀：`1st Violins : X`、`2nd Violins : X`（弦乐声部分排），
  // 以及拼写数词形态 `First Violin : X`、`Second Violins : X`。
  const withoutOrdinal = value
    .replace(/^(?:(?:\d{1,2}(?:st|nd|rd|th))|(?:first|second|third|fourth|fifth))\s+/i, "")
    .trim();
  if (withoutOrdinal && withoutOrdinal !== value && isCreditLabelOnly(withoutOrdinal)) return true;

  // `原` 前缀：`原制作人 : X`、`原混音/母带工程师：X`（标注原版本制作班底）。
  // `原` 单字不是标签，粘连切分点枚举接不住；剥离后剩余部分是完整标签组合即判。
  // `原` 开头的歌词（`原来如此`）剥出 `来如此` 非标签，递归自然否决。
  const withoutOrigin = value.replace(/^原(?=[\u4e00-\u9fff]{2,})/u, "").trim();
  return !!withoutOrigin && withoutOrigin !== value && isCreditLabelOnly(withoutOrigin);
};

/** 地名限定 + 制作动作词收尾：`上海录音`、`北京混音`。 */
const isLocationQualifiedActionLabel = (value: string): boolean => {
  // 「上海」这类地名限定永远不进词表（枚举不完），但「`录音` 收尾的 2~4 字限定
  // + 冒号取值」形态只出现在制作名单 —— 歌词整行（`留下爱的录音`）无分隔符，
  // 走不进 head 路径，不受影响。
  return /^[\u4e00-\u9fff]{2,4}(?:录音|混音|录制|母带|剪辑)$/u.test(value);
};

/** 序数尾缀写法：`Violin 1st`、`Violin 2nd`。 */
const isOrdinalSuffixStrippedLabel = (value: string): boolean => {
  const withoutOrdinalSuffix = value.replace(/\s+\d{1,2}(?:st|nd|rd|th)$/i, "").trim();
  return (
    !!withoutOrdinalSuffix &&
    withoutOrdinalSuffix !== value &&
    isCreditLabelOnly(withoutOrdinalSuffix)
  );
};

/** `.` 分段与 `和` 连接：`作曲.监制`、`词和曲`。 */
const isDotOrHeSegmentedLabel = (value: string): boolean => {
  // 中文标签以 `.` 分隔的形态：`作曲.监制 : X`、`词.曲 : X`、`编.混.母 : X`。
  // `.` 不进通用 joiner（英文缩写 `C. Y. Kong` 依赖它），单独按「每段都是
  // 完整标签」判定 —— `谁.在.唱` 这类歌词拆出的段不是标签，自然否决。
  if (/^[\u4e00-\u9fff]{1,8}(?:\.[\u4e00-\u9fff]{1,8})+$/u.test(value)) {
    const dotSegments = value.split(".");
    if (dotSegments.length > 1 && dotSegments.every((segment) => isCreditLabelOnly(segment))) {
      return true;
    }
  }

  // `和` 连接：`词和曲：X`、`填词和编曲：X`。独立于通用 joiner ——
  // `和` 同时是 `和声`/`和音`/`和编` 等标签的首字，单字符切分会把
  // `吉他、贝司、和声` 切出孤立 `声` 段而整条漏网。按 `和` 切开的
  // 每段都必须递归命中完整标签，`我和你`、`早餐和午餐` 自然否决。
  if (!value.includes("和")) return false;
  const andSegments = value.split("和").filter(Boolean);
  return andSegments.length > 1 && andSegments.every((segment) => isCreditLabelOnly(segment));
};

/** 连接符分段兜底：每段都是「已知标签 或 接在已知标签后的英文单后缀」。 */
const areAllCreditLabelSegments = (value: string): boolean => {
  const segments = value.split(CREDIT_LABEL_JOINER_PATTERN).filter(Boolean);
  if (segments.length === 0) return false;
  let previousWasLabel = false;
  for (const segment of segments) {
    const compactSegment = segment.replace(/[\s\u3000]+/g, "");
    if (CREDIT_LABEL_PATTERN.exec(segment)?.[0].replace(/[\s\u3000]+/g, "") === compactSegment) {
      previousWasLabel = true;
      continue;
    }
    if (previousWasLabel && CREDIT_LABEL_SUFFIX_PATTERN.test(compactSegment)) continue;
    // 段级递归：`鼓录音棚`（鼓|录音棚粘连）这类复合段不命中词表，
    // 但整体是合法标签组合。只在**真拆分产物**（多段）上递归 ——
    // 单段即 value 本身，递归会无限自调用爆栈。
    if (segments.length > 1 && isCreditLabelOnly(segment)) {
      previousWasLabel = true;
      continue;
    }
    return false;
  }
  return true;
};

/** 头部恰好是纯角色词（`合`、`男`、`合唱`），用于区分「角色标注」与「角色标记 + 歌词」。 */
const DUET_ROLE_LABEL_PATTERN = /^(?:男|女|合|合唱|对唱|独唱|童声|念白|所有人|大家一起)$/u;

/**
 * 取值侧是否含有「实质歌词内容」。
 *
 * 判定标准刻意宽松：只要有效字符达到 4 个以上，就认为右侧是歌词正文而非人名。
 * 制作名单的取值是人名（通常 2~4 字，且多以分隔符并列），不会是一整句歌词；
 * 而 `【合】有英雄漂泊异乡 故土遥远` 的右侧是一整句，必须归为歌词。
 */
const isSubstantiveLyricTail = (tail: string): boolean => {
  const compact = tail.normalize("NFKC").replace(/[\s\u3000\p{P}\p{S}]/gu, "");
  return compact.length >= 4;
};

/**
 * 整行特征即署名的正则集合：每条一个专属结构，互不重叠，命中任意一条即为署名行。
 * 逐条注释保留了当初加入的实测样本，删除任何一条都会放回一类歌词噪声。
 */
const WHOLE_LINE_CREDIT_PATTERNS: readonly RegExp[] = [
  // `Drums Recorded at Aroom Studio` 这类以乐器词开头的录音信息行之外，以署名动词开头的英文行。
  STARTS_WITH_CREDIT_ENGLISH_PATTERN,
  // Discogs 风格短标签（`Mixed At – X`、`Executive-Producer – X`）：分隔符是 en dash，
  // `Executive-Producer` 还会被内部连字符抢先切开，必须用整行前缀判定绕开。
  EN_CREDIT_PREFIX_PATTERN,
  // 唱片版权行：`P - Line: 2016 ...`、`C-Line: 2016 ...`（Phonogram/Copyright 标准写法）。
  // ` - ` 会把 head 切成孤立的 `P`，整行掉出词表路径，按单字母前缀整行判定。
  // `line` 后必须紧跟冒号：`C line up ...` 这类潜在歌词不受影响。
  /^[pc]\s*[-—–]?\s*line\s*[:：]/i,
  // CV 配音标注：`温迪（CV：喵酱）`、`雷电将军（CV：菊花花）`。同人曲的角色名单
  // 本身就是歌曲指纹，且整行不含任何歌词正文，按结构整行判定。
  /^[^（()）]{1,20}（\s*CV\s*[：:][^（()）]{1,20}）\s*$/u,
  // 采样/配乐说明：`（间奏旋律采用阿鲲老师《流浪地球2》配乐：《开启新征程》...）`。
  // 泄露采样出处，整行括号包裹且内含「采用…配乐」结构。注意行首 `（` 可能已被
  // 装饰剥离，左括号可选。
  /^[（(]?[^（()）]*采用[^（()）]*配乐[^（()）]*[）)]$/u,
  // LRC 站点水印：`Maximal R&B - The Freshest & Hottest R&B/ Hip-Hop Music!`。
  /^maximal\s+r&b\b/i,
  // 制作工具残留：`Maker Tool: LRC Editor for mac`（LRC 编辑器签名）。
  /\b(?:lrc\s+editor|maker\s+tool)\b/i,
  // LRC 重复标记：`REPEAT----->`、`REPEAT:`。歌词不会以裸 `repeat` + 标点/横线收尾。
  /^repeat[\s\-—–=_>.:：·]*$/i,
  // 游戏运营团队出品声明：`CS: GO国服运营团队出品`（游戏同人曲企划页脚）。
  // `CS:` 会被分隔符抢先切成非标签 head，词表路径接不住，按整行特征判定。
  /运营团队出品/u,
  // 书名号标题 + 制作名单：`《Plot: 0》动画 staff`。标题部分永远不进词表，
  // 按「书名号包裹 + staff/制作名单收尾」结构判定。注意 LEADING_DECORATION
  // 已把行首 `《` 剥掉（形如 `Plot: 0》动画 staff`），左书名号必须可选，
  // 且标题段限 40 字内防止吞进长歌词。
  /^[《【]?[^《【》】]{1,40}[》】]\s*(?:动画|番剧|制作)?\s*(?:staff|制作名单|名单)\s*$/iu,
];

/**
 * 主要版权厂牌裸行：`Warner/Chappell Music, Hong Kong Limite`。纯英文裸行走不进
 * 裸行路径（要求含中日文字），按「厂牌名开头 + 行内含公司后缀词」双条件判定；
 * `\b` 词边界防止 `emi` 吃掉 `Eminem` 一类人名，公司后缀词排除
 * `Universal love is all we need` 这类纯英文歌词。
 */
const isPublisherOrgLine = (line: string): boolean =>
  /^(?:warner(?:\s*\/\s*chappell)?|chappell|universal|sony|emi|bmg|kobalt|peermusic)\b/i.test(
    line
  ) && /\b(?:music|records?|publishing|entertainment|limited|ltd|group|studios?)\b/i.test(line);

/**
 * 多段方括号署名：`【古筝：陶特】【古琴/二胡：X】【笛箫：Y】【协力：Z】`。
 * 必须对**原始文本**判定 —— 行首 `【` 会被装饰剥离破坏结构。
 * 每段的 head（首个分隔符之前）必须命中词表 —— `【副歌】【间奏】` 这类
 * 段落标记的 head 不是标签，自然保留。
 */
const isBracketLabeledCreditLine = (text: string): boolean => {
  if (!/^(?:【[^【】]{1,24}】\s*){2,}$/u.test(text.trim())) return false;
  const bracketSegs = text.trim().match(/【([^【】]{1,24})】/gu) ?? [];
  return (
    bracketSegs.length >= 2 &&
    bracketSegs.every((seg) => {
      const inner = seg.slice(1, -1);
      // `︰`(U+FE13)/`﹕`(U+FE55) 是网易云实测出现的变体冒号。
      const parts = inner.split(/[：:︰﹕／/]/);
      return parts.length >= 2 && isCreditLabelOnly(parts[0].trim());
    })
  );
};

/**
 * 裸标签行：credit 块的段落标题独占一行（`出品`、`联合出品`），无冒号也无取值，
 * `splitCreditHead` 因找不到分隔符而整条失效。这里**只接受单个已登记标签**
 * 或强机构后缀行（`BARE_ORG_SUFFIX_PATTERN`），**不走** `isCreditLabelOnly`
 * 的粘连/逐段拆分 —— `后期制作人`（后期|制作人）这类两标签粘连是真实歌词，
 * 必须保留（正式测试回归抓到过）。同时沿用 SPACE_SPLIT_HEAD_DENY：
 * `感谢`、`导演` 这类高频歌词词裸写整行时按歌词保留；单字行交给过短/角色判定。
 */
const isBareCreditLabelLine = (line: string): boolean =>
  /[\u4e00-\u9fff\u3040-\u30ff]/u.test(line) &&
  [...line].length >= 2 &&
  !SPACE_SPLIT_HEAD_DENY.has(line) &&
  (CREDIT_LABEL_PATTERN.exec(line)?.[0].replace(/[\s\u3000]+/g, "") ===
    line.replace(/[\s\u3000]+/g, "") ||
    BARE_ORG_SUFFIX_PATTERN.test(line) ||
    ZH_STUDIO_EN_ORG_PATTERN.test(line));

/** 词表命中的署名行（含行首装饰剥离、包裹式标签与多标签合并）。 */
export const isCreditKeywordLine = (text: string): boolean => {
  const undecorated = text.trim().replace(LEADING_DECORATION_PATTERN, "").trim();

  // `Strings Arranged & Conducted by 某某` 这类没有冒号的英文署名，先整行判定。
  if (isCreditActionPhrase(undecorated)) return true;
  if (isInstrumentRecordingHead(undecorated)) return true;
  if (isPublisherOrgLine(undecorated)) return true;
  if (isBracketLabeledCreditLine(text)) return true;
  if (isBareCreditLabelLine(undecorated)) return true;
  for (const pattern of WHOLE_LINE_CREDIT_PATTERNS) {
    if (pattern.test(undecorated)) return true;
  }

  const parts = splitCreditHead(text);
  if (!parts) return false;
  const [head, tail] = parts.split("\u0000");
  // 只压缩空白，不能整体删除：`Special Thanks` 这类多词英文标签依赖词间空格。
  const normalizedHead = head
    .normalize("NFKC")
    .replace(/[\s\u3000]+/g, " ")
    .trim();
  if (!normalizedHead) return false;
  // 标签必须覆盖整个头部，避免「曲终人散：」这类以署名词开头的正常歌词被误判。
  if (!isCreditLabelOnly(normalizedHead)) return false;

  // 角色词（男/女/合/合唱…）单独成标签时，只可能是「空取值」的分工标注。
  // `【合】有英雄漂泊异乡`、`【男】让我用心把你留下来` 这类是**真实歌词**
  // （角色标记 + 歌词正文），若按标签命中整行剔除会大面积误杀合唱段落。
  // 因此当头部是纯角色词、且取值侧存在实质歌词内容时，拒绝判定为署名行。
  if (DUET_ROLE_LABEL_PATTERN.test(normalizedHead) && isSubstantiveLyricTail(tail)) {
    return false;
  }
  // 英文段落词（`solo：我一个人跳舞`、`rap：看我的flow`）与乐器独奏署名同名，
  // 但它们常被用作歌词排版标记。区分标准与角色词一致：
  // 头部**恰好是这个词**（不是 `Guitar Solo` 这类复合署名）且右侧是实质歌词 → 放行。
  if (/^(?:solo|rap)$/i.test(normalizedHead) && isSubstantiveLyricTail(tail)) {
    return false;
  }
  return true;
};

/**
 * 结构判定：`短标签 + 分隔符 + 空格分隔的人名串`。
 *
 * 真实歌词极少出现「无谓语标签 + 冒号 + 纯空格分隔的短片段」这种形态，而制作名单
 * 几乎全是这个结构（`翻唱：悼子\ワカイ调和剂\夙夜\浅安` 在网易云里就是空格分隔）。
 * 为防止误杀，同时要求：标签不含标点与数字、行内不含歌词高频虚词、右侧每个片段都不含虚词。
 */
export const isCreditStructuredLine = (text: string): boolean => {
  const parts = splitCreditHead(text);
  if (!parts) return false;
  const [head, tail] = parts.split("\u0000");

  const normalizedHead = head.normalize("NFKC").trim();
  const compactHead = normalizedHead.replace(/[\s\u3000]/g, "");
  if (/[，。！？；、,.!?;:："'“”]/u.test(compactHead)) return false;
  if (/\d/.test(compactHead)) return false;
  if (!/^[\u4e00-\u9fffA-Za-z\u3040-\u30ff]{1,6}$/u.test(compactHead)) return false;

  const normalizedTail = tail.normalize("NFKC").trim();
  if (!normalizedTail) return false;
  if (/[，。！？；,.!?;]/u.test(normalizedTail)) return false;

  const segments = normalizedTail.split(/[\s\u3000\\／/|｜、,，&＆]+/u).filter(Boolean);
  // 单段时要求排除虚词（`混音：张三` 这类单人名仍会被词表路径捕获），
  // 多段时只否定含虚词的片段，避免「悼子\夙夜」这种真名被虚词表误伤。
  if (segments.length === 1 && hasLyricStopWord(segments[0])) return false;
  if (segments.some((segment) => segment.length > 8 || hasLyricStopWord(segment))) return false;

  return true;
};

/** 已确认的角色/段落正文优先于任何署名结构启发式。 */
const isMarkedLyricBody = (text: string): boolean => {
  const parts = splitCreditHead(text);
  if (!parts) return false;
  const [head, tail] = parts.split("\u0000");
  const label = head.normalize("NFKC").trim();
  return (
    (DUET_ROLE_LABEL_PATTERN.test(label) || /^(?:solo|rap)$/i.test(label)) &&
    isSubstantiveLyricTail(tail)
  );
};

/** 过滤会直接暴露创作人员的 LRC 署名行。 */
export const isCreditLyricLine = (text: string) =>
  !isMarkedLyricBody(text) && (isCreditKeywordLine(text) || isCreditStructuredLine(text));

/**
 * 整行是署名式的取值片段（人名串），用于把连排制作名单整块剔除。
 *
 * 为免误杀真实歌词（如 `第一句歌词`），这里只接受**明确的多段人名串**：
 * 必须由 `\`、`/`、空格、顿号等分隔出至少 2 段短片段，
 * 或整行是「名字 + 名字」这种无谓语并列。单段连续文本一律视为歌词。
 */
export const isCreditTailLine = (text: string): boolean => {
  if (isCreditLyricLine(text)) return true;
  const trimmed = text.trim().replace(LEADING_DECORATION_PATTERN, "").trim();
  if (!trimmed || /[:：]/u.test(trimmed)) return false;
  // 含句末语气/标点的明显是歌词
  if (/[，。！？；,.!?;、]/u.test(trimmed)) return false;
  const segments = trimmed.split(/[\s\u3000\\／/|｜&＆]+/u).filter(Boolean);
  // 必须是多个短片段；单段连续文本（哪怕很短）视作歌词，避免误杀 `第一句歌词`。
  if (segments.length < 2) return false;
  if (segments.some((segment) => segment.length > 8 || hasLyricStopWord(segment))) return false;
  return trimmed.length <= 40;
};
