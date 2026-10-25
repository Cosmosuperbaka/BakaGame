import { AppError } from "../../domain/Errors";
import {
  BangumiMusicTrack,
  BangumiMusicTrackKind,
  BangumiSubjectDetails,
  SongSearchResult,
  isBangumiCreditsEntry,
} from "../../shared/Index";
/** 曲名/专辑/歌手的归一、相似度与匹配门禁（出题候选过滤的纯函数）。 */

export const normalizeSongText = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\-_'"“”‘’·.，,。!！?？()（）[\]【】]/g, "");
export const VERSION_MARKER_PATTERN =
  /(?:伴奏|纯音乐|电视尺寸|动画剪辑|\b(?:inst(?:rumental)?\.?|off\s*vocal|karaoke|tv\s*size|anime\s*edit|radio\s*edit|ver(?:sion)?\.?|version|mix|edit|remaster(?:ed)?|live|acoustic|demo|cover|remix|feat(?:uring)?\.?)\b)/iu;
export const BRACKETED_VERSION_PATTERN = /\s*[（(【[]\s*([^）)】\]]*)\s*[）)】\]]/gu;
export const DECORATED_VERSION_SUFFIX_PATTERN = /\s*[-~～–—]+\s*(.*?)\s*(?:[-~～–—]+\s*)?$/u;
export const BARE_VERSION_SUFFIX_PATTERN =
  /\s+(?:inst(?:rumental)?\.?|off\s*vocal|karaoke|伴奏|纯音乐|电视尺寸|动画剪辑|tv\s*size|anime\s*edit|radio\s*edit|remix|(?:[^\s]+\s+)?ver(?:sion)?\.?)\s*$/iu;
export const FEAT_SUFFIX_PATTERN =
  /\s*(?:[（(【[]\s*)?feat(?:uring)?\.?\s*[^）)】\]]+[）)】\]]?\s*$/iu;

export const stripSongVersionInfo = (value: string) => {
  let result = value.replace(BRACKETED_VERSION_PATTERN, (match, metadata: string) =>
    VERSION_MARKER_PATTERN.test(metadata) ? "" : match
  );

  while (true) {
    const next = result
      .replace(DECORATED_VERSION_SUFFIX_PATTERN, (match, metadata: string) =>
        VERSION_MARKER_PATTERN.test(metadata) ? "" : match
      )
      .replace(BARE_VERSION_SUFFIX_PATTERN, "")
      .replace(FEAT_SUFFIX_PATTERN, "");
    if (next === result) return result;
    result = next;
  }
};

export const normalizeSongTitle = (value: string) => normalizeSongText(stripSongVersionInfo(value));

/**
 * 「候选名是期望名的截断」这一方向的匹配门槛。
 *
 * 反方向（候选名**包含**期望名，如 `曲名 - 番剧名`、`曲名 (TV Size)`）是合法常态，
 * 保持宽松即可；但反过来，候选只是期望名的一小段时，实测全是误匹配事故：
 * Bangumi《いつだってYELL》（忍者乱太郎 ED）匹配上 2026 年毫无关系的《Yell》，
 * 《ぼくらは小さな悪魔》匹配上《ぼくら》。要求截断名既够长、又占原名足够比例。
 */
export const MIN_TRUNCATED_TITLE_LENGTH = 4;
export const MIN_TRUNCATED_TITLE_RATIO = 0.6;

/**
 * 曲名里的「多曲并列」分隔符：双 A 面单曲、合作曲会把两首歌写进同一个条目名。
 *
 * Bangumi 记 `メグメル／だんご大家族`（《CLANNAD》双 A 面单曲），网易云候选只是其中
 * 一首《だんご大家族》 —— 两者指同一张单曲、同一首可出的歌。这类并列必须先拆段再比对，
 * 否则会被「截断门槛」误判成「候选只是原名的一小段」而拒掉。
 *
 * **只认真正的曲目列表分隔符**（`/` `／` `・` 与合作署名），不认 `;` `&` `,` `、`：
 * 后者常是**作品名内部的标点**，拆出来的「段」并不是歌名 —— 实测事故：条目
 * `CHAOS;CHILD AUDIO DRAMA & RADIO DIGEST VOL.1` 被 `;` / `&` 拆段后，「chaos」成了
 * 一个合法段，于是与它同名的无关曲《Chaos》(Parry Music) 靠这段匹配过了门禁出题
 * （该番只有广播剧，本来就不该出题）。
 */
