import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  NeteaseMusicProvider,
  isBopomofoOnlyLyricLine,
  isBracketedStageDirectionLine,
  isCreditKeywordLine,
  isCreditLyricLine,
  isDuetRoleLine,
  isInstrumentalLyricLine,
  isNumericOnlyLyricLine,
  isPlaceholderMaskLyricLine,
  isSymbolOnlyLyricLine,
  isTooShortLyricLine,
  isUnusableLyricLine,
  parseChinaIpRanges,
  parseLrc,
  parseTTML,
  parseYrc,
  mergeTranslations,
  musicIpScope,
  randomChineseIp,
  readChinaIpRanges,
  sanitizeLyrics,
} from "../src/infrastructure/NeteaseMusicProvider";

// 普通 provider 回归禁止真实 AMLL 回源，专项通过 amllFetcher 注入。
const originalFetch = globalThis.fetch;
beforeEach(() => { globalThis.fetch = (async () => { throw new Error("测试禁止网络请求"); }) as unknown as typeof fetch; });
afterEach(() => { globalThis.fetch = originalFetch; });

describe("NeteaseMusicProvider", () => {
  test("filters instrumental placeholders without removing ordinary lyrics", () => {
    expect(isInstrumentalLyricLine("Music")).toBe(true);
    expect(isInstrumentalLyricLine("[Music]")).toBe(true);
    expect(isInstrumentalLyricLine("Music - Instrumental")).toBe(true);
    expect(isInstrumentalLyricLine("instrumental2")).toBe(true);
    expect(isInstrumentalLyricLine("we still hear music tonight")).toBe(false);

    const lyrics = parseLrc([
      "[00:01.00]Music",
      "[00:02.00][Music]",
      "[00:03.00]Music - Instrumental",
      "[00:04.00]verse one",
      "[00:05.00]verse two",
    ].join("\n"));
    expect(sanitizeLyrics(lyrics, { title: "answer", artist: "artist" })).toEqual([
      { time: 4_000, endTime: 5_000, text: "verse one" },
      { time: 5_000, endTime: 10_000, text: "verse two" },
    ]);
  });

  test("读取歌单、歌手歌曲与热度字段", async () => {
    const provider = new NeteaseMusicProvider({
      loadApi: async () => ({
        playlist_track_all: async () => ({
          body: {
            playlist: { id: 42, name: "自动题库", trackCount: 2 },
            songs: [
              { id: 1, name: "高热度", ar: [{ id: 7, name: "歌手甲" }], al: { name: "专辑" }, pop: 100_000 },
              { id: 2, name: "普通", ar: [{ id: 7, name: "歌手甲" }], al: { name: "专辑" }, pop: 999 },
            ],
          },
        }),
        cloudsearch: async ({ type }: { type: number }) => ({
          body: { result: type === 100 ? { artists: [{ id: 7, name: "歌手甲" }] } : { songs: [] } },
        }),
        artist_songs: async () => ({
          body: { songs: [{ id: 1, name: "高热度", ar: [{ id: 7, name: "歌手甲" }], al: { name: "专辑" }, pop: 100_000 }] },
        }),
        song_red_count: async () => ({ body: { code: 200, data: { count: 123_456, countDesc: "100w+" } } }),
      }),
    });

    await expect(provider.getPlaylistSongs("42")).resolves.toMatchObject({
      info: { id: "42", name: "自动题库", songCount: 2 },
      songs: [{ id: "1" }, { id: "2" }],
    });
    await expect(provider.searchArtists("歌手甲")).resolves.toEqual([{ id: "7", name: "歌手甲" }]);
    await expect(provider.getArtistSongs("7")).resolves.toEqual([
      expect.objectContaining({ id: "1" }),
    ]);
    await expect(provider.getSongPopularity("1")).resolves.toBe(123_456);
  });

  test("解析多时间戳 LRC 并补齐结束时间", () => {
    expect(parseLrc("[00:01.00][00:03.500]第一句\n[00:05.00]第二句")).toEqual([
      { time: 1_000, endTime: 3_500, text: "第一句" },
      { time: 3_500, endTime: 5_000, text: "第一句" },
      { time: 5_000, endTime: 10_000, text: "第二句" },
    ]);
  });

  test("过滤作词作曲编曲与标题信息并重新衔接时间轴", () => {
    const lyrics = parseLrc([
      "[00:01.00]答案歌",
      "[00:02.00]作词人：某某",
      "[00:03.00]第一句歌词",
      "[00:04.00]我们在唱答案歌",
      "[00:05.00]词曲：某某",
      "[00:07.00]第二句歌词",
      "[00:09.00]编曲人：某某",
      "[00:10.00]Production Coordination: Stanley Leung",
      "[00:11.00]Keyboards & Programming: 某某",
      "[00:12.00]Drums: 某某",
      "[00:13.00]Strings Arranged & Conducted by 某某",
      "[00:14.00]Recorded at example studio",
      "[00:15.00]Engineered by 某某",
      "[00:16.00]测试歌手",
    ].join("\n"));

    expect(sanitizeLyrics(lyrics, {
      title: "答案歌",
      artist: "测试歌手",
      album: "测试专辑",
    })).toEqual([
      { time: 3_000, endTime: 4_000, text: "第一句歌词" },
      { time: 4_000, endTime: 7_000, text: "我们在唱答案歌" },
      { time: 7_000, endTime: 12_000, text: "第二句歌词" },
    ]);
  });

  test("多歌手合唱歌曲中的单个人名元数据行会被正确过滤，真实歌词完整保留", () => {
    const lyrics = parseLrc([
      "[00:01.00]周杰伦",
      "[00:02.00]费玉清",
      "[00:04.00]（周杰伦）天青色等烟雨",
      "[00:06.00]我不是洛天依",
      "[00:08.00]炊烟袅袅升起",
    ].join("\n"));

    expect(sanitizeLyrics(lyrics, {
      title: "千里之外",
      artist: "周杰伦 / 费玉清 / 洛天依",
      album: "依然范特西",
    })).toEqual([
      { time: 4_000, endTime: 6_000, text: "（周杰伦）天青色等烟雨" },
      { time: 6_000, endTime: 8_000, text: "我不是洛天依" },
      { time: 8_000, endTime: 13_000, text: "炊烟袅袅升起" },
    ]);
  });

  test("同人圈与翻唱圈署名行会被过滤，包括包裹式与多标签形态", () => {
    const creditLines = [
      "翻策：邹铁牛",
      "美工：问绮灯",
      "题字：白冰堂",
      "后期：是铁牛",
      "翻唱：悼子\\ワカイ调和剂\\夙夜\\浅安",
      "翻唱：悼子＼ワカイ调和剂＼夙夜＼浅安",
      "翻唱：悼子 ワカイ调和剂 夙夜 浅安",
      "【翻唱】某某",
      "（后期）某某",
      "　作词：某某",
      "- 作曲：某某",
      "· 混音：某某",
      "策划/统筹：某某",
      "作词、作曲：某某",
      "监制&混音：某某",
      "曲Composer：某某",
      "词Lyricist：某某",
      "曲绘：某某",
      "调教：某某",
      "PV：某某",
      "海报：某某",
      "Special Thanks：某某",
      "Cast：某某 某某",
      "Mixing: John",
      "Mastering: Jane",
      "Illustration: Bob",
      "Movie: Tom Sam",
    ];
    for (const line of creditLines) {
      expect(isCreditLyricLine(line)).toBe(true);
    }
  });

  test("裸写英文致谢行没有分隔符也不能漏网", () => {
    // 旧用例只覆盖了带冒号的 `Special Thanks：某某`，
    // 裸写形态（无分隔符）因此长期漏网，必须单独锁定。
    expect(isCreditLyricLine("Special Thanks")).toBe(true);
    expect(isCreditLyricLine("special thanks")).toBe(true);
    expect(isCreditLyricLine("Special Thanks To")).toBe(true);
    expect(isCreditLyricLine("Thanks To")).toBe(true);
    expect(isCreditLyricLine("Thanks")).toBe(true);
  });

  test("真实歌曲里的版权声明、对唱角色与注音行会被过滤", () => {
    // 以下均取自真实网易云歌词（匿名 cookie + 解灰实测），
    // 它们既不是「标签：取值」也不是人名串，属于纯词表/结构判定抓不到的类型。
    const noticeLines = [
      "词版权管理方：北京梦织音传媒有限公司",
      "曲版权管理方：索尼音乐版权代理（北京）有限公司",
      "录音作品及MV版权：EAS MUSIC LTD",
      "录音棚：C.L.K",
      "后援：风云娱乐集团",
      "（未经许可,不得翻唱或使用）",
      "未经授权不得翻唱",
      "版权所有",
      "All Rights Reserved",
    ];
    for (const line of noticeLines) {
      expect(isUnusableLyricLine(line)).toBe(true);
    }

    // 对唱角色标注：给出的是演唱分工而非歌词，右侧通常为空。
    for (const line of ["男：", "女：", "合：", "合唱：", "对唱："]) {
      expect(isDuetRoleLine(line)).toBe(true);
      expect(isUnusableLyricLine(line)).toBe(true);
    }

    // 注音符号行（《反方向的钟》开头口白）。
    expect(isBopomofoOnlyLyricLine("ㄅㄆㄇㄈㄉㄊㄋㄌㄍㄎㄏ")).toBe(true);
    expect(isUnusableLyricLine("ㄅㄆㄇㄈㄉㄊㄋㄌ")).toBe(true);

    // 带后缀的纯音乐占位说明。
    expect(isInstrumentalLyricLine("纯音乐，请欣赏")).toBe(true);
    expect(isInstrumentalLyricLine("本曲为纯音乐，请欣赏")).toBe(true);
    expect(isInstrumentalLyricLine("纯音乐 请欣赏")).toBe(true);
  });

  test("版权声明与角色标注的判定不会误杀正常歌词", () => {
    // 这些行含有与声明/角色相关的字词，但本身是正常歌词，必须保留。
    const realLyrics = [
      "关于你们之间的故事",
      "我不再想听你的毒誓",
      "男女之间",
      "后天",
      "后期制作人",
      "人都走了",
      "全是狠活",
      "音阙诗听",
      "男儿当自强",
      "女娲补天",
      "合唱情歌的夜晚",
      "版权归我所有这句话只是歌词",
    ];
    for (const line of realLyrics) {
      expect(isUnusableLyricLine(line)).toBe(false);
    }

    // 注音判定不能把日文假名或韩文一并误伤（它们只在特定场景才是噪声，
    // 这里只要求注音规则本身不越界）。
    expect(isBopomofoOnlyLyricLine("あいうえお")).toBe(false);
    expect(isBopomofoOnlyLyricLine("正常的中文歌词")).toBe(false);
    expect(isBopomofoOnlyLyricLine("ㄅㄆㄇ mixed 歌词")).toBe(false);
  });

  test("角色标注与「角色标记 + 歌词」必须区分开", () => {
    // 实测《千里邀月》踩到的最严重误杀：`【合】有英雄漂泊异乡 故土遥远`
    // 是「合唱角色标记 + 真实歌词」，早期实现把 `合` 当署名标签命中，
    // 导致整段副歌被剔除。必须要求「取值侧无实质内容」才是角色标注。
    for (const line of ["合：", "男：", "女：", "合唱：", "对唱：", "【合】", "（合）", "[女]"]) {
      expect(isDuetRoleLine(line)).toBe(true);
      expect(isUnusableLyricLine(line)).toBe(true);
    }
    // 角色标记 + 歌词正文：必须保留。
    for (const line of [
      "【合】有英雄漂泊异乡 故土遥远",
      "【合】不免嫉妒人间 阴晴圆缺",
      "【男】让我用心把你留下来",
      "【女】你是我天边最美的云彩",
      "【茶】长生殿外自在躲清闲",
    ]) {
      expect(isDuetRoleLine(line)).toBe(false);
      expect(isCreditKeywordLine(line)).toBe(false);
      expect(isUnusableLyricLine(line)).toBe(false);
    }
  });

  test("带限定前缀的复合署名标签与英文取值会被过滤", () => {
    // 实测发现：`音乐制作：BachBeats` 这类「复合中文标签 + 超过 8 字符的英文取值」
    // 既掉出词表路径（标签不在表内），又被结构判定的 `segment.length > 8` 否决，
    // 属于双重漏网。登记复合标签后必须能拦住。
    for (const line of [
      "音乐制作：BachBeats",
      "音乐监制：某某某",
      "音乐指导：bilbili音乐@大家的音乐姬",
      "专辑制作：某某",
      "专辑封面设计：某某",
      "封面设计：某某",
      "视觉设计：某某",
      "制作协力：某某",
      "录音棚：C.L.K",
      "混音室：某某",
      "母带处理：某某",
    ]) {
      expect(isUnusableLyricLine(line)).toBe(true);
    }
    // 反向断言：以复合标签词开头但整体是正常歌词的行不能被误杀。
    for (const line of ["音乐响起：我们的故事", "制作人说的话我都记得"]) {
      expect(isUnusableLyricLine(line)).toBe(false);
    }
  });

  test("占位遮罩行会被过滤，含实词的行不受影响", () => {
    // 网易云上传谱常把未填写段落写成同一字母的重复。
    for (const line of ["XXXXXXXXX", "XXXXX", "xxx", "OOOOOO", "xxxx", "XXXX-XXXX"]) {
      expect(isPlaceholderMaskLyricLine(line)).toBe(true);
      expect(isUnusableLyricLine(line)).toBe(true);
    }
    // 必须保留：含实际文字、或重复不足 3 次、或混入其他字符。
    for (const line of [
      "XXXXXXXXXXXXXXXXXX你好",
      "X你太美",
      "xxxxx我爱你",
      "xx",
      "OK",
      "We will rock you",
    ]) {
      expect(isPlaceholderMaskLyricLine(line)).toBe(false);
      expect(isUnusableLyricLine(line)).toBe(false);
    }
  });

  test("整行括号包裹的舞台指示会被过滤，和声式括号歌词保留", () => {
    for (const line of [
      "(何が綴られていたのか、私たちの文明では到底理解できない)",
      "（何が綴られていたのか、私たちの文明では到底理解できない）",
      "（以下反复）",
      "(Repeat)",
      "(silence)",
      "(Instrumental)",
      "(间奏)",
      "(One, two, three, go)",
    ]) {
      expect(isBracketedStageDirectionLine(line)).toBe(true);
      expect(isUnusableLyricLine(line)).toBe(true);
    }
    // 反向断言：括号在真实歌词里是常态，短和声/衬词括号不能被误杀。
    for (const line of [
      "（啦啦啦）",
      "（我们一起唱歌）",
      "(Oh yeah baby)",
      "（爱してる）",
      "(你是我的眼)",
      "（谁）",
      "（你我之间）",
    ]) {
      expect(isBracketedStageDirectionLine(line)).toBe(false);
      expect(isUnusableLyricLine(line)).toBe(false);
    }
  });

  test("纯符号、纯数字与过短行会被过滤", () => {
    expect(isSymbolOnlyLyricLine("~~~~")).toBe(true);
    expect(isSymbolOnlyLyricLine("...")).toBe(true);
    expect(isSymbolOnlyLyricLine("— — —")).toBe(true);
    expect(isNumericOnlyLyricLine("00:12")).toBe(true);
    expect(isNumericOnlyLyricLine("120 bpm")).toBe(true);
    // 单个拉丁字母/数字不成词，属于无效行
    expect(isTooShortLyricLine("a")).toBe(true);
    // 单个汉字或假名在真实歌词里合法存在，不能被误杀
    expect(isTooShortLyricLine("あ")).toBe(false);
    expect(isTooShortLyricLine("好")).toBe(false);
    // 正常歌词不能被误判
    expect(isSymbolOnlyLyricLine("we still hear music tonight")).toBe(false);
    expect(isNumericOnlyLyricLine("爱你一万年")).toBe(false);
    expect(isTooShortLyricLine("唱歌")).toBe(false);
  });

  test("带冒号的正常歌词不会被当作署名行误杀", () => {
    for (const line of [
      "爱：不可说",
      "夜：很长",
      "我说：走吧",
      "solo：我一个人跳舞",
      "独白：他说他走了",
      "记得：那年夏天",
      "我们都在唱歌",
      "君の名前を呼んでいる",
    ]) {
      expect(isCreditLyricLine(line)).toBe(false);
    }
  });

  test("连排制作名单整块剔除，副歌与重复演唱歌词完整保留", () => {
    const lyrics = parseLrc([
      "[00:01.00]翻策：邹铁牛",
      "[00:02.00]美工：问绮灯",
      "[00:03.00]题字：白冰堂",
      "[00:04.00]后期：是铁牛",
      "[00:05.00]翻唱：悼子\\ワカイ调和剂\\夙夜\\浅安",
      "[00:08.00]第一句真实歌词",
      "[00:10.00]第二句真实歌词",
      "[00:12.00]第一句真实歌词",
      "[00:14.00]珠玉早沉浮在泥沙",
    ].join("\n"));

    expect(sanitizeLyrics(lyrics, { title: "珠玉", artist: "严艺丹" })).toEqual([
      { time: 8_000, endTime: 10_000, text: "第一句真实歌词" },
      { time: 10_000, endTime: 12_000, text: "第二句真实歌词" },
      { time: 12_000, endTime: 14_000, text: "第一句真实歌词" },
      { time: 14_000, endTime: 19_000, text: "珠玉早沉浮在泥沙" },
    ]);
  });

  test("历轮抽样沉淀的署名与噪声家族会被过滤", () => {
    // 以下用例来自对 4298 首收藏歌单的逐轮随机抽样分诊（R2-R6），
    // 每一条都是真实歌词页里出现过、曾长期漏网的无效行，锁定防止回退。
    const dropLines = [
      // R2-R6 抽样分诊沉淀的代表条目（每家族留样，防词表整体失效）。
      // 复合录音/混音标签与人名归属
      "人声录音师：钱雷/杨惠琳@Studio 21A",
      "母带工作室 : Sterling Sound",
      "配唱制作人 : 林俊杰/Dr. Moon",
      "调声 Tuning : OQQ",
      "演唱 Voice：车子玉 Ziyu Che (HOYO-MiX)",
      "版权 Publishing : 上海哔哩哔哩科技有限公司/Vsinger",
      // 英文 `<Role> At/By – <Value>`（en dash 分隔，Discogs 风格）
      "Mixed At – Enterprise Studios",
      "Distributed By – EMI (Taiwan) Ltd.",
      "A&R – 何启弘",
      // 答案泄露（歌名/外语标题头）
      "歌曲原名：夜来香",
      "Bài Hát: See Tình",
      // 弦乐长标签与颜文字噪声
      "弦乐指挥 : Adam Klemens",
      "～∧o∧o@∧o@∧o～∧o∧o-∧o～∧o∧o@∧o@∧o～∧o∧o-∧o",
      // R4：助理/序数声部/乐器录音/括号标注
      "制作助理 : 哈斯瑚必来",
      "2nd Violins : 谢林、郭慧、罗菁、张建辉",
      "Strings Recorded at 广州中国唱片社录音室",
      "Strings Recording Co-ordination by Stanley Leung",
      "（烛光制作）",
      "/ EMI Music Publishing (S.E. Asia) Ltd, Taiwan Branch",
      // R5：独奏/民族乐器拼音/母带后期
      "Guitar Solo : 愤怒的糖",
      "古筝 Guzheng: 陆莎莎 Shasha Lu、赵墨佳 Mojia Zhao",
      "母带后期处理录音室 Mastering Studio：馒头音乐工作室 MT Mastering Studio",
      "西塔尔琴 Sitar：Arjun Verma",
      // R6：统筹/OP 版权行/原曲信息
      "艺人统筹 : 李如嫣/马颖@FLOWSIXTEEN",
      "梁翘柏OP : OP of Kubert Leung Musichic LTD.",
      "——正版授权，改编自《Counting stars》——",
      "（飞机场的10:30 - 陶喆）",
      "作曲Composition : 三宝",
    ];
    for (const line of dropLines) {
      expect(isUnusableLyricLine(line)).toBe(true);
    }
  });

  test("署名过滤的保留边界：角色唱段、人声切片、外语歌词与念白", () => {
    // 与上一条测试同源（R2-R7 抽样分诊），这些行必须保留。
    const keepLines = [
      // 与上一条同源（R2-R7 抽样分诊），每条防线留代表样，这些行必须保留。
      // 人名/角色标记 + 歌词正文
      "洛：记起一段你总哼的调调",
      "女:依稀往梦似曾见",
      "男:射雕引弓塞外奔驰",
      "刘国正：我啪的一板正手直线打你个措手不及",
      "爸爸(说唱)：猎豹猎豹跑得快",
      // 拟声/人声切片
      "Doo-doo-doo, doo-doo-doo",
      "Kick it-kick-kick it",
      "GIO-GIO-GIO-GIO-GIO",
      // 外语歌词
      "Lumea toata ii incantata",
      "さぁ始めようか non-stop music",
      "le monde serait-il plus beau ?",
      // 含署名词的正常歌词（防词表扩容误杀）
      "Music, makes me, high",
      "只有音乐最安全",
      "The producer of my pain",
      "Vocal cords are shaking now",
      "I am the conductor of my soul",
      "Piano in the dark",
      "Drums are beating in my chest",
      "Guitar on my back",
      "harmony of the night",
      "Rhythm of the falling rain",
      "Strings of my heart",
      "Band of brothers",
      "The director of my fate",
      "Publisher of lies",
      "Coordinate with me tonight",
      // en dash 连接的歌词（防 en-dash 署名规则越界）
      "Pennies and dimes – for a kiss",
      // 括号和声与对白
      "兰那罗们 —— 再见动物园合唱团（指挥：孙玥）",
      "Y2K: \"Nah, da da dadadada nananana\"",
      // 念白/天气预报采样（有内容的表演成分）
      "Saturday:Partly cloudy.",
      // 空格分隔拒绝名单：高频歌词开头的标签词裸写时按歌词保留
      "导演 一场好戏",
      "感谢 这一路的陪伴",
    ];
    for (const line of keepLines) {
      expect(isUnusableLyricLine(line)).toBe(false);
    }
    // LRC 多时间戳整行是抽样脚本伪影：生产端 parseLrc 先剥掉全部时间戳，
    // 剩下的 `不管笑与悲` 是真实歌词；裸行判定不得误伤。
    expect(isUnusableLyricLine("[02:30.94][01:16.40]不管笑与悲")).toBe(false);
  });

  test("@ 归属署名会被过滤且不误伤歌词", () => {
    // 「人名@团队」归属写法：@ 两侧紧贴且右侧是团队名形态才判定。
    for (const line of [
      "曾嵘@牛班NEWBAND /叶俊@牛班NEWBAND",
      "朗梓朔@维伴音乐",
      "张人杰Andy@牛班NEWBAND",
    ]) {
      expect(isUnusableLyricLine(line)).toBe(true);
    }
    // 歌词里的 @：有空格、无团队名、或夹在句中；无 @ 的名字行保持原样。
    for (const line of [
      "Sing @ the top of my lungs",
      "me@you",
      "你@我 我@你",
      "洛天依Official",
    ]) {
      expect(isUnusableLyricLine(line)).toBe(false);
    }
  });

  test("官方发行页脚与同人圈混排署名会被过滤", () => {
    // R7 家族：官方发行页脚、裸机构行、双语混排标签的代表条目。
    for (const line of [
      "Mixer : Rob Kinelski",
      "Studio Personnel : John Greenham / Rob Kinelski",
      "Verse 2: G-Eazy",
      "总监制 : Kevin Shin辛志宇@索尼音乐",
      "承制：北京龙生堂文化传媒有限公司",
      "宣发执行：Iris Zhang/佳佳/赵小咪",
      "调色：罗梦舟",
      "原作：《雨宿り》西崎みどり",
      // 裸机构行与裸标签行（credit 块段落标题独占一行）
      "出品",
      "联合出品",
      "太合音乐集团",
      "主题歌音乐专辑工作团队",
      // 同人圈混排标签（中文标签 + 英文后缀 + 斜杠取值）
      "二胡Erhu：马稼骏Jiajun Ma",
      "词作Lyric/青天纤云 纳兰清婧",
      "出品社团Products/中华青云动漫音乐社TsingCloudsCHINA",
      "绘 ：无机盐_okian",
    ]) {
      expect(isUnusableLyricLine(line)).toBe(true);
    }
    // 裸行边界：两标签粘连与歌词保留（后期|制作人 是真实歌词，不得整行剔除）。
    for (const line of ["后期制作人", "曲终人散：我一个人走"]) {
      expect(isUnusableLyricLine(line)).toBe(false);
    }
  });

  test("历轮抽样代表：R8-R17 沉淀的署名与噪声家族会被过滤", () => {
    // 每家族留代表条目，防止词表整体失效；全量清单由抽样脚本维护（.workbuddy/tmp/）。
    for (const line of [
      // R8：连字符（词中不切分 + 作分隔符）、新中文标签、多词乐器录音头
      "Production Co-ordination : Tania Doko",
      "Mixed - Mastered by 张三",
      "版权公司：北京摩登天空文化发展有限公司",
      "贴混：阿凯",
      "粤语填词：梁晓璞",
      "Solo Cello Recorded at Avon Studios,",
      // R9：`和` 连接、机构粘连、归属署名
      "填词和编曲：梁翘柏",
      "Kevin刘瀚文@Soundhub Studios",
      "升赫录音棚Soundhub Studio",
      // R10：序数尾缀、乐器品牌、版权代理、短标签+冒号+短尾边界
      "Violin 1st：郑泽勋",
      "Linn Drum : Mark Ronson",
      "(Admin. by Warner/Chappell Music Korea)/",
      "风铃：响叮当",
      // R11：双语对照、书名号名单、平台名 from
      "Digital Edited by 정은경 @ Ingridstudio",
      "《Plot: 0》动画 staff",
      "From 爱你的网易云音乐",
      // R12：TitleCase 对照、P/C Line、专辑名
      "制谱 Music Copyist：吴泽熙 Jersey Wu (HOYO-MiX)",
      "P - Line: 2016 北京享耳音乐文化有限公司Sure Recordings Culture Co., Ltd",
      "专辑：最好的时代",
      // R13：`原` 前缀、翻唱标注
      "原制作人 : Griffin Oskar/Trevor Dahl",
      "OT : 海阔天空 (Beyond)",
      "OA : 黄家驹",
      // R14：CV 标注、点分标签、厂牌行
      "温迪（CV：菊花花）",
      "词.曲 : 陈辉阳",
      "Warner/Chappell Music, Hong Kong Limite",
      // R15：民族伴唱、序数小提琴、方括号署名、聆听提示
      "苗语伴唱： 亲爱的，心上人啊",
      "第一小提琴 1st Violin:朱玥 Yue Zhu",
      "【古筝：陶特】【古琴/二胡/大提琴：柠檬CC露】【笛箫：O天气晴朗O】【协力︰司鼓君】",
      "温馨提示：请戴上耳机/耳塞，音量调节适中或偏小，享受最佳聆听体验。",
      // R16：乐器设备、错拼、水印、裸 head
      "Yamaha CS-80 Synthesizer : Michael Jackson",
      "Arragement : 朴树",
      "Maximal R&B - The Freshest & Hottest R&B/ Hip-Hop Music!",
      "CS: GO国服运营团队出品",
      "音乐：天使盐",
      // R17：出品前缀、宣推团队
      "Present By(出品)：Planet Culture 张杰行星文化音乐厂牌",
      "宣推团队 : 快手音乐「π」计划",
    ]) {
      expect(isUnusableLyricLine(line)).toBe(true);
    }
  });

  test("历轮抽样代表：R8-R17 的保留边界", () => {
    for (const line of [
      // 连字符不切分：拼写歌词、带连字符人名、拼写数词
      "L-O-V-E",
      "G-Eazy",
      "Top-10 hits",
      "First love",
      // `和` 两侧非标签、棚/唱片高频词歌词
      "我和你",
      "早餐和午餐：我吃了面包",
      "在录音棚唱歌的夜晚",
      // 动作词裸词不进词表
      "Mix it up tonight",
      "Produce the beats",
      // 结构判定放行：书名号、from、line、and 的歌词形态
      "《风之谷》里的少女",
      "From dusk till dawn we run",
      "C line up against the wall",
      "you and me together",
      // DENY 词的空格形态
      "感谢 Happy Birthday to you",
      "音乐 我的生命",
      "设计 A Story",
      // `原` 剥出非标签、短标签短尾的歌词形态
      "原来如此没有人懂",
      "风铃响了 叮当叮当",
      // 厂牌词 + 无公司后缀、点分非标签、角色缩写 + 歌词
      "Eminem is my favourite rapper",
      "Rit. 渐慢",
      "谁.在.听.这.首.歌",
      "李:别离夜",
      "大合唱：啦啦啦啦...",
      // 段落标记 / 括号角色 / 括号实名和声 + 歌词
      "【副歌】让我唱你的歌",
      "A（向晚）：有你的陪伴 从不觉孤单",
      "我用尽一生一世来将你供养（周深：将你供养）",
      // 新词表英文短语、域名、半角加号、艺人-歌名标注
      "All of me",
      "Lead me on",
      "House of cards",
      "Digital Love",
      "repeat after me",
      "I gotta go to Ancestry.com",
      "爱＋你",
      "DMX - X Gon' Give It to Ya",
      "present in my heart",
      "宣传 我们的比赛",
      // 对唱角色标注 + 歌词
      "男：难解百般愁 相知爱意浓",
      "素人合：一首唱不完的歌",
      "王艺陶：爱着你（李秉成：爱着你）",
    ]) {
      expect(isUnusableLyricLine(line)).toBe(false);
    }
  });

  test("猜测歌曲只读取元数据，无歌词歌曲也可以用于猜测", async () => {
    const calls: string[] = [];
    const provider = new NeteaseMusicProvider({
      loadApi: async () => ({
        song_detail: async () => {
          calls.push("song_detail");
          return {
            body: {
              songs: [{
                id: 77,
                name: "纯音乐",
                ar: [{ name: "演奏者" }],
                al: { name: "器乐专辑", publishTime: Date.UTC(2024, 0, 1) },
                pop: 66,
                dt: 120_000,
              }],
            },
          };
        },
        lyric_new: async () => {
          calls.push("lyric_new");
          throw new Error("不应请求歌词");
        },
        song_url_v1: async () => {
          calls.push("song_url_v1");
          throw new Error("不应请求音频");
        },
      }),
    });

    await expect(provider.getSongMetadata("77")).resolves.toMatchObject({
      id: "77",
      title: "纯音乐",
      audioUrl: "",
      lyrics: [],
      releaseYear: 2024,
    });
    expect(calls).toEqual(["song_detail"]);
  });

  test("出题歌曲没有歌词时仍返回播放资源", async () => {
    const provider = new NeteaseMusicProvider({
      loadApi: async () => ({
        song_detail: async () => ({
          body: {
            songs: [{
              id: 78,
              name: "纯音乐题",
              ar: [{ name: "演奏者" }],
              al: { name: "器乐专辑" },
              dt: 120_000,
            }],
          },
        }),
        lyric_new: async () => ({ body: { lrc: { lyric: "" } } }),
        song_url: async () => ({ body: { data: [{ url: "https://audio/78.mp3" }] } }),
      }),
    });

    await expect(provider.getSong("78")).resolves.toMatchObject({
      audioUrl: "https://audio/78.mp3",
      lyrics: [],
    });
  });

  test("扫码登录只把最终 Cookie 返回给调用者并可读取账号状态", async () => {
    const calls: string[] = [];
    const provider = new NeteaseMusicProvider({
      randomCNIP: false,
      loadApi: async () => ({
        login_qr_key: async (params: Record<string, unknown>) => {
          calls.push("login_qr_key");
          expect(params.cookie).toEqual({
            os: "pc",
            appver: "3.1.29.205117",
            osver: "Microsoft-Windows-10-Professional-build-19045-64bit",
            channel: "netease",
            mobilename: "BakaGame",
            model: "BakaGame",
          });
          expect(String(params.ua)).toContain("NeteaseMusicDesktop");
          return { body: { data: { code: 200, unikey: "qr-key" } } };
        },
        login_qr_create: async (params: Record<string, unknown>) => {
          calls.push("login_qr_create");
          expect(params).toMatchObject({
            key: "qr-key",
            qrimg: true,
            platform: "BakaGame",
            randomCNIP: false,
            cookie: {
              os: "pc",
              appver: "3.1.29.205117",
              osver: "Microsoft-Windows-10-Professional-build-19045-64bit",
              channel: "netease",
              mobilename: "BakaGame",
              model: "BakaGame",
            },
          });
          expect(String(params.ua)).toContain("NeteaseMusicDesktop");
          return {
            body: {
              code: 200,
              data: { qrurl: "https://music.163.com/login?codekey=qr-key", qrimg: "data:image/png;base64,qr" },
            },
          };
        },
        login_qr_check: async (params: Record<string, unknown>) => {
          calls.push("login_qr_check");
          expect(params.cookie).toEqual({
            os: "pc",
            appver: "3.1.29.205117",
            osver: "Microsoft-Windows-10-Professional-build-19045-64bit",
            channel: "netease",
            mobilename: "BakaGame",
            model: "BakaGame",
          });
          expect(String(params.ua)).toContain("NeteaseMusicDesktop");
          return { body: { code: 803, message: "授权登录成功", cookie: "MUSIC_U=qr-cookie" } };
        },
        deviceinfo_center_upload: async (params: Record<string, unknown>) => {
          calls.push("deviceinfo_center_upload");
          expect(params.deviceName).toBe("BakaGame");
          expect(String(params.cookie)).toContain("MUSIC_U=qr-cookie");
          expect(String(params.cookie)).toContain("os=pc");
          return { body: { code: 200, data: {} } };
        },
        login_status: async (params: Record<string, unknown>) => {
          calls.push("login_status");
          expect(params.cookie).toBe("MUSIC_U=qr-cookie");
          // 该用例显式关闭 randomCNIP，此时不应携带 realIP；开启时的行为由会话 IP 用例覆盖。
          expect(params.randomCNIP).toBe(false);
          return {
            body: {
              data: {
                code: 200,
                profile: { userId: 42, nickname: "扫码用户", avatarUrl: "https://img/avatar.jpg" },
              },
            },
          };
        },
      }),
    });

    await expect(provider.createQrLogin()).resolves.toMatchObject({
      key: "qr-key",
      qrImage: "data:image/png;base64,qr",
    });
    await expect(provider.checkQrLogin("qr-key")).resolves.toMatchObject({
      status: "authorized",
      message: "授权登录成功",
      session: {
        cookie: "MUSIC_U=qr-cookie",
        account: {
          userId: "42",
          nickname: "扫码用户",
          avatarUrl: "https://img/avatar.jpg",
        },
      },
    });
    expect(calls).toEqual([
      "login_qr_key",
      "login_qr_create",
      "login_qr_check",
      "deviceinfo_center_upload",
      "login_status",
    ]);
  });

  test("扫码登录全链路共用同一 CN 出口 IP 且登录后凭证继续复用", async () => {
    const requests: Array<{ endpoint: string; cookie: unknown; realIP: unknown }> = [];
    const record = (endpoint: string, params: Record<string, unknown>) => {
      requests.push({ endpoint, cookie: params.cookie, realIP: params.realIP });
    };
    const provider = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      loadApi: async () => ({
        login_qr_key: async (params: Record<string, unknown>) => {
          record("login_qr_key", params);
          return { body: { data: { code: 200, unikey: "session-key" } } };
        },
        login_qr_create: async (params: Record<string, unknown>) => {
          record("login_qr_create", params);
          return {
            body: {
              code: 200,
              data: { qrurl: "https://music.163.com/login?codekey=session-key", qrimg: "data:image/png;base64,qr" },
            },
          };
        },
        login_qr_check: async (params: Record<string, unknown>) => {
          record("login_qr_check", params);
          return { body: { code: 803, message: "授权登录成功", cookie: "MUSIC_U=session-cookie" } };
        },
        deviceinfo_center_upload: async (params: Record<string, unknown>) => {
          record("deviceinfo_center_upload", params);
          return { body: { code: 200, data: {} } };
        },
        login_status: async (params: Record<string, unknown>) => {
          record("login_status", params);
          return {
            body: { data: { code: 200, profile: { userId: 42, nickname: "会话用户" } } },
          };
        },
        cloudsearch: async (params: Record<string, unknown>) => {
          record("cloudsearch", params);
          return { body: { result: { songs: [] } } };
        },
      }),
    });

    await provider.createQrLogin();
    await provider.checkQrLogin("session-key");
    // 登录后使用同一凭证的普通请求
    await provider.search("登录后请求", 20, "MUSIC_U=session-cookie");

    const loginChain = requests.filter((entry) => entry.endpoint !== "cloudsearch");
    const ips = new Set(loginChain.map((entry) => String(entry.realIP)));
    // 二维码创建、轮询、设备上报、状态校验必须共用同一个出口 IP：
    // 历史实现里 login_status 显式关闭 realIP，导致登录态一建立就与登录 IP 脱钩而失效。
    expect(ips.size).toBe(1);
    expect(loginChain.every((entry) => entry.realIP !== undefined)).toBe(true);

    const postLogin = requests.find((entry) => entry.endpoint === "cloudsearch");
    expect(String(postLogin?.realIP)).toBe([...ips][0]);
  });

  test("不同登录凭证使用互不相同的稳定 IP", async () => {
    const byCookie = new Map<string, string[]>();
    const provider = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      loadApi: async () => ({
        cloudsearch: async (params: Record<string, unknown>) => {
          const cookie = String(params.cookie);
          const bucket = byCookie.get(cookie) ?? [];
          bucket.push(String(params.realIP));
          byCookie.set(cookie, bucket);
          return { body: { result: { songs: [] } } };
        },
      }),
    });

    await provider.search("甲一", 20, "MUSIC_U=alpha");
    await provider.search("甲二", 20, "MUSIC_U=alpha");
    await provider.search("乙一", 20, "MUSIC_U=beta");

    const alpha = byCookie.get("MUSIC_U=alpha") ?? [];
    const beta = byCookie.get("MUSIC_U=beta") ?? [];
    expect(alpha).toHaveLength(2);
    expect(alpha[0]).toBe(alpha[1]);
    expect(beta).toHaveLength(1);
    expect(alpha[0]).not.toBe(beta[0]);
  });

  test("支持自定义登录设备名称并在扫码登录成功时自动上报", async () => {
    let uploadedDeviceName: string | undefined;
    let capturedCreate: Record<string, unknown> | undefined;
    const provider = new NeteaseMusicProvider({
      deviceName: "CustomMusicBox",
      loadApi: async () => ({
        login_qr_key: async (params: Record<string, unknown>) => {
          expect(params.cookie).toEqual({
            os: "pc",
            appver: "3.1.29.205117",
            osver: "Microsoft-Windows-10-Professional-build-19045-64bit",
            channel: "netease",
            mobilename: "CustomMusicBox",
            model: "CustomMusicBox",
          });
          return { body: { data: { code: 200, unikey: "custom-key" } } };
        },
        login_qr_create: async (params: Record<string, unknown>) => {
          capturedCreate = params;
          return {
            body: {
              code: 200,
              data: { qrurl: "https://music.163.com/login?codekey=custom-key", qrimg: "data:image/png;base64,custom" },
            },
          };
        },
        login_qr_check: async () => ({
          body: { code: 803, message: "授权成功", cookie: "MUSIC_U=custom-cookie" },
        }),
        deviceinfo_center_upload: async (params: Record<string, unknown>) => {
          uploadedDeviceName = String(params.deviceName);
          return { body: { code: 200, data: {} } };
        },
        login_status: async () => ({
          body: {
            data: {
              code: 200,
              profile: { userId: 99, nickname: "自定义设备用户" },
            },
          },
        }),
      }),
    });

    await provider.createQrLogin();
    expect(capturedCreate?.platform).toBe("CustomMusicBox");
    expect(capturedCreate?.cookie).toEqual({
      os: "pc",
      appver: "3.1.29.205117",
      osver: "Microsoft-Windows-10-Professional-build-19045-64bit",
      channel: "netease",
      mobilename: "CustomMusicBox",
      model: "CustomMusicBox",
    });

    await provider.checkQrLogin("custom-key");
    expect(uploadedDeviceName).toBe("CustomMusicBox");
  });

  test("uploadDeviceInfo 在接口异常时记录告警且不中断流程", async () => {
    const provider = new NeteaseMusicProvider({
      loadApi: async () => ({
        deviceinfo_center_upload: async () => {
          throw new Error("网络超时或被风控");
        },
      }),
    });

    const success = await provider.uploadDeviceInfo("MUSIC_U=fake-cookie");
    expect(success).toBe(false);

    // 空 Cookie 场景直接返回 false
    await expect(provider.uploadDeviceInfo("   ")).resolves.toBe(false);
  });

  test("扫码接口被网易云风控拦截时不向客户端暴露提醒链接", async () => {
    const provider = new NeteaseMusicProvider({
      loadApi: async () => ({
        login_qr_key: async () => ({
          body: {
            code: 8810,
            message: "您当前的网络环境存在安全风险",
            redirectUrl: "https://y.music.163.com/g/yida/private-risk-url",
          },
        }),
      }),
    });

    const error = await provider.createQrLogin().catch(
      (value) => value as Error & { code?: string; details?: unknown },
    ) as Error & { code?: string; details?: unknown };
    expect(error).toMatchObject({ code: "MUSIC_LOGIN_RISK" });
    expect(error.message).not.toContain("private-risk-url");
    expect(JSON.stringify(error)).not.toContain("private-risk-url");
  });

  test("匿名令牌只用于后端请求参数，不会作为登录结果返回", async () => {
    const observed: Record<string, unknown>[] = [];
    let registerParams: Record<string, unknown> | undefined;
    const provider = new NeteaseMusicProvider({
      loadApi: async () => ({
        register_anonimous: async (params: Record<string, unknown>) => {
          registerParams = params;
          return { cookie: ["MUSIC_A=anonymous-only"] };
        },
        cloudsearch: async (params: Record<string, unknown>) => {
          observed.push(params);
          return { body: { result: { songs: [] } } };
        },
      }),
    });

    await expect(provider.search("test")).resolves.toEqual([]);
    expect(registerParams?.cookie).toEqual({});
    expect(observed[0]?.cookie).toBe("MUSIC_A=anonymous-only");
  });

  test("通过增强 API 包聚合搜索、歌曲、歌词、播放地址与百科", async () => {
    const calls: string[] = [];
    const provider = new NeteaseMusicProvider({
      loadApi: async () => ({
        cloudsearch: async (params: Record<string, unknown>) => {
          expect(params.cookie).toBe("MUSIC_U=test");
          expect(params.randomCNIP).toBe(true);
          calls.push("cloudsearch");
          return {
            body: {
              result: {
                songs: [
                  {
                    id: 42,
                    name: "答案歌",
                    ar: [{ name: "歌手甲" }],
                    al: { name: "专辑甲", picUrl: "https://img/42.jpg" },
                    dt: 180_000,
                  },
                ],
              },
            },
          };
        },
        song_detail: async () => {
          calls.push("song_detail");
          return {
            body: {
              songs: [
                {
                  id: 42,
                  name: "答案歌",
                  ar: [{ name: "歌手甲" }],
                  al: {
                    name: "专辑甲",
                    picUrl: "https://img/42.jpg",
                    publishTime: Date.UTC(2020, 0, 1),
                  },
                  pop: 88,
                  dt: 180_000,
                },
              ],
            },
          };
        },
        song_url_v1: async () => {
          calls.push("song_url_v1");
          return { body: { data: [{ url: "https://audio/42.mp3" }] } };
        },
        lyric_new: async () => {
          calls.push("lyric_new");
          return { body: { lrc: { lyric: "[00:01.00]一\n[00:04.00]二" } } };
        },
        song_wiki_summary: async () => {
          calls.push("song_wiki_summary");
          return {
            body: {
              data: {
                blocks: [
                  { title: "语种", content: "国语" },
                  { title: "曲风", content: "流行、摇滚" },
                  { title: "歌曲简介", content: "测试百科" },
                ],
              },
            },
          };
        },
      }),
    });

    const search = await provider.search("答案", 20, "MUSIC_U=test");
    expect(search[0]).toMatchObject({ id: "42", title: "答案歌", artist: "歌手甲" });

    const song = await provider.getSong("42");
    expect(song).toMatchObject({
      id: "42",
      audioUrl: "https://audio/42.mp3",
      releaseYear: 2020,
      popularity: 88,
      language: "国语",
      encyclopedia: { summary: "测试百科", tags: ["流行", "摇滚"] },
    });
    expect(song.lyrics).toHaveLength(2);
    expect(calls).toContain("cloudsearch");
    expect(calls).toContain("song_wiki_summary");
  });

  test("播放地址避开缺少 xeapi 公钥的 v1 端点并在端点全部失败时返回业务错误", async () => {
    const calls: string[] = [];
    const baseApi = {
      song_detail: async () => ({
        body: {
          songs: [{ id: 42, name: "答案歌", ar: [{ name: "歌手甲" }], al: { name: "专辑甲" } }],
        },
      }),
      lyric_new: async () => ({
        body: { lrc: { lyric: "[00:01.00]第一句\n[00:04.00]第二句" } },
      }),
    };
    const provider = new NeteaseMusicProvider({
      loadApi: async () => ({
        ...baseApi,
        song_url: async () => {
          calls.push("song_url");
          return { body: { data: [{ url: "http://audio/42.mp3" }] } };
        },
        song_url_v1: async () => {
          calls.push("song_url_v1");
          throw new Error("xeapi public key is missing");
        },
      }),
    });

    await expect(provider.getSong("42")).resolves.toMatchObject({
      audioUrl: "https://audio/42.mp3",
    });
    expect(calls).toEqual(["song_url"]);

    const unavailableProvider = new NeteaseMusicProvider({
      loadApi: async () => ({
        ...baseApi,
        song_url: async () => {
          throw new Error("legacy endpoint failed");
        },
        song_url_v1: async () => {
          throw new Error("xeapi public key is missing");
        },
      }),
    });
    await expect(unavailableProvider.getSong("42")).rejects.toMatchObject({
      code: "MUSIC_API_FAILED",
    });
  });

  test("登录状态会读取会员信息，并区分会员与非会员", async () => {
    const createProvider = (vipCode: number, expireTime: number) => new NeteaseMusicProvider({
      randomCNIP: false,
      loadApi: async () => ({
        login_status: async () => ({
          body: {
            data: {
              code: 200,
              profile: { userId: 42, nickname: "会员测试" },
            },
          },
        }),
        vip_info_v2: async (params: Record<string, unknown>) => {
          expect(params).toMatchObject({ uid: "42", cookie: "MUSIC_U=test" });
          return {
            body: {
              code: 200,
              data: { associator: { vipCode, expireTime } },
            },
          };
        },
      }),
    });

    await expect(createProvider(100, Date.now() + 60_000).getLoginStatus("MUSIC_U=test"))
      .resolves.toMatchObject({
        account: { vipStatus: "vip", vipType: 100 },
      });
    await expect(createProvider(0, Date.now() - 60_000).getLoginStatus("MUSIC_U=test"))
      .resolves.toMatchObject({
        account: { vipStatus: "nonVip" },
      });
  });

  test("登录状态接口返回嵌套失效码时不会误判为已登录", async () => {
    const provider = new NeteaseMusicProvider({
      loadApi: async () => ({
        login_status: async () => ({
          body: {
            code: 200,
            data: { code: 301, profile: null, account: null },
          },
        }),
      }),
    });

    await expect(provider.getLoginStatus("MUSIC_U=expired"))
      .rejects.toMatchObject({ code: "MUSIC_SESSION_INVALID" });
  });

  test("搜索缓存会合并并发请求并保持有界", async () => {
    let calls = 0;
    let finishFirstSearch!: () => void;
    const firstSearchBlocker = new Promise<void>((resolve) => {
      finishFirstSearch = resolve;
    });
    const provider = new NeteaseMusicProvider({
      cacheMaxEntries: 1,
      minRequestIntervalMs: 0,
      loadApi: async () => ({
        cloudsearch: async ({ keywords }: { keywords: string }) => {
          calls += 1;
          if (calls === 1) {
            await firstSearchBlocker;
          }
          return {
            body: {
              result: {
                songs: [{ id: calls, name: keywords, ar: [{ name: "测试歌手" }] }],
              },
            },
          };
        },
      }),
    });

    const concurrentPromise = Promise.all([
      provider.search("同一首歌"),
      provider.search("同一首歌"),
      provider.search("同一首歌"),
    ]);
    finishFirstSearch();
    const concurrent = await concurrentPromise;
    expect(calls).toBe(1);
    concurrent[0].push({ id: "local", title: "本地改动", artist: "测试" });
    expect(concurrent[1]).toHaveLength(1);
    await expect(provider.search("同一首歌")).resolves.toHaveLength(1);
    expect(calls).toBe(1);

    await provider.search("另一首歌");
    await provider.search("同一首歌");
    expect(calls).toBe(3);
  });

  test("同一登录态复用稳定的随机中国 IP", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const provider = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      loadApi: async () => ({
        cloudsearch: async (params: Record<string, unknown>) => {
          requests.push(params);
          return { body: { result: { songs: [] } } };
        },
      }),
    });

    await provider.search("歌曲甲", 20, "MUSIC_U=user-a");
    await provider.search("歌曲乙", 20, "MUSIC_U=user-a");
    await provider.search("歌曲丙", 20, "MUSIC_U=user-b");

    const ranges = readChinaIpRanges();
    const inChina = (ip: unknown) => {
      const value = String(ip).split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
      return ranges.some((range) => value >= range.start && value <= range.end);
    };

    expect(requests[0]?.realIP).toBe(requests[1]?.realIP);
    expect(inChina(requests[0]?.realIP)).toBe(true);
    expect(inChina(requests[2]?.realIP)).toBe(true);
    expect(requests[0]?.realIP).not.toBe(requests[2]?.realIP);
    expect(requests.every((params) => params.randomCNIP === true)).toBe(true);
  });

  test("匿名请求按玩家作用域各持一个 IP，同一玩家在作用域内稳定复用", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const provider = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      loadApi: async () => ({
        cloudsearch: async (params: Record<string, unknown>) => {
          requests.push(params);
          return { body: { result: { songs: [] } } };
        },
      }),
    });

    // 历史实现把全部匿名请求压在同一个 "anonymous" scope 上：一个人把配额打平，
    // 全服跟着 405。玩家作用域让每个连接各持一个出口。
    await musicIpScope.run("player:conn-a", async () => {
      await provider.search("甲一");
      await provider.search("甲二");
    });
    await musicIpScope.run("player:conn-b", () => provider.search("乙一"));

    expect(requests[0]?.realIP).toBe(requests[1]?.realIP);
    expect(requests[0]?.realIP).not.toBe(requests[2]?.realIP);
  });

  test("带房主凭证的请求不受玩家作用域影响，仍沿用凭证自己的 IP", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const provider = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      loadApi: async () => ({
        cloudsearch: async (params: Record<string, unknown>) => {
          requests.push(params);
          return { body: { result: { songs: [] } } };
        },
      }),
    });

    // 凭证与出口 IP 绑定：同一份房主 cookie 无论从哪个玩家的作用域发出都必须用同一个 IP，
    // 否则登录态会按异地登录判定失效。
    await musicIpScope.run("player:conn-a", () =>
      provider.search("凭证甲", 20, "MUSIC_U=host-a"),
    );
    await musicIpScope.run("player:conn-b", () =>
      provider.search("凭证乙", 20, "MUSIC_U=host-a"),
    );

    expect(requests[0]?.realIP).toBe(requests[1]?.realIP);
  });

  for (const upstreamCode of [406, 429, 503]) {
    test(`上游返回 ${upstreamCode} 时与 405 同等进入限流退避`, async () => {
      let virtualTime = 1_000;
      let calls = 0;
      const provider = new NeteaseMusicProvider({
        now: () => virtualTime,
        random: { nextFloat: () => 0 },
        minRequestIntervalMs: 0,
        rateLimitCooldownMs: 30,
        maxRateLimitCooldownMs: 30,
        loadApi: async () => ({
          cloudsearch: async () => {
            calls += 1;
            return calls === 1
              ? { body: { code: upstreamCode, message: "操作频繁，请稍候再试" } }
              : { body: { result: { songs: [] } } };
          },
        }),
      });

      // 实测登录二维码接口返回的正是 406；只认 405 会让整条扫码链路既不退避也不提示。
      await expect(provider.search("首次限流")).rejects.toMatchObject({
        code: "MUSIC_API_RATE_LIMITED",
        message: "操作频繁，请稍候再试",
        details: { upstreamCode },
      });
      await expect(provider.search("冷却期内")).rejects.toMatchObject({
        code: "MUSIC_API_RATE_LIMITED",
      });
      expect(calls).toBe(1);

      virtualTime += 50;
      await expect(provider.search("冷却结束")).resolves.toEqual([]);
      expect(calls).toBe(2);
    });
  }

  test("触发限流后刷新该作用域的伪装 IP，退避结束的请求换一个出口", async () => {
    let virtualTime = 1_000;
    let calls = 0;
    const requests: Array<Record<string, unknown>> = [];
    const provider = new NeteaseMusicProvider({
      now: () => virtualTime,
      minRequestIntervalMs: 0,
      rateLimitCooldownMs: 30,
      maxRateLimitCooldownMs: 30,
      loadApi: async () => ({
        cloudsearch: async (params: Record<string, unknown>) => {
          requests.push(params);
          calls += 1;
          return calls === 1
            ? { body: { code: 405, message: "操作频繁，请稍候再试" } }
            : { body: { result: { songs: [] } } };
        },
      }),
    });

    await musicIpScope.run("player:conn-a", async () => {
      await expect(provider.search("触发限流")).rejects.toMatchObject({
        code: "MUSIC_API_RATE_LIMITED",
      });
      virtualTime += 50;
      await expect(provider.search("恢复")).resolves.toEqual([]);
    });

    // 同一个玩家作用域，但限流之后必须换出口：否则退避一结束就撞回同一个已计满的 IP。
    expect(requests[0]?.realIP).toBeDefined();
    expect(requests[0]?.realIP).not.toBe(requests[1]?.realIP);
  });

  test("随机中国 IP 生成必然落在包内 CN 网段且不携带日志副作用", () => {
    const ranges = readChinaIpRanges();
    expect(ranges.length).toBeGreaterThan(4000);
    const inRange = (ip: string) => {
      const value = ip.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
      return ranges.some((range) => value >= range.start && value <= range.end);
    };
    for (let index = 0; index < 2000; index += 1) {
      const ip = randomChineseIp(ranges);
      expect(ip).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
      expect(inRange(ip)).toBe(true);
    }
  });

  test("支持注入 random 生成确定性伪装中国 IP", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const provider = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      random: { nextFloat: () => 0.5 },
      loadApi: async () => ({
        cloudsearch: async (params: Record<string, unknown>) => {
          requests.push(params);
          return { body: { result: { songs: [] } } };
        },
      }),
    });

    await provider.search("测试歌曲", 20, "MUSIC_U=user-deterministic");
    // 同一随机源必然产出同一 IP；具体取值由 CN 网段权重决定，这里只锁定确定性与合法网段。
    const ip = String(requests[0]?.realIP);
    expect(ip).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
    const ranges = readChinaIpRanges();
    const value = ip.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
    expect(ranges.some((range) => value >= range.start && value <= range.end)).toBe(true);
    expect(randomChineseIp(ranges, { nextFloat: () => 0.5 })).toBe(
      randomChineseIp(ranges, { nextFloat: () => 0.5 }),
    );
  });

  test("CN 网段解析会忽略 BOM、注释与非法行并保底兜底", () => {
    const parsed = parseChinaIpRanges("\uFEFF1.1.8.0/24\n# comment\n\nbad-line\n999.1.1.1/8\n10.0.0.0/8\n");
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({ start: 0x01010800, end: 0x010108ff, count: 256 });
    // 数据缺失时仍需产出合法 IPv4，避免彻底无法出网。
    expect(randomChineseIp([])).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
  });

  test("上游 405 会透传消息、清空队列并在冷却期快速失败", async () => {
    let calls = 0;
    let virtualTime = 1_000;
    let rejectFirst!: (reason: unknown) => void;
    let notifyFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      notifyFirstStarted = resolve;
    });
    const firstResponse = new Promise<never>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const provider = new NeteaseMusicProvider({
      now: () => virtualTime,
      random: { nextFloat: () => 0 },
      maxConcurrentRequests: 1,
      minRequestIntervalMs: 0,
      rateLimitCooldownMs: 30,
      maxRateLimitCooldownMs: 30,
      queueTimeoutMs: 1_000,
      loadApi: async () => ({
        cloudsearch: async () => {
          calls += 1;
          if (calls === 1) {
            notifyFirstStarted();
            return firstResponse;
          }
          return { body: { result: { songs: [] } } };
        },
      }),
    });

    const pending = [
      provider.search("请求一"),
      provider.search("请求二"),
      provider.search("请求三"),
    ];
    await firstStarted;
    rejectFirst({
      status: 405,
      body: {
        code: 405,
        msg: "操作频繁，请稍候再试",
      },
    });

    const settled = await Promise.allSettled(pending);
    expect(calls).toBe(1);
    for (const result of settled) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({
          code: "MUSIC_API_RATE_LIMITED",
          message: "操作频繁，请稍候再试",
          details: { upstreamCode: 405 },
        });
      }
    }

    await expect(provider.search("冷却中")).rejects.toMatchObject({
      code: "MUSIC_API_RATE_LIMITED",
      message: "操作频繁，请稍候再试",
    });
    expect(calls).toBe(1);

    virtualTime += 50;
    await expect(provider.search("冷却结束")).resolves.toEqual([]);
    expect(calls).toBe(2);
  });

  test("上游正常返回 405 body 时同样进入冷却并透传消息", async () => {
    let calls = 0;
    let virtualTime = 1_000;
    const provider = new NeteaseMusicProvider({
      now: () => virtualTime,
      random: { nextFloat: () => 0 },
      minRequestIntervalMs: 0,
      rateLimitCooldownMs: 30,
      maxRateLimitCooldownMs: 30,
      loadApi: async () => ({
        cloudsearch: async () => {
          calls += 1;
          return calls === 1
            ? { body: { code: 405, message: "操作频繁，请稍候再试" } }
            : { body: { result: { songs: [] } } };
        },
      }),
    });

    await expect(provider.search("正常返回限流")).rejects.toMatchObject({
      code: "MUSIC_API_RATE_LIMITED",
      message: "操作频繁，请稍候再试",
      details: { upstreamCode: 405 },
    });
    await expect(provider.search("冷却期间快速失败")).rejects.toMatchObject({
      code: "MUSIC_API_RATE_LIMITED",
      message: "操作频繁，请稍候再试",
    });
    expect(calls).toBe(1);

    virtualTime += 50;
    await expect(provider.search("冷却结束恢复")).resolves.toEqual([]);
    expect(calls).toBe(2);
  });

  test("排队请求会过期而不是等待活动请求结束后补发", async () => {
    let calls = 0;
    let release!: () => void;
    let notifyFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      notifyFirstStarted = resolve;
    });
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = new NeteaseMusicProvider({
      maxConcurrentRequests: 1,
      minRequestIntervalMs: 0,
      queueTimeoutMs: 15,
      loadApi: async () => ({
        cloudsearch: async () => {
          calls += 1;
          if (calls === 1) {
            notifyFirstStarted();
            await blocker;
          }
          return { body: { result: { songs: [] } } };
        },
      }),
    });

    const active = provider.search("活动请求");
    await firstStarted;
    const queued = provider.search("陈旧请求");
    // 本地排队超时必须与上游限流分开编码：这里全程没有发生任何 405/406，
    // 只是本进程把自己堵住了，报成「限流」会让线上排查方向完全跑偏。
    await expect(queued).rejects.toMatchObject({
      code: "MUSIC_API_BUSY",
      message: "网易云请求等待超时，请稍后重试",
    });
    expect(calls).toBe(1);
    release();
    await expect(active).resolves.toEqual([]);
    expect(calls).toBe(1);
  });

  test("可选接口调用失败时记录采样告警日志并降级", async () => {
    const warnings: Array<{ message: string; meta: unknown }> = [];
    const fakeLogger = {
      warn: (message: string, meta: unknown) => {
        warnings.push({ message, meta });
      },
    } as any;

    const provider = new NeteaseMusicProvider({
      logger: fakeLogger,
      loadApi: async () => ({
        song_red_count: async () => {
          throw new Error("上游网络抖动");
        },
      }),
    });

    const popularity = await provider.getSongPopularity("123");
    expect(popularity).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toBe("网易云可选接口调用降级");
    expect(warnings[0]?.meta).toMatchObject({
      endpoints: ["song_red_count"],
    });
  });

  test("支持通过注入 now 与 random 驱动限流退避、冷却熔断与恢复", async () => {
    let virtualTime = 1_700_000_000_000;
    let upstreamCalls = 0;
    const provider = new NeteaseMusicProvider({
      now: () => virtualTime,
      random: { nextFloat: () => 0 },
      minRequestIntervalMs: 0,
      rateLimitCooldownMs: 5_000,
      loadApi: async () => ({
        cloudsearch: async () => {
          upstreamCalls += 1;
          if (upstreamCalls === 1) {
            return { body: { code: 405, message: "操作太频繁" } };
          }
          return { body: { result: { songs: [{ id: 99, name: "恢复歌曲" }] } } };
        },
      }),
    });

    // 1. 触发限流，进入 5s 冷却
    await expect(provider.search("测试1")).rejects.toMatchObject({
      code: "MUSIC_API_RATE_LIMITED",
    });
    expect(upstreamCalls).toBe(1);

    // 2. 推进 1 秒，仍在冷却中，本地直接拦截且不请求上游
    virtualTime += 1_000;
    await expect(provider.search("测试2")).rejects.toMatchObject({
      code: "MUSIC_API_RATE_LIMITED",
    });
    expect(upstreamCalls).toBe(1);

    // 3. 推进 5 秒越过冷却期，成功调用并恢复
    virtualTime += 5_000;
    const songs = await provider.search("测试3");
    expect(songs).toHaveLength(1);
    expect(songs[0]?.id).toBe("99");
    expect(upstreamCalls).toBe(2);
  });

  test("获取歌曲副歌并支持空数据安全降级与全量加载装配", async () => {
    let chorusCalls = 0;
    const provider = new NeteaseMusicProvider({
      loadApi: async () => ({
        song_chorus: async ({ id }: { id: string | number }) => {
          chorusCalls += 1;
          if (String(id) === "100") {
            return {
              body: {
                code: 200,
                chorus: [{ id: 100, startTime: 45_000, endTime: 85_000, ugcLocked: 0 }],
              },
            };
          }
          return {
            body: {
              code: 200,
              chorus: [],
            },
          };
        },
        song_detail: async () => ({
          body: {
            songs: [
              {
                id: 100,
                name: "副歌测试曲",
                ar: [{ id: 1, name: "歌手" }],
                al: { id: 1, name: "专辑" },
                dt: 240_000,
              },
            ],
          },
        }),
        song_url: async () => ({
          body: {
            data: [{ id: 100, url: "http://music.example.com/100.mp3" }],
          },
        }),
        lyric_new: async () => ({
          body: {
            lrc: { lyric: "[00:10.00]第一句歌词\n[00:20.00]第二句歌词" },
          },
        }),
      }),
    });

    const chorusNormal = await provider.getSongChorus("100");
    expect(chorusNormal).toEqual({ startTime: 45_000, endTime: 85_000 });

    const chorusEmpty = await provider.getSongChorus("200");
    expect(chorusEmpty).toBeUndefined();
    await expect(provider.getSongChorus("200")).resolves.toBeUndefined();
    expect(chorusCalls).toBe(2);

    const fullSong = await provider.getSong("100");
    expect(fullSong.chorus).toEqual({ startTime: 45_000, endTime: 85_000 });
    expect(fullSong.audioUrl).toBe("https://music.example.com/100.mp3");
  });

  test("播放地址命中短缓存，并支持强制刷新", async () => {
    let urlCalls = 0;
    const provider = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      loadApi: async () => ({
        song_detail: async () => ({ body: { songs: [{ id: 7, name: "缓存曲", ar: [{ name: "歌手" }] }] } }),
        song_url: async () => ({ body: { data: [{ id: 7, url: `http://music.example.com/${++urlCalls}.mp3` }] } }),
        lyric_new: async () => ({ body: { lrc: { lyric: "[00:01.00]缓存歌词" } } }),
      }),
    });

    await expect(provider.getSong("7")).resolves.toMatchObject({ audioUrl: "https://music.example.com/1.mp3" });
    await expect(provider.getSong("7")).resolves.toMatchObject({ audioUrl: "https://music.example.com/1.mp3" });
    expect(urlCalls).toBe(1);
    await expect(provider.refreshSongAudio!("7")).resolves.toBe("https://music.example.com/2.mp3");
    expect(urlCalls).toBe(2);
  });

  test("播放地址取空时不缓存负结果，后台恢复后必须能重试成功", async () => {
    let urlCalls = 0;
    // 首次回源上游抖动返回空地址，第二次恢复返回真实地址。
    // 空地址若被写进缓存，后续整个 TTL 内所有重试都会拿到空值 —— 玩家表现为
    // 「这首歌永远加载不出来」，且与出题随机性无关的偶发抖动会被放大成长期故障。
    const provider = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      loadApi: async () => ({
        song_detail: async () => ({ body: { songs: [{ id: 15, name: "抖动曲", ar: [{ name: "歌手" }] }] } }),
        song_url: async () => {
          urlCalls += 1;
          return urlCalls === 1
            ? { body: { data: [{ id: 15, url: null }] } }
            : { body: { data: [{ id: 15, url: "http://music.example.com/15.mp3" }] } };
        },
        lyric_new: async () => ({ body: { lrc: { lyric: "[00:01.00]抖动歌词" } } }),
      }),
    });

    await expect(provider.getSong("15")).rejects.toMatchObject({ code: "SONG_UNAVAILABLE" });
    // 第二次必须真正回源而不是复用被缓存的空值。
    await expect(provider.getSong("15")).resolves.toMatchObject({
      audioUrl: "https://music.example.com/15.mp3",
    });
    expect(urlCalls).toBe(2);
  });

  test("网易云歌曲无播放地址时自动触发全局解灰并返回 HTTPS 音频", async () => {
    let unblockCalls = 0;
    const provider = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      loadApi: async () => ({
        song_detail: async () => ({ body: { songs: [{ id: 88, name: "版权受限曲", ar: [{ name: "歌手" }] }] } }),
        song_url: async () => ({ body: { data: [{ id: 88, url: null, code: 404 }] } }),
        song_url_match: async ({ id }: { id: string | number }) => {
          unblockCalls += 1;
          return { body: { code: 200, data: `http://unblock.example.com/${id}.mp3` } };
        },
        lyric_new: async () => ({ body: { lrc: { lyric: "[00:01.00]测试歌词" } } }),
      }),
    });

    const song = await provider.getSong("88");
    expect(song.audioUrl).toBe("https://unblock.example.com/88.mp3");
    expect(unblockCalls).toBe(1);
  });

  test("网易云仅返回试听片段时自动触发解灰并替换为完整音频", async () => {
    let unblockCalls = 0;
    const provider = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      loadApi: async () => ({
        song_detail: async () => ({ body: { songs: [{ id: 89, name: "VIP试听曲", ar: [{ name: "歌手" }] }] } }),
        song_url: async () => ({
          body: {
            data: [{
              id: 89,
              url: "http://trial.example.com/89.mp3",
              freeTrialInfo: { start: 0, end: 30 },
            }],
          },
        }),
        song_url_match: async ({ id }: { id: string | number }) => {
          unblockCalls += 1;
          return { body: { code: 200, data: `http://unblock.example.com/full-${id}.mp3` } };
        },
        lyric_new: async () => ({ body: { lrc: { lyric: "[00:01.00]试听替换歌词" } } }),
      }),
    });

    const song = await provider.getSong("89");
    expect(song.audioUrl).toBe("https://unblock.example.com/full-89.mp3");
    expect(unblockCalls).toBe(1);
  });

  test("官方只给试听片段且解灰失败时抛不可用，不把试听当成播放地址", async () => {
    // 试听片段同样是 audio/mpeg、同样能 Range 206，探测起来与整曲无异（实测只有约 30 秒）。
    // 一旦在解灰失败时退回它，出题会拿到一个片段作答案，玩家在片段播完后对着静音猜歌。
    const provider = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      loadApi: async () => ({
        song_detail: async () => ({ body: { songs: [{ id: 94, name: "试听且解灰失败曲", ar: [{ name: "歌手" }] }] } }),
        song_url: async () => ({
          body: {
            data: [{
              id: 94,
              url: "http://trial.example.com/94.mp3",
              freeTrialInfo: { start: 0, end: 30 },
            }],
          },
        }),
        song_url_match: async () => ({ body: { code: 200, data: null } }),
        lyric_new: async () => ({ body: { lrc: { lyric: "[00:01.00]试听歌词" } } }),
      }),
    });

    await expect(provider.getSong("94")).rejects.toMatchObject({
      code: "SONG_UNAVAILABLE",
      message: "该歌曲暂时没有可用播放地址",
    });
  });

  test("解灰音源挂起不返回时会超时并按不可用处理，不会把整轮出题钉死", async () => {
    // 上游确实存在「请求被丢弃、Promise 永不 settle」的情况。没有上界时 getSong 会永远挂起，
    // 自动出题随即永久停在 automaticRoundLoading，房间再也开不了下一轮（这条用例会直接超时失败）。
    const attempted: string[] = [];
    const provider = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      // 用极小的上界驱动同一段逻辑，不必等真实的秒级超时
      unblockSourceTimeoutMs: 10,
      unblockTotalBudgetMs: 45,
      loadApi: async () => ({
        song_detail: async () => ({ body: { songs: [{ id: 95, name: "解灰挂起曲", ar: [{ name: "歌手" }] }] } }),
        song_url: async () => ({ body: { data: [{ id: 95, url: null, code: 404 }] } }),
        song_url_match: ({ source }: { source?: string }) => {
          attempted.push(String(source));
          return new Promise(() => {});
        },
        lyric_new: async () => ({ body: { lrc: { lyric: "[00:01.00]歌词" } } }),
      }),
    });

    await expect(provider.getSong("95")).rejects.toMatchObject({ code: "SONG_UNAVAILABLE" });
    expect(attempted.length).toBeGreaterThan(0);
    // 单个音源超时后继续换源，但总预算用尽即停手，不会把 8 个音源全等满
    expect(attempted.length).toBeLessThanOrEqual(8);
  });

  test("song_url_match 缺失时平滑回退至 song_url_v1 带 unblock 参数解灰", async () => {
    let v1UnblockCalls = 0;
    const provider = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      loadApi: async () => ({
        song_detail: async () => ({ body: { songs: [{ id: 90, name: "回退解灰曲", ar: [{ name: "歌手" }] }] } }),
        song_url: async () => ({ body: { data: [{ id: 90, url: null }] } }),
        song_url_v1: async (params: Record<string, unknown>) => {
          if (params.unblock === "true") {
            v1UnblockCalls += 1;
            return {
              body: {
                data: [{ id: 90, url: "http://v1-unblock.example.com/90.mp3" }],
              },
            };
          }
          throw new Error("xeapi missing");
        },
        lyric_new: async () => ({ body: { lrc: { lyric: "[00:01.00]回退歌词" } } }),
      }),
    });

    const song = await provider.getSong("90");
    expect(song.audioUrl).toBe("https://v1-unblock.example.com/90.mp3");
    expect(v1UnblockCalls).toBe(1);
  });

  test("关闭全局解灰时受限歌曲不发起解灰并抛出 SONG_UNAVAILABLE", async () => {
    let unblockCalls = 0;
    const provider = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      enableGeneralUnblock: false,
      loadApi: async () => ({
        song_detail: async () => ({ body: { songs: [{ id: 91, name: "禁用解灰曲", ar: [{ name: "歌手" }] }] } }),
        song_url: async () => ({ body: { data: [{ id: 91, url: null }] } }),
        song_url_match: async () => {
          unblockCalls += 1;
          return { body: { code: 200, data: "http://unblock/91.mp3" } };
        },
        lyric_new: async () => ({ body: { lrc: { lyric: "[00:01.00]歌词" } } }),
      }),
    });

    await expect(provider.getSong("91")).rejects.toMatchObject({
      code: "SONG_UNAVAILABLE",
      message: "该歌曲暂时没有可用播放地址",
    });
    expect(unblockCalls).toBe(0);
  });

  test("首个音源只返回网易云官方灰链时跳过该音源并采用后续音源", async () => {
    const attempted: string[] = [];
    const provider = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      enableGeneralUnblock: true,
      loadApi: async () => ({
        song_detail: async () => ({ body: { songs: [{ id: 93, name: "灰链兜底曲", ar: [{ name: "歌手" }] }] } }),
        song_url: async () => ({ body: { data: [{ id: 93, url: null }] } }),
        song_url_match: async ({ id, source }: { id: string | number; source?: string }) => {
          attempted.push(String(source));
          if (attempted.length === 1) {
            // 网易云官方外链兜底：字符串非空，但受限歌曲播放器只能拿到下载页 HTML
            return {
              body: { code: 200, data: `https://music.163.com/song/media/outer/url?id=${id}.mp3` },
            };
          }
          return { body: { code: 200, data: `http://unblock.example.com/full-${id}.mp3` } };
        },
        lyric_new: async () => ({ body: { lrc: { lyric: "[00:01.00]灰链曲歌词" } } }),
      }),
    });

    const song = await provider.getSong("93");
    expect(song.audioUrl).toBe("https://unblock.example.com/full-93.mp3");
    expect(attempted.length).toBeGreaterThan(1);
    expect(attempted[0]).toBe("unm");
  });

  test("所有音源都只能给出网易云官方灰链时抛出 SONG_UNAVAILABLE 而非伪解灰地址", async () => {
    const attempted: string[] = [];
    const provider = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      enableGeneralUnblock: true,
      loadApi: async () => ({
        song_detail: async () => ({ body: { songs: [{ id: 94, name: "无解曲", ar: [{ name: "歌手" }] }] } }),
        song_url: async () => ({ body: { data: [{ id: 94, url: null }] } }),
        song_url_match: async ({ id, source }: { id: string | number; source?: string }) => {
          attempted.push(String(source));
          return {
            body: { code: 200, data: `https://music.163.com/song/media/outer/url?id=${id}.mp3` },
          };
        },
        lyric_new: async () => ({ body: { lrc: { lyric: "[00:01.00]无解曲歌词" } } }),
      }),
    });

    await expect(provider.getSong("94")).rejects.toMatchObject({
      code: "SONG_UNAVAILABLE",
      message: "该歌曲暂时没有可用播放地址",
    });
    expect(attempted.length).toBeGreaterThan(1);
    expect(attempted).toContain("unm");
    expect(attempted).toContain("bugpk");
  });

  test("正常可用官方全曲不触发解灰", async () => {
    let unblockCalls = 0;
    const provider = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      enableGeneralUnblock: true,
      loadApi: async () => ({
        song_detail: async () => ({ body: { songs: [{ id: 92, name: "正常曲目", ar: [{ name: "歌手" }] }] } }),
        song_url: async () => ({
          body: {
            data: [{ id: 92, url: "http://official.example.com/92.mp3", freeTrialInfo: null }],
          },
        }),
        song_url_match: async () => {
          unblockCalls += 1;
          return { body: { code: 200, data: "http://unblock/92.mp3" } };
        },
        lyric_new: async () => ({ body: { lrc: { lyric: "[00:01.00]官方曲歌词" } } }),
      }),
    });

    const song = await provider.getSong("92");
    expect(song.audioUrl).toBe("https://official.example.com/92.mp3");
    expect(unblockCalls).toBe(0);
  });

  test("parseYrc 正确解析网易云逐字歌词并提取词级起止时间", () => {
    const yrcRaw = [
      "[1000,2000](1000,800,0)故事(1800,1200,0)的小黄花",
      "[3500,2000](3500,1000,0)从出生(4500,1000,0)那年就飘着",
    ].join("\n");
    const parsed = parseYrc(yrcRaw);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].time).toBe(1000);
    expect(parsed[0].endTime).toBe(3000);
    expect(parsed[0].text).toBe("故事的小黄花");
    expect(parsed[0].words).toBeDefined();
    expect(parsed[0].words).toHaveLength(2);
    expect(parsed[0].words![0]).toEqual({
      startTime: 1000,
      endTime: 1800,
      word: "故事",
      romanWord: undefined,
    });
    expect(parsed[0].words![1]).toEqual({
      startTime: 1800,
      endTime: 3000,
      word: "的小黄花",
      romanWord: undefined,
    });
  });

  test("parseTTML 正确解析 AMLL TTML 格式逐字歌词", () => {
    const ttmlRaw = `
      <tt xmlns="http://www.w3.org/ns/ttml">
        <body>
          <div>
            <p begin="00:02.000" end="00:05.000">
              <span begin="00:02.000" end="00:03.000">海</span>
              <span begin="00:03.000" end="00:05.000">阔天空</span>
            </p>
          </div>
        </body>
      </tt>
    `;
    const parsed = parseTTML(ttmlRaw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].time).toBe(2000);
    expect(parsed[0].endTime).toBe(5000);
    expect(parsed[0].text).toBe("海阔天空");
    expect(parsed[0].words).toHaveLength(2);
    expect(parsed[0].words![0].word).toBe("海");
    expect(parsed[0].words![1].word).toBe("阔天空");
  });

  test("sanitizeLyrics 对逐字歌词保留真实精确 endTime 而非被下一句起始时间粗暴覆盖", () => {
    const lines = [
      {
        time: 1000,
        endTime: 3000,
        text: "第一句",
        words: [{ startTime: 1000, endTime: 3000, word: "第一句" }],
      },
      {
        time: 15000,
        endTime: 18000,
        text: "第二句",
        words: [{ startTime: 15000, endTime: 18000, word: "第二句" }],
      },
    ];
    const sanitized = sanitizeLyrics(lines, { title: "歌名", artist: "歌手" });
    expect(sanitized).toHaveLength(2);
    // 第一句 endTime 不应该被拉伸到 15000
    expect(sanitized[0].endTime).toBe(3000);
    expect(sanitized[1].endTime).toBe(18000);
  });

  test("歌词四级回退优先级：网易云 YRC > AMLL ID 匹配 > AMLL 歌曲名搜索 > 网易云 LRC", async () => {
    const mockDetail = { songs: [{ id: 101, name: "测试曲目", ar: [{ name: "测试歌手" }] }] };
    const mockUrl = { data: [{ id: 101, url: "http://example.com/101.mp3" }] };

    let amllIdFetched = false;
    let amllSearchFetched = false;

    const ttmlContent = (label: string) => `
      <tt xmlns="http://www.w3.org/ns/ttml">
        <body>
          <div>
            <p begin="00:01.000" end="00:04.000">
              <span begin="00:01.000" end="00:04.000">${label}</span>
            </p>
          </div>
        </body>
      </tt>
    `;

    // 1. 存在 YRC 时，优先使用 YRC，不调用 AMLL
    const providerWithYrc = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      fetchAmllLyrics: async () => {
        amllIdFetched = true;
        return ttmlContent("AMLL-ID歌词");
      },
      fetchAmllSearchLyrics: async () => {
        amllSearchFetched = true;
        return ttmlContent("AMLL-搜索歌词");
      },
      loadApi: async () => ({
        song_detail: async () => ({ body: mockDetail }),
        song_url: async () => ({ body: mockUrl }),
        lyric_new: async () => ({
          body: {
            yrc: { lyric: "[1000,3000](1000,3000,0)网易云YRC歌词" },
            lrc: { lyric: "[00:01.00]网易云LRC歌词" },
          },
        }),
      }),
    });
    amllIdFetched = false;
    amllSearchFetched = false;
    const song1 = await providerWithYrc.getSong("101");
    expect(song1.lyrics[0].text).toBe("网易云YRC歌词");
    expect(song1.lyrics[0].words).toBeDefined();
    expect(amllIdFetched).toBe(false);
    expect(amllSearchFetched).toBe(false);

    // 2. 无 YRC 但有 AMLL 网易云 ID 匹配时，使用 AMLL ID 歌词，不调用搜索
    const providerWithAmllId = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      fetchAmllLyrics: async (id) => {
        amllIdFetched = true;
        return id === "101" ? ttmlContent("AMLL-ID逐字歌词") : undefined;
      },
      fetchAmllSearchLyrics: async () => {
        amllSearchFetched = true;
        return ttmlContent("AMLL-搜索逐字歌词");
      },
      loadApi: async () => ({
        song_detail: async () => ({ body: mockDetail }),
        song_url: async () => ({ body: mockUrl }),
        lyric_new: async () => ({
          body: {
            lrc: { lyric: "[00:01.00]网易云普通LRC歌词" },
          },
        }),
      }),
    });
    amllIdFetched = false;
    amllSearchFetched = false;
    const song2 = await providerWithAmllId.getSong("101");
    expect(song2.lyrics[0].text).toBe("AMLL-ID逐字歌词");
    expect(song2.lyrics[0].words).toBeDefined();
    expect(amllIdFetched).toBe(true);
    expect(amllSearchFetched).toBe(false);

    // 3. 无 YRC 且 AMLL ID 未命中，但 AMLL 歌曲名搜索命中时，使用搜索歌词
    const providerWithAmllSearch = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      fetchAmllLyrics: async () => {
        amllIdFetched = true;
        return undefined;
      },
      fetchAmllSearchLyrics: async (title, artist) => {
        amllSearchFetched = true;
        if (title === "测试曲目" && artist === "测试歌手") {
          return ttmlContent("AMLL-搜索逐字歌词");
        }
        return undefined;
      },
      loadApi: async () => ({
        song_detail: async () => ({ body: mockDetail }),
        song_url: async () => ({ body: mockUrl }),
        lyric_new: async () => ({
          body: {
            lrc: { lyric: "[00:01.00]网易云普通LRC歌词" },
          },
        }),
      }),
    });
    amllIdFetched = false;
    amllSearchFetched = false;
    const song3 = await providerWithAmllSearch.getSong("101");
    expect(song3.lyrics[0].text).toBe("AMLL-搜索逐字歌词");
    expect(song3.lyrics[0].words).toBeDefined();
    expect(amllIdFetched).toBe(true);
    expect(amllSearchFetched).toBe(true);

    // 4. 无 YRC、AMLL ID 和 AMLL 搜索均未命中时，兜底使用网易云普通 LRC
    const providerWithLrc = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      fetchAmllLyrics: async () => undefined,
      fetchAmllSearchLyrics: async () => undefined,
      loadApi: async () => ({
        song_detail: async () => ({ body: mockDetail }),
        song_url: async () => ({ body: mockUrl }),
        lyric_new: async () => ({
          body: {
            lrc: { lyric: "[00:01.00]网易云普通LRC兜底歌词" },
          },
        }),
      }),
    });
    const song4 = await providerWithLrc.getSong("101");
    expect(song4.lyrics[0].text).toBe("网易云普通LRC兜底歌词");
  });

  test("mergeTranslations 依据时间戳误差智能对齐并排除署名噪声", () => {
    const lines = [
      { time: 1000, endTime: 3000, text: "何も言わないで" },
      { time: 3000, endTime: 5000, text: "階段をみつめて" },
    ];
    const transRaw = `
[00:00.00]翻译作词：某某某
[00:01.05]缄默不言
[00:03.00]紧紧盯着
`;
    const romanRaw = `
[00:01.00]na ni mo i wa na i de
[00:03.00]ka i da n wo mi tsu me te
`;

    const merged = mergeTranslations(lines, transRaw, romanRaw);
    expect(merged[0].translatedLyric).toBe("缄默不言");
    // 规范：同时有翻译和注音时，只显示翻译，注音被屏蔽
    expect(merged[0].romanLyric).toBeUndefined();
    expect(merged[1].translatedLyric).toBe("紧紧盯着");
    expect(merged[1].romanLyric).toBeUndefined();

    // 仅有注音无翻译时，注音被正常保留
    const romanOnlyMerged = mergeTranslations(lines, undefined, romanRaw);
    expect(romanOnlyMerged[0].translatedLyric).toBeUndefined();
    expect(romanOnlyMerged[0].romanLyric).toBe("na ni mo i wa na i de");
    expect(romanOnlyMerged[1].romanLyric).toBe("ka i da n wo mi tsu me te");
  });

  test("getSong 提取网易云 ytlrc 与 tlyric 时自动为歌词赋予对应翻译", () => {
    const mockDetail = {
      songs: [
        {
          id: 202,
          name: "Pale",
          ar: [{ id: 1, name: "MIMI" }],
          al: { id: 1, name: "Pale", picUrl: "https://example.com/p.jpg" },
          dt: 150000,
          fee: 0,
        },
      ],
    };
    const mockUrl = {
      data: [{ id: 202, url: "https://example.com/audio.mp3" }],
    };
    const provider = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      loadApi: async () => ({
        song_detail: async () => ({ body: mockDetail }),
        song_url: async () => ({ body: mockUrl }),
        lyric_new: async () => ({
          body: {
            yrc: { lyric: "[1000,2000](1000,2000,0)何も言わないで\n[3000,2000](3000,2000,0)階段をみつめて" },
            ytlrc: { lyric: "[00:01.00]缄默不言\n[00:03.00]紧紧盯着" },
          },
        }),
      }),
    });

    return provider.getSong("202").then((song) => {
      expect(song.lyrics).toHaveLength(2);
      expect(song.lyrics[0].text).toBe("何も言わないで");
      expect(song.lyrics[0].translatedLyric).toBe("缄默不言");
      expect(song.lyrics[1].text).toBe("階段をみつめて");
      expect(song.lyrics[1].translatedLyric).toBe("紧紧盯着");
    });
  });
});

