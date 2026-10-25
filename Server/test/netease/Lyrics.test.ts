import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  NeteaseMusicProvider,
  parseLrc,
  parseYrc,
  mergeTranslations,
} from "../../src/infrastructure/NeteaseMusicProvider";
import {
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
  parseTTML,
  sanitizeLyrics,
} from "../../src/infrastructure/LyricLines";

describe("歌词清洗与解析", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = (async () => {
      throw new Error("测试禁止网络请求");
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("解析多时间戳 LRC 并补齐结束时间", () => {
    expect(parseLrc("[00:01.00][00:03.500]第一句\n[00:05.00]第二句")).toEqual([
      { time: 1_000, endTime: 3_500, text: "第一句" },
      { time: 3_500, endTime: 5_000, text: "第一句" },
      { time: 5_000, endTime: 10_000, text: "第二句" },
    ]);
  });

  test("过滤作词作曲编曲与歌手专辑署名并重新衔接时间轴", () => {
    const lyrics = parseLrc(
      [
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
        "[00:17.00]测试专辑",
        "[00:18.00]答案歌 测试歌手",
        "[00:19.00]测试歌手 答案歌",
      ].join("\n")
    );

    expect(
      sanitizeLyrics(lyrics, {
        title: "答案歌",
        artist: "测试歌手",
        album: "测试专辑",
      })
    ).toEqual([
      { time: 1_000, endTime: 3_000, text: "答案歌" },
      { time: 3_000, endTime: 4_000, text: "第一句歌词" },
      { time: 4_000, endTime: 7_000, text: "我们在唱答案歌" },
      { time: 7_000, endTime: 12_000, text: "第二句歌词" },
    ]);
  });

  test("多歌手合唱歌曲中的单个人名元数据行会被正确过滤，真实歌词完整保留", () => {
    const lyrics = parseLrc(
      [
        "[00:01.00]周杰伦",
        "[00:02.00]费玉清",
        "[00:04.00]（周杰伦）天青色等烟雨",
        "[00:06.00]我不是洛天依",
        "[00:08.00]炊烟袅袅升起",
      ].join("\n")
    );

    expect(
      sanitizeLyrics(lyrics, {
        title: "千里之外",
        artist: "周杰伦 / 费玉清 / 洛天依",
        album: "依然范特西",
      })
    ).toEqual([
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
    const lyrics = parseLrc(
      [
        "[00:01.00]翻策：邹铁牛",
        "[00:02.00]美工：问绮灯",
        "[00:03.00]题字：白冰堂",
        "[00:04.00]后期：是铁牛",
        "[00:05.00]翻唱：悼子\\ワカイ调和剂\\夙夜\\浅安",
        "[00:08.00]第一句真实歌词",
        "[00:10.00]第二句真实歌词",
        "[00:12.00]第一句真实歌词",
        "[00:14.00]珠玉早沉浮在泥沙",
      ].join("\n")
    );

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
      'Y2K: "Nah, da da dadadada nananana"',
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
    for (const line of ["Sing @ the top of my lungs", "me@you", "你@我 我@你", "洛天依Official"]) {
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

    let amllIdFetched: boolean;
    let amllSearchFetched: boolean;

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
            yrc: {
              lyric:
                "[1000,2000](1000,2000,0)何も言わないで\n[3000,2000](3000,2000,0)階段をみつめて",
            },
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