export const TITLE_SEGMENT_SEPARATOR_PATTERN = /[/／・]|\bfeat(?:uring)?\.?\b|\bwith\b/iu;

export const splitTitleSegments = (value: string): string[] =>
  value.split(TITLE_SEGMENT_SEPARATOR_PATTERN).map(normalizeSongTitle).filter(Boolean);

export const isSongTitleMatch = (candidateTitle: string, expectedTitle: string): boolean => {
  // 版权署名 / 制作委员会条目不是歌曲。若放任其参与子串匹配，
  // `©BanG Dream! Project` 会因包含 `banGdream` 而与《Bang Dream!》误判为同一首，
  // 从而把完全无关的歌曲当成番剧主题曲（实测事故）。
  if (isBangumiCreditsEntry(candidateTitle) || isBangumiCreditsEntry(expectedTitle)) return false;
  const normCandidate = normalizeSongTitle(candidateTitle);
  const normExpected = normalizeSongTitle(expectedTitle);
  if (!normCandidate || !normExpected) return false;
  if (normCandidate === normExpected) return true;
  // 多曲并列：条目名或候选名拆段后任一段完全一致，即视为同一首。
  const expectedSegments = splitTitleSegments(expectedTitle);
  if (expectedSegments.length > 1) {
    const candidateSegments = new Set(splitTitleSegments(candidateTitle));
    if (expectedSegments.some((segment) => segment.length >= 2 && candidateSegments.has(segment))) {
      return true;
    }
  }
  const minLen = Math.min(normCandidate.length, normExpected.length);
  if (minLen < 2) return false;
  // 候选名更长：`曲名 - 番剧名` / `曲名 (TV Size)` 这类合法形态，照旧放行。
  if (normCandidate.includes(normExpected)) return true;
  // 候选名更短：只接受「截断得不多」的情形（见上面的门槛注释）。
  const maxLen = Math.max(normCandidate.length, normExpected.length);
  return (
    normExpected.includes(normCandidate) &&
    minLen >= MIN_TRUNCATED_TITLE_LENGTH &&
    minLen / maxLen >= MIN_TRUNCATED_TITLE_RATIO
  );
};

export const normalizedArtists = (value: string) =>
  new Set(
    value
      .split(/\s*(?:,|，|、|&|＆|\/|／|;|；|\bx\b|\bfeat(?:uring)?\.?\b|\bwith\b)\s*/iu)
      .map(normalizeSongText)
      .filter(Boolean)
  );

/** 明确指向翻唱、改编或非原唱的标记（标题、专辑与标签通用）。 */
export const COVER_MARKER_PATTERN =
  /翻唱|翻錄|翻录|カバー|커버|\bcover(?:ed|s|ing)?\b|重唱|再唱|自翻|试唱|試唱|模仿|リミックス|カヴァー/iu;
/** 没有人声的版本标记：伴奏、纯音乐、卡拉 OK —— 这类音轨根本无法当题面。 */
export const NO_VOCAL_VERSION_PATTERN =
  /伴奏|純伴奏|纯伴奏|纯音乐|纯音楽|純音樂|純音楽|off\s*vocal|インスト|karaoke|カラオケ|伴唱|和声伴奏|ボーカルレス|\binstrumental\b/iu;
/** 非原唱演绎版本标记：无人声版本 + 现场 / 不插电 / demo 等演绎形态。 */
export const NON_ORIGINAL_VERSION_PATTERN = new RegExp(
  `${NO_VOCAL_VERSION_PATTERN.source}|live|现场|現場|演唱会|演唱會|acoustic|不插电|不插電|demo|试听|試聽`,
  "iu"
);
/**
 * 台词 / 广播剧音轨标记。这类「曲目」里没有人唱歌，放进题面等于放一段对白，
 * 玩家根本无从猜起。实测事故：Bangumi 把《サイコパス2 第5巻 特典CD》与
 * 《コードギアス…Sound Episode 1》挂成关联曲目，而网易云对应专辑里排在前面的
 * 正是「ドラマ」「短編ドラマ…」这类台词轨，曲名门禁靠「专辑名 == 条目名」放行。
 * 注意「ドラマチック / ドラマティック」（dramatic）是正常曲名，必须排除。
 */