/**
 * 扫码登录会话必须按「二维码 unikey」分桶。
 *
 * 曾经会话 scope 是 provider 级单值：两个房间的房主在相近时间扫码时，后发起者覆盖前者，
 * 于是先完成的那位被绑上别人的会话 IP（永久错绑）、后完成的那位压根没绑上登录握手时的 IP。
 * 更糟的是旧实现让 IP 选取无条件优先这个全局字段，任意一个用户处于扫码等待期，
 * 全进程所有房间的请求都会被带上该会话的 IP。
 */
test("并发扫码登录各自绑定自己的会话 IP，不会互相串号", async () => {
  const calls: Array<{ endpoint: string; key?: string; realIP?: unknown; cookie?: unknown }> = [];
  let keySeq = 0;
  const provider = new NeteaseMusicProvider({
    minRequestIntervalMs: 0,
    loadApi: async () => ({
      login_qr_key: async (params: Record<string, unknown>) => {
        keySeq += 1;
        calls.push({ endpoint: "key", realIP: params.realIP });
        return { body: { code: 200, data: { unikey: `key-${keySeq}` } } };
      },
      login_qr_create: async (params: Record<string, unknown>) => {
        calls.push({ endpoint: "create", key: String(params.key), realIP: params.realIP });
        return {
          body: { code: 200, data: { qrurl: "https://qr.example", qrimg: "data:image/png;base64,x" } },
        };
      },
      login_qr_check: async (params: Record<string, unknown>) => {
        calls.push({ endpoint: "check", key: String(params.key), realIP: params.realIP });
        return {
          body: { code: 803, message: "授权登录成功" },
          // 真实上游把 cookie 放在响应顶层的数组里
          cookie: [`MUSIC_U=session-${params.key}`],
        };
      },
      login_status: async (params: Record<string, unknown>) => {
        calls.push({ endpoint: "status", realIP: params.realIP });
        return {
          body: { code: 200, data: { code: 200, profile: { userId: 10001, nickname: "测试用户" } } },
        };
      },
      deviceinfo_center_upload: async () => ({ body: { code: 200 } }),
      cloudsearch: async (params: Record<string, unknown>) => {
        calls.push({ endpoint: "search", realIP: params.realIP, cookie: params.cookie });
        return { body: { result: { songs: [] } } };
      },
    }),
  });

  const qrA = await provider.createQrLogin();
  // 后发起者：旧实现在这一步就把 A 的会话 scope 覆盖掉
  const qrB = await provider.createQrLogin();
  const resultA = await provider.checkQrLogin(qrA.key);
  const resultB = await provider.checkQrLogin(qrB.key);

  expect(resultA.status).toBe("authorized");
  expect(resultB.status).toBe("authorized");

  const ipOf = (endpoint: string, key?: string) =>
    calls
      .filter((call) => call.endpoint === endpoint && (key === undefined || call.key === key))
      .map((call) => call.realIP);

  const ipA = ipOf("check", qrA.key)[0];
  const ipB = ipOf("check", qrB.key)[0];

  // 同一轮扫码：建码与轮询必须是同一个出口 IP
  expect(ipOf("create", qrA.key)[0]).toBe(ipA);
  expect(ipOf("create", qrB.key)[0]).toBe(ipB);
  // 两轮会话互不串号
  expect(ipA).not.toBe(ipB);

  // 登录完成后用各自凭证发起普通请求，应继续复用自己登录时的那个 IP
  await provider.search("歌曲甲", 20, `MUSIC_U=session-${qrA.key}`);
  await provider.search("歌曲乙", 20, `MUSIC_U=session-${qrB.key}`);
  const searches = calls.filter((call) => call.endpoint === "search");
  expect(searches[0]?.realIP).toBe(ipA);
  expect(searches[1]?.realIP).toBe(ipB);
});

test("歌单超过单页上限时继续翻页取完并去重", async () => {
  const total = 1201;
  const all = Array.from({ length: total }, (_, index) => ({
    id: index + 1,
    name: `曲目${index + 1}`,
    ar: [{ id: 7, name: "歌手甲" }],
    al: { name: "专辑" },
  }));
  const offsets: number[] = [];
  const provider = new NeteaseMusicProvider({
    loadApi: async () => ({
      playlist_track_all: async (params: Record<string, unknown>) => {
        const offset = Number(params.offset ?? 0);
        const limit = Number(params.limit ?? 1000);
        offsets.push(offset);
        return { body: { songs: all.slice(offset, offset + limit) } };
      },
      // playlist_track_all 不返回歌单名与曲目总数，需要详情补上。
      playlist_detail: async () => ({
        body: { playlist: { id: 42, name: "超长歌单", trackCount: total } },
      }),
    }),
  });

  const result = await provider.getPlaylistSongs("42");
  expect(result.info).toEqual({ id: "42", name: "超长歌单", songCount: total });
  expect(result.songs).toHaveLength(total);
  expect(result.songs.at(-1)?.id).toBe(String(total));
  expect(new Set(result.songs.map((song) => song.id)).size).toBe(total);
  // 第二页取完即停，不会为空页再发一次请求
  expect(offsets).toEqual([0, 1000]);
});