export const DRAMA_TRACK_PATTERN =
  /ドラマ(?!チック|ティック|ツルギー)|sound\s*drama|voice\s*drama|audio\s*drama|\bdrama\s*(?:cd|part|track)\b|ミニドラマ|ボイスドラマ|短編ドラマ|台詞|セリフ/iu;
/**
 * 电台 / 谈话节目分轨标记。
 *
 * 特典 CD 里塞整期广播节目的分轨很常见，实测事故：《四月は君の嘘 第8巻 特典CD》
 * 整张就是「ラジオ 出張版」第 1~5 回（最短 139s、最长 1072s），全部是声优闲聊。
 * 玩家听到一段日语谈话根本无从猜番，与台词轨同类。
 *
 * 只认「节目分轨」形态（ラジオ + 出張版 / 第 N 回 / #NN），不碰叫《ラジオ》的正常歌名。
 */
export const RADIO_TALK_TRACK_PATTERN =
  /ラジオ[^\n]{0,20}(?:出張版|第\s*\d+\s*回|#\s*\d+)|フリートーク|トーク\s*コーナー|\bradio\s*digest\b|广播节目|廣播節目/iu;
/**
 * 纯编号音轨名（`M-815` / `Track 01` / `BGM 12`）。原声带里的曲目常只有编号，
 * 玩家听到的是一段配乐而不是一首歌。实测事故：《Dragon Ball Z ヒット曲集》被专辑路径
 * 匹配到《动画〈龙珠Z〉背景音乐原声带》，取回的第一轨就是 `M-815`（钢琴 BGM）。
 */
export const TRACK_NUMBER_TITLE_PATTERN =
  /^\s*(?:m|track|inst|bgm|音轨|音軌|トラック)[\s\-_#.]*\d{1,4}\s*$/iu;
/**
 * 专辑名里能证明「这是动画的盘」的发行上下文。
 *
 * 用于番剧级兜底：**专辑名含番剧名**本身不足以证明归属 —— 泛用名会撞车。
 * 实测事故：动画《Rebirth》(2020) 的主题歌是《Reバース GO!》，但按番剧名检索召回了
 * 同名的《Rebirth》(AMAST&MEDEM)，其专辑名就叫《Rebirth》；1983 年的《爱丽丝梦游仙境》
 * 更被 2013 年的粤语同名歌顶掉。真正的动画盘几乎总带这类发行标记。
 */
export const ANIME_RELEASE_CONTEXT_PATTERN =
  /アニメ|animation|オリジナルサウンドトラック|サウンドトラック|original\s*sound\s*track|sound\s*track|\bost\b|オリジナル|原声|原聲|主題歌|主题歌|テーマソング|キャラクターソング|キャラソン|特典|ソング集|ボーカル|vocal|ベスト|best|音楽|音乐|アルバム|album|コレクション|collection|コンプリート|complete|劇伴|cd|盤|盘/iu;
/**
 * 器乐改编 / 二次演奏标记：管弦、交响、钢琴、八音盒等。它们与原唱原版
 * 完全不是同一次录音，即使曲名一模一样也必须排在原版之后。
 *
 * 实测事故：网易云检索《君の名は。》时，帝玖管弦乐团的《交响组曲「君の名は。」》
 * 因曲名包含番剧原名而通过门禁，并以「原声带」身份出现在结算卡片上。
 */
export const INSTRUMENTAL_ARRANGEMENT_PATTERN =
  /交响|交響|管弦|オーケストラ|\borchestra\b|吹奏楽|吹奏乐|弦乐|弦樂|钢琴|鋼琴|ピアノ|\bpiano\b|八音盒|音乐盒|音樂盒|オルゴール|music\s*box|演奏|器乐版|純器樂|instrumental|アレンジ|\barra[gn]\w*|改编|改編|アコースティック/iu;
/**
 * 非原唱标记与其降权分。命中即降权，但**只在 Bangumi 曲目自身没有该标记时生效**：
 * 题面本身就是 Cover / Arrange / Remix 版本时，不该把候选都当成「非原版」罚一遍
 * （否则该曲目所有候选一起被降权，等于随机）。
 */
export const NON_ORIGINAL_MARKERS: ReadonlyArray<readonly [RegExp, number]> = [
  [COVER_MARKER_PATTERN, 5],
  [NON_ORIGINAL_VERSION_PATTERN, 4],
  [INSTRUMENTAL_ARRANGEMENT_PATTERN, 5],
];

export const songTitleSimilarity = (candidateTitle: string, expectedTitle: string): number => {
  const normCandidate = normalizeSongTitle(candidateTitle);
  const normExpected = normalizeSongTitle(expectedTitle);
  if (!normCandidate || !normExpected) return 0;
  if (normCandidate === normExpected) return 2;
  // 候选名只是「长条目名里的一小截」时不给分 —— 必须复用 `isSongTitleMatch` 的截断门槛。
  // 实测事故：Bangumi 把《TVアニメ Free! キャラクターソング・デュエットシングル Vol.1》
  // 挂成关联曲目，网易云在「Free! + 角色歌」的检索里召回了毫不相关的外文歌
  // 《Free》(Bling047)：它靠「被包含」拿到 1 分，再靠「番剧上下文命中」凑够证据出了题。
  // `isSongTitleMatch` 早就有这道门槛，而准入判定走的是本函数 —— 两处口径必须一致。
  if (
    normExpected.includes(normCandidate) &&
    (normCandidate.length < MIN_TRUNCATED_TITLE_LENGTH ||
      normCandidate.length / normExpected.length < MIN_TRUNCATED_TITLE_RATIO)
  ) {
    // 双 A 面单曲例外：条目名拆段后整段完全一致仍是同一首（见 isSongTitleMatch）。
    const expectedSegments = splitTitleSegments(expectedTitle);
    if (expectedSegments.length > 1) {
      const candidateSegments = new Set(splitTitleSegments(candidateTitle));
      if (
        expectedSegments.some((segment) => segment.length >= 2 && candidateSegments.has(segment))
      ) {
        return 1;
      }
    }
    return 0;
  }
  return normCandidate.includes(normExpected) || normExpected.includes(normCandidate) ? 1 : 0;
};

/**
 * 候选歌曲的专辑名与 Bangumi 曲目名完全一致（规范化后）时，视为「原版发行」特征。
 *
 * 为什么必须认这个特征：
 * 1. **单曲版原版**：原唱原版通常发行在同名单曲/专辑里（YOASOBI《勇者》的专辑名
 *    就是《勇者》），而同名翻唱挂在《勇者-葬送的芙莉莲OP》这类自建合辑下。两者曲名
 *    完全相同（相似度并列）时，专辑名是否命中是唯一能区分原版的免费信号。
 * 2. **整张原声带条目**：Bangumi 会把动画原声带整张专辑挂成一条关联曲目
 *    （曲目名 = 专辑名，如《君の名は。》），此时按曲名检索只能召回同名翻奏
 *    （《交响组曲「君の名は。」》），官方原声带里真正的曲目（前前前世 / スパークル…）
 *    只有专辑名能命中。允许专辑名命中，才能让官方原版进入候选池。
 */
export const isSongAlbumMatch = (
  candidateAlbum: string | undefined,
  expectedTitle: string
): boolean => {
  if (!candidateAlbum) return false;
  const normalizedAlbum = normalizeSongTitle(candidateAlbum);
  const normalizedTitle = normalizeSongTitle(expectedTitle);
  return Boolean(normalizedAlbum) && normalizedAlbum === normalizedTitle;
};

/**
 * 候选是否与 Bangumi 曲目相关：曲名命中，或专辑名与原曲目名完全一致。
 * 比 isSongTitleMatch 宽松一档，专供关联曲目解析使用（结算展示与手动猜歌门禁
 * 仍走严格曲名判定）。
 */
export const isSongCandidateMatch = (candidate: SongSearchResult, expectedTitle: string): boolean =>
  isSongTitleMatch(candidate.title, expectedTitle) ||
  isSongAlbumMatch(candidate.album, expectedTitle);

/** 歌手名是否与 Bangumi 记录有交集，无记录时返回 undefined（不参与加减分）。 */
export const artistOverlap = (
  candidate: SongSearchResult,
  track: BangumiMusicTrack
): boolean | undefined => {
  const trackArtists = track.artist ? normalizedArtists(track.artist) : new Set<string>();
  if (trackArtists.size === 0) return undefined;
  const candidateArtists = normalizedArtists(candidate.artist);
  return [...trackArtists].some((artist) => candidateArtists.has(artist));
};

/**
 * 「候选名只是条目名的一截」时，专辑名能否把候选锚到这条目 / 这部番上。
 *
 * 为什么不能只靠「出现在带番剧名的检索结果里」：网易云的模糊检索会把无关的同名曲
 * 一起召回，那条信号对短名（尤其泛用词）几乎恒真。实测事故：Princess Principal 的
 * 角色歌单曲条目《5 Moving Shadows》召回了《Moving Shadows》(Lessovsky / Max Vertigo，
 * 专辑《5 (Five Years of Kiez Beats)》) 并出题。
 *
 * 认可的锚点：专辑名含**番剧名**（且带发行上下文，避免「同名自建盘」——见
 * `albumNameScore` 的同一道闸门），或专辑名含**条目名**（官方盘与自建上传常直接以
 * 条目名 / 曲名命名专辑）。
 */
export const albumAnchorsWork = (
  albumName: string | undefined,
  track: BangumiMusicTrack,
  animeNames: readonly string[]
): boolean => {
  if (!albumName) return false;
  const normalizedAlbum = normalizeSongTitle(albumName);
  if (!normalizedAlbum) return false;
  const animeLinked = animeNames.some((name) => {
    const normalizedName = normalizeSongTitle(name);
    return normalizedName.length >= 4 && normalizedAlbum.includes(normalizedName);
  });
  if (animeLinked) return ANIME_RELEASE_CONTEXT_PATTERN.test(albumName);
  const normalizedEntry = normalizeSongTitle(track.title);
  return normalizedEntry.length >= 4 && normalizedAlbum.includes(normalizedEntry);
};

/**
 * 候选出现在「曲名 + 番剧名 / 中文名」检索结果里的加分。
 *
 * 取 3 是针对实测的错配场景定的：别人家的同名原创常拿满「曲名 + 专辑名」4 分，
 * 而番剧原版的专辑名多为「番剧名 - 曲名」这类形态、只拿曲名 2 分；加 3 后原版 5 分
 * 反超，同时又不会盖过「歌手与 Bangumi 记录有交集 +4」这条更硬的证据。
 */
export const ANIME_SCOPED_BONUS = 3;

/**
 * 「非音乐」曲目 kind：条目本身是广播剧 / 电台 / 朗读，走专辑路径会把分轨对白当歌出题。
 *
 * 其余 kind 一律允许专辑兜底（**黑名单制**，不是白名单）：实测看似「单曲型」的
 * `opening` / `ending` 条目里同样塞着整张角色歌 CD
 * （《B-PROJECT～絶頂＊エモーション～ キャラクターソングCD 2》、
 * 《TVアニメ「恋する天使アンジェリーク」キャラクターソング VOL.19》），
 * 按白名单把它们排除掉，这些条目就永远零候选 —— 第一版白名单正是这么错的。
 *
 * 「单曲名撞上别人同名专辑」的风险由两道闸门压住：① 只在常规检索**完全无候选**时
 * 才走这条路；② 专辑名必须与条目名对得上（`isAlbumNameMatch`，全等或互相包含）。
 */
export const NON_MUSIC_TRACK_KINDS: ReadonlySet<BangumiMusicTrackKind> =
  new Set<BangumiMusicTrackKind>(["drama", "radio", "reading"]);

export const isAlbumLikeTrackKind = (kind: BangumiMusicTrackKind): boolean =>
  !NON_MUSIC_TRACK_KINDS.has(kind);

/** 专辑检索取回的候选专辑数。 */
export const ALBUM_SEARCH_LIMIT = 10;

/**
 * 专辑名里的通用词：不承载「这是哪部作品」的信息，不能作为匹配依据。
 * 判重时必须先剔除，否则同系列的两张专辑（《X 角色歌集》与《Y 角色歌集》）会因为
 * 共享「角色歌集」而被判成同一张。
 */
export const ALBUM_GENERIC_TOKENS: ReadonlySet<string> = new Set([
  "tv",
  "tvアニメ",
  "アニメ",
  "アニメーション",
  "剧场版",
  "劇場版",
  "映画",
  "ova",
  "oad",
  "character",
  "キャラクター",
  "キャラクターソング",
  "キャラソン",
  "角色歌",
  "角色曲",
  "soundtrack",
  "サウンドトラック",
  "オリジナルサウンドトラック",
  "ost",
  "原声",
  "原声带",
  "原声集",
  "album",
  "アルバム",
  "mini",
  "ミニアルバム",
  "collection",
  "コレクション",
  "best",
  "ベスト",
  "song",
  "songs",
  "ソング",
  "ソングス",
  "music",
  "ミュージック",
  "vocal",
  "ボーカル",
  "theme",
  "テーマ",
  "主题歌",
  "主題歌",
  "opening",
  "ending",
  "オープニング",
  "エンディング",
  "vol",
  "シリーズ",
  "series",
  "disc",
  "cd",
  "特典",
  "初回",
  "限定",
  "盤",
  "编",
  "篇",
]);

/** 把名称拆成有区分度的词元（归一化 → 按分隔符切分 → 去通用词、纯数字与单字）。 */
export const albumNameTokens = (value: string): string[] =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .split(/[\s/／・,，、＆&+＋\-–—_:：'"'"'"'"「」『』【】()（）[\]]+/u)
    .map((token) => token.trim())
    .filter(
      (token) => token.length >= 2 && !/^\d+$/u.test(token) && !ALBUM_GENERIC_TOKENS.has(token)
    );

/** 名称里的数字词元（归一化去掉前导零）：专辑系列号靠它区分。 */
export const nameDigits = (value: string): Set<string> =>
  new Set((value.normalize("NFKC").match(/\d+/gu) ?? []).map((digits) => String(Number(digits))));

/**
 * 专辑名与条目名的相似度分（0 表示不是同一张专辑）。
 *
 * 为什么不能只用「全等 / 包含」：网易云的专辑名与 Bangumi 条目名经常对不齐 ——
 * 条目《TVアニメ『ひみつのアイプリ』キャラクターソングミニアルバム VERSE IN SONG 03》
 * 在网易云叫《TVアニメ『ひみつのアイプリ リング編』VERSEIN SONG 03》（少了
 * 「キャラクターソングミニアルバム」、多了「リング編」、「VERSEIN」还没空格）。
 * 只用全等/包含会把这类**真的同一张专辑**全部判死，条目永远零候选。
 *
 * 分档：
 * - 100：归一化后全等（最稳）；
 * - 60：互相包含且短名 ≥ 4 字符（原有的宽松档）；
 * - 10+：专辑名含**番剧名**（任一形态）**且**与条目名共享一个 ≥ 4 字符的特征词元
 *   ——「作品名 + 特征词」双命中才认，单靠共享「角色歌集」这类通用词不算（已剔除）；
 *   同系列专辑只差一个序号，因此**数字词元命中额外 +20**，避免抽到隔壁那张
 *   （VERSE IN SONG **02** 与 **03** 的差别全在序号上）。
 *
 * 例外（直接 0）：专辑名恰好等于番剧名且没有发行上下文、歌手也对不上 —— 见函数内注释，
 * 这种形态下「互相包含」是结构性必然，证据强度为零。
 */
/** 专辑名与条目名归一化后**全等**的得分档：搜到的就是同名那张盘，证据最稳。 */
export const ALBUM_NAME_EXACT_SCORE = 100;

export const albumNameScore = (
  albumName: string,
  trackTitle: string,
  animeNames: readonly string[] = [],
  /**
   * 专辑歌手与 Bangumi 条目歌手是否有交集。用来给「专辑名恰好等于番剧名」这个
   * 高危形态留一条例外：官方同名盘（歌手与条目记录对得上）仍认，陌生歌手的
   * 同名自建盘不认。
   */
  albumArtistMatches = false
): number => {
  const normalizedAlbum = normalizeSongTitle(albumName);
  const normalizedTitle = normalizeSongTitle(trackTitle);
  if (!normalizedAlbum || !normalizedTitle) return 0;
  if (normalizedAlbum === normalizedTitle) return ALBUM_NAME_EXACT_SCORE;
  // 泛用名撞车：专辑名恰好等于**番剧名**（且完全没有发行上下文）时，条目名只会是
  // 「番剧名 + 前后缀」，与它的「互相包含 / 共享特征词元」几乎是必然 —— 这条证据是
  // 循环的，不能算。实测事故：网易云用户自建的《青春ブタ野郎はバニーガール先輩の
  // 夢を見ない》（梁神，一首同名说唱）在专辑检索里拿到 60 分，压过官方
  // 《… 4 Special CD》（35 分），被当成特典 CD 的曲目出题。
  const bareWorkName = animeNames.some((name) => {
    const normalizedName = normalizeSongTitle(name);
    return Boolean(normalizedName) && normalizedName === normalizedAlbum;
  });
  if (bareWorkName && !albumArtistMatches && !ANIME_RELEASE_CONTEXT_PATTERN.test(albumName))
    return 0;
  const shorter =
    normalizedAlbum.length <= normalizedTitle.length ? normalizedAlbum : normalizedTitle;
  const longer = shorter === normalizedAlbum ? normalizedTitle : normalizedAlbum;
  if (shorter.length >= 4 && longer.includes(shorter)) return 60;

  const albumTokens = new Set(albumNameTokens(albumName));
  const shared = albumNameTokens(trackTitle).filter((token) => albumTokens.has(token));
  if (!shared.some((token) => token.length >= 4)) return 0;
  const hasAnimeName = animeNames.filter(Boolean).some((name) => {
    const normalizedName = normalizeSongTitle(name);
    return Boolean(normalizedName) && normalizedAlbum.includes(normalizedName);
  });
  if (!hasAnimeName) return 0;

  const albumDigits = nameDigits(albumName);
  const digitHit = [...nameDigits(trackTitle)].some((digits) => albumDigits.has(digits)) ? 20 : 0;
  return 10 + shared.length * 5 + digitHit;
};

/**
 * 专辑名与条目名是否指向同一张专辑（`albumNameScore` 的布尔形态）。
 * 判定细节见 `albumNameScore`，保留这个包装是为了让调用点读起来仍是「是否匹配」。
 */
export const isAlbumNameMatch = (
  albumName: string,
  trackTitle: string,
  animeNames: readonly string[] = []
): boolean => albumNameScore(albumName, trackTitle, animeNames) > 0;

/**
 * 歌手名作为检索词的长度上限。
 *
 * Bangumi 的 `artist` 常是整串声优列表（角色歌专辑条目动辄列七八个人名），
 * 拼进检索词后网易云什么都搜不到 —— 超过这个长度就只用番剧名去搜。
 * （补录 artist 之后才暴露：旧库全为 NULL，等于一直在走番剧名那条路。）
 */
export const MAX_ARTIST_QUERY_LENGTH = 32;

/**
 * 专辑型条目的类型关键词：用于拼「番剧名 + 角色曲」这类检索词。
 */
export const ALBUM_KIND_KEYWORDS: readonly string[] = [
  "キャラクターソング",
  "キャラソン",
  "オリジナルサウンドトラック",
  "サウンドトラック",
  "オープニングテーマ",
  "エンディングテーマ",
  "主題歌",
  "テーマソング",
  "ボーカルアルバム",
  "イメージアルバム",
  "ミュージックコレクション",
  "ソングコレクション",
  "ドラマ",
  "ベスト",
];

/** 去掉「TVアニメ『番剧名』」「アニメ「番剧名」」这类包裹，只留专辑自身的名字。 */
export const stripAnimeWrapper = (title: string, animeNames: readonly string[]): string => {
  let result = title;
  for (const name of animeNames) {
    if (!name) continue;
    for (const wrapper of [
      `TVアニメ『${name}』`,
      `TVアニメ「${name}」`,
      `アニメ『${name}』`,
      `アニメ「${name}」`,
      `TVアニメ ${name}`,
      `TV动画《${name}》`,
      `动画《${name}》`,
      `『${name}』`,
      `「${name}」`,
    ]) {
      result = result.split(wrapper).join(" ");
    }
  }
  return result
    .replace(/^(?:TVアニメ|TV动画|アニメ|劇場版|映画)\s*/u, "")
    .replace(/\s+/gu, " ")
    .trim();
};

/**
 * 专辑型条目的检索词序列（按优先级）。
 *
 * 只用条目名检索是不够的 —— Bangumi 条目名与网易云的命名差得很远，实测：
 * - 《TVアニメ『ひみつのアイプリ』キャラクターソングミニアルバム VERSE IN SONG 03》
 *   按条目名搜专辑返回 **0 张**，换成番剧名「ひみつのアイプリ」立刻搜到同系列专辑；
 * - 《「クラスターエッジ」キャラクターコレクション》连番剧的日文片假名都搜不到，
 *   而番剧的**原名** `CLUSTER EDGE` 能搜出该番的《ココロのつぼみ》《FLY HIGH》。
 *
 * 因此按「条目名 → 剥掉番剧名包裹后的余部 → 番剧名 + 类型关键词 → 番剧名」逐级放宽。
 */
export const buildAlbumQueries = (
  track: BangumiMusicTrack,
  anime: BangumiSubjectDetails
): string[] => {
  const animeNames = [anime.name, anime.nameCn].filter((name): name is string => Boolean(name));
  const queries: string[] = [];
  const push = (value: string) => {
    const trimmed = value.trim();
    if (trimmed && !queries.includes(trimmed)) queries.push(trimmed);
  };
  push(track.title);
  push(stripAnimeWrapper(track.title, animeNames));
  const kindKeyword = ALBUM_KIND_KEYWORDS.find((keyword) => track.title.includes(keyword));
  if (kindKeyword) {
    for (const name of animeNames) push(`${name} ${kindKeyword}`);
  }
  for (const name of animeNames) push(name);
  return queries;
};

/**
 * 上游偶发失败时重试一次。
 *
 * **只重试瞬态失败**：限流（`MUSIC_API_RATE_LIMITED`）与队列拥塞（`MUSIC_API_BUSY`）下
 * 立即重试只会再撞一次冷却，直接放弃让上层换下一首。
 * 实测小众番剧抽样里 25 条无候选中有 8 条是专辑检索抛错造成的，重试能把大部分救回来。
 */
export const ALBUM_RETRY_DELAY_MS = 1_200;
export const retryOnce = async <T>(task: () => Promise<T>): Promise<T> => {
  try {
    return await task();
  } catch (error) {
    const code = error instanceof AppError ? error.code : "";
    if (code === "MUSIC_API_RATE_LIMITED" || code === "MUSIC_API_BUSY") throw error;
    await new Promise((resolve) => setTimeout(resolve, ALBUM_RETRY_DELAY_MS));
    return task();
  }
};

/**
 * 专辑路径取回的曲目里要直接剔除的非歌形态：伴奏 / 纯音乐 / 现场 / 翻唱 / 台词。
 * 专辑（尤其 OST 与角色歌合辑）通常把 off vocal 版一并收录，它们不是可出的原曲。
 */
export const isUnplayableAlbumTrack = (title: string): boolean =>
  NON_ORIGINAL_VERSION_PATTERN.test(title) ||
  COVER_MARKER_PATTERN.test(title) ||
  INSTRUMENTAL_ARRANGEMENT_PATTERN.test(title) ||
  DRAMA_TRACK_PATTERN.test(title) ||
  RADIO_TALK_TRACK_PATTERN.test(title);

/**
 * 专辑里的二次创作分轨标记：Remix / TV Size / Game Size / Short 版。
 * 与 isUnplayableAlbumTrack 的区别：这些分轨仍是**可出的歌**（原版不在这张盘时
 * 降级可出），但**原版存在时不得随机抢先** —— 专辑路径取回的曲目原本是纯
 * shuffle，实测《TVアニメ 『Summer Pockets』 "leave a mark"》6 轨里 3 轨是
 * Remix，一半概率直接出 Remix 而不是原版。
 */