test("歌单接口不支持翻页时不会重复取整页", async () => {
  let calls = 0;
  const provider = new NeteaseMusicProvider({
    loadApi: async () => ({
      // 只提供 playlist_detail：它忽略 offset，每页都返回同一份 tracks
      playlist_detail: async () => {
        calls += 1;
        return {
          body: {
            playlist: {
              id: 42,
              name: "两首",
              tracks: [
                { id: 1, name: "曲目一", ar: [{ name: "歌手甲" }] },
                { id: 2, name: "曲目二", ar: [{ name: "歌手甲" }] },
              ],
            },
          },
        };
      },
    }),
  });

  const result = await provider.getPlaylistSongs("42");
  expect(result.songs.map((song) => song.id)).toEqual(["1", "2"]);
  expect(result.info).toEqual({ id: "42", name: "两首", songCount: 2 });
  // 响应不带 trackCount 时只能靠「本页没有新增曲目」终止翻页；请求数必须仍然有界
  expect(calls).toBeLessThan(10);
});

test("歌单翻页中途失败时保留已取到的曲目", async () => {
  const firstPage = Array.from({ length: 1000 }, (_, index) => ({
    id: index + 1,
    name: `曲目${index + 1}`,
    ar: [{ name: "歌手甲" }],
  }));
  const provider = new NeteaseMusicProvider({
    loadApi: async () => ({
      playlist_track_all: async (params: Record<string, unknown>) => {
        if (Number(params.offset ?? 0) > 0) throw new Error("上游翻页失败");
        return { body: { songs: firstPage } };
      },
      playlist_detail: async () => ({
        body: { playlist: { id: 42, name: "半途", trackCount: 1201 } },
      }),
    }),
  });

  const result = await provider.getPlaylistSongs("42");
  expect(result.info.songCount).toBe(1201);
  expect(result.songs).toHaveLength(1000);
});


test("角色正文分类优先于结构署名，重复副歌时间轴保留", () => {
  const body = ["【男】山河辽阔", "【女】灯火阑珊", "合：星河灿烂", "solo：满天星辰", "rap：灯火阑珊", "男：让我用心把你留下来", "rap：看我的风景"];
  for (const text of body) {
    expect(isCreditLyricLine(text)).toBe(false);
    expect(isUnusableLyricLine(text)).toBe(false);
  }
  for (const text of ["男：", "【男】", "作词：张三", "Guitar Solo：John Smith", "版权所有：唱片公司", "采样率：44100Hz"]) expect(isUnusableLyricLine(text)).toBe(true);
  const lines = [...body, body[0]].map((text, index) => ({ time: index * 1000, endTime: (index + 1) * 1000, text }));
  expect(sanitizeLyrics(lines, { title: "答案", artist: "歌手" }).map(line => line.text)).toEqual([...body, body[0]]);
});


const amllTtmlFixture = (text = "恢复后的歌词正文") => `<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="0:01.000" end="0:04.000"><span begin="0:01.000" end="0:04.000">${text}</span></p></div></body></tt>`;
const amllResponse = () => Response.json({ status: 200, data: { lyrics: amllTtmlFixture() } });

describe("AMLL 确定缺失与瞬态失败缓存边界", () => {
  for (const failure of [503, 429, "abort", "json", "invalid", "empty"] as const) test(`${failure} 当次降级但恢复后同键回源`, async () => {
    let calls = 0;
    const provider = new NeteaseMusicProvider({ amllRequestTimeoutMs: 20, amllFetcher: async () => {
      if (++calls > 1) return amllResponse();
      if (typeof failure === "number") return new Response(null, { status: failure });
      if (failure === "abort") return new Promise<Response>(() => {});
      if (failure === "json") return new Response("not-json");
      return Response.json({ status: 200, data: { lyrics: failure === "empty" ? "" : "<invalid>" } });
    } });
    expect(await provider.getAmllTtmlLyrics("1")).toBeUndefined();
    expect(await provider.getAmllTtmlLyrics("1")).toBe(amllTtmlFixture());
    expect(calls).toBe(2);
  });

  test("明确404缺失仍缓存，同键并发合并，硬过期重新回源", async () => {
    let now = 0, calls = 0;
    const provider = new NeteaseMusicProvider({ now: () => now, amllFetcher: async () => { calls++; return new Response(null, { status: 404 }); } });
    expect(await Promise.all(Array.from({ length: 20 }, () => provider.getAmllTtmlLyrics("404")))).toEqual(Array(20).fill(undefined));
    expect(calls).toBe(1);
    expect(await provider.getAmllTtmlLyrics("404")).toBeUndefined(); expect(calls).toBe(1);
    now = 4 * 24 * 60 * 60 * 1000;
    expect(await provider.getAmllTtmlLyrics("404")).toBeUndefined(); expect(calls).toBe(2);
  });

  test("搜索无结果可缓存，搜索到条目后的503不可缓存", async () => {
    let calls = 0;
    const provider = new NeteaseMusicProvider({ amllFetcher: async url => {
      calls++;
      if (url.includes("q=missing")) return Response.json({ status: 200, data: { items: [] } });
      if (url.includes("search?")) return Response.json({ status: 200, data: { items: [{ id: "ttml" }] } });
      return calls === 3 ? new Response(null, { status: 503 }) : amllResponse();
    } });
    await provider.searchAmllTtmlLyrics("missing"); await provider.searchAmllTtmlLyrics("missing"); expect(calls).toBe(1);
    expect(await provider.searchAmllTtmlLyrics("found")).toBeUndefined();
    expect(await provider.searchAmllTtmlLyrics("found")).toBe(amllTtmlFixture()); expect(calls).toBe(5);
  });

  test("ID和搜索瞬态失败后LRC降级，不冻结完整歌曲歌词，恢复可获取TTML", async () => {
    let recovered = false;
    const provider = new NeteaseMusicProvider({ minRequestIntervalMs: 0, amllFetcher: async () => recovered ? amllResponse() : new Response(null, { status: 503 }),
      loadApi: async () => ({
        song_detail: async () => ({ body: { songs: [{ id: 1, name: "答案", ar: [{ name: "歌手" }], al: { name: "专辑" }, dt: 200000 }] } }),
        song_url: async () => ({ body: { data: [{ url: "https://audio.invalid/fixture.mp3" }] } }),
        lyric: async () => ({ body: { lrc: { lyric: "[00:01.00]降级歌词仍然可用" } } }),
      }),
    });
    expect((await provider.getSong("1")).lyrics[0].text).toBe("降级歌词仍然可用");
    recovered = true;
    expect((await provider.getSong("1")).lyrics[0].text).toBe("恢复后的歌词正文");
  });

  test("结构化失败日志保留安全上下文、错误堆栈与cause", async () => {
    const warnings: Array<{ message: string; meta: unknown }> = [];
    const logger = { warn: (message: string, meta: unknown) => warnings.push({ message, meta }) } as any;
    const cause = new Error("dummy cause");
    const provider = new NeteaseMusicProvider({ logger,
      fetchAmllLyrics: async () => { throw new Error("dummy id failure", { cause }); },
      fetchAmllSearchLyrics: async () => { throw new Error("dummy search failure", { cause }); },
    });
    expect(await provider.getAmllTtmlLyrics("fixture-id")).toBeUndefined();
    expect(await provider.searchAmllTtmlLyrics("fixture-title")).toBeUndefined();
    expect(warnings).toHaveLength(2);
    for (const warning of warnings) {
      expect(warning.message).not.toContain("[object Object]");
      expect(warning.meta).toMatchObject({ errorName: "Error", stack: expect.any(String), cause: { errorMessage: "dummy cause" } });
    }
    expect(warnings[0].meta).toMatchObject({ songId: "fixture-id", errorMessage: "dummy id failure" });
    expect(warnings[1].meta).toMatchObject({ title: "fixture-title", errorMessage: "dummy search failure" });
  });
});

describe("AMLL 独立后端预算", () => {
  test("跨键并发有界，按键合并且不阻塞网易云API队列", async () => {
    let calls = 0, active = 0, peak = 0, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const provider = new NeteaseMusicProvider({ amllMaxConcurrentRequests: 2, amllFetcher: async () => {
      calls++; active++; peak = Math.max(peak, active); await gate; active--; return amllResponse();
    }, loadApi: async () => ({ cloudsearch: async () => ({ body: { result: { songs: [] } } }) }) });
    const requests = Array.from({ length: 20 }, (_, index) => provider.getAmllTtmlLyrics(String(index)));
    const duplicate = provider.getAmllTtmlLyrics("0");
    expect(calls).toBe(2); expect(peak).toBe(2);
    expect(await provider.search("independent")).toEqual([]);
    release(); await Promise.all([...requests, duplicate]);
    expect(calls).toBe(20); expect(peak).toBe(2); expect(active).toBe(0);
  });

  test("饱和、截止释放队列与同键在途，后续恢复", async () => {
    let calls = 0, recovered = false;
    const signals: AbortSignal[] = [];
    const provider = new NeteaseMusicProvider({ amllMaxConcurrentRequests: 1, amllMaxQueuedRequests: 1, amllRequestTimeoutMs: 25,
      amllFetcher: async (_url, init) => { calls++; signals.push(init!.signal!); return recovered ? amllResponse() : new Promise<Response>(() => {}); },
    });
    const first = provider.getAmllTtmlLyrics("first"), queued = provider.getAmllTtmlLyrics("queued");
    expect(await provider.getAmllTtmlLyrics("overflow")).toBeUndefined();
    expect(calls).toBe(1);
    await Promise.all([first, queued]);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    recovered = true;
    expect(await provider.getAmllTtmlLyrics("first")).toBe(amllTtmlFixture());
    expect(await provider.getAmllTtmlLyrics("queued")).toBe(amllTtmlFixture());
  });
});

describe("网易云上游预热与登录态复用", () => {
  const anonApi = (onRegister?: () => void) => ({
    register_anonimous: async () => {
      onRegister?.();
      return { body: { code: 200, cookie: "MUSIC_A=anonymous" } };
    },
  });

  test("预热只加载一次接口包并只注册一次匿名令牌", async () => {
    let loads = 0, registrations = 0;
    const provider = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      loadApi: async () => {
        loads += 1;
        return anonApi(() => { registrations += 1; });
      },
    });

    await provider.warmUp();
    await provider.warmUp();

    expect(loads).toBe(1);
    expect(registrations).toBe(1);
  });

  test("预热失败不钉死惰性加载，后续请求仍可重试", async () => {
    let loads = 0;
    const warnings: string[] = [];
    const provider = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      logger: { warn: (message: string) => { warnings.push(message); } } as never,
      loadApi: async () => {
        loads += 1;
        if (loads === 1) throw new Error("接口包加载瞬时失败");
        return anonApi();
      },
    });

    await expect(provider.warmUp()).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);

    // 拒绝的 Promise 若留在字段上，第二次预热仍会拿到同一个失败结果。
    await expect(provider.warmUp()).resolves.toBeUndefined();
    expect(loads).toBe(2);
    expect(warnings).toHaveLength(1);
  });

  test("同一 Cookie 的登录态在复用窗口内只回源一次，且返回值不可污染缓存", async () => {
    let statusCalls = 0;
    const provider = new NeteaseMusicProvider({
      randomCNIP: false,
      minRequestIntervalMs: 0,
      loadApi: async () => ({
        ...anonApi(),
        login_status: async () => {
          statusCalls += 1;
          return { body: { data: { code: 200, profile: { userId: 42, nickname: "复用测试" } } } };
        },
        vip_info_v2: async () => ({
          body: { code: 200, data: { associator: { vipCode: 100, expireTime: Date.now() + 60_000 } } },
        }),
      }),
    });

    const first = await provider.getLoginStatus("MUSIC_U=reuse");
    expect(first.account).toMatchObject({ nickname: "复用测试", vipStatus: "vip" });

    const second = await provider.getLoginStatus("MUSIC_U=reuse");
    expect(second.account).toMatchObject({ nickname: "复用测试", vipStatus: "vip" });
    expect(statusCalls).toBe(1);

    second.account.nickname = "被调用方改写";
    await expect(provider.getLoginStatus("MUSIC_U=reuse")).resolves.toMatchObject({
      account: { nickname: "复用测试" },
    });
    expect(statusCalls).toBe(1);
  });

  test("校验失败不进入复用缓存，凭据恢复后仍重新回源", async () => {
    let statusCalls = 0, valid = false;
    const provider = new NeteaseMusicProvider({
      randomCNIP: false,
      minRequestIntervalMs: 0,
      loadApi: async () => ({
        ...anonApi(),
        login_status: async () => {
          statusCalls += 1;
          return valid
            ? { body: { data: { code: 200, profile: { userId: 42, nickname: "恢复登录" } } } }
            : { body: { data: { code: 301, profile: null } } };
        },
        vip_info_v2: async () => ({ body: { code: 200, data: {} } }),
      }),
    });

    await expect(provider.getLoginStatus("MUSIC_U=stale"))
      .rejects.toMatchObject({ code: "MUSIC_SESSION_INVALID" });

    valid = true;
    await expect(provider.getLoginStatus("MUSIC_U=stale")).resolves.toMatchObject({
      account: { nickname: "恢复登录" },
    });
    expect(statusCalls).toBe(2);
  });
});
