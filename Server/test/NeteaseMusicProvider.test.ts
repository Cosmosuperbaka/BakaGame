import { describe, expect, test } from "bun:test";

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
  parseLrc,
  sanitizeLyrics,
} from "../src/infrastructure/NeteaseMusicProvider";

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
      { time: 3_000, endTime: 7_000, text: "第一句歌词" },
      { time: 7_000, endTime: 12_000, text: "第二句歌词" },
    ]);
  });

  test("多歌手合唱歌曲中的单个人名歌词会被正确过滤", () => {
    const lyrics = parseLrc([
      "[00:01.00]（周杰伦）天青色等烟雨",
      "[00:04.00]（费玉清）而我在等你",
      "[00:08.00]炊烟袅袅升起",
    ].join("\n"));

    expect(sanitizeLyrics(lyrics, {
      title: "千里之外",
      artist: "周杰伦 / 费玉清",
      album: "依然范特西",
    })).toEqual([
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

  test("连排制作名单整块剔除，重复行只保留首次出现", () => {
    const lyrics = parseLrc([
      "[00:01.00]翻策：邹铁牛",
      "[00:02.00]美工：问绮灯",
      "[00:03.00]题字：白冰堂",
      "[00:04.00]后期：是铁牛",
      "[00:05.00]翻唱：悼子\\ワカイ调和剂\\夙夜\\浅安",
      "[00:08.00]第一句真实歌词",
      "[00:10.00]第二句真实歌词",
      "[00:12.00]第一句真实歌词",
    ].join("\n"));

    expect(sanitizeLyrics(lyrics, { title: "某歌", artist: "某人" })).toEqual([
      { time: 8_000, endTime: 10_000, text: "第一句真实歌词" },
      { time: 10_000, endTime: 15_000, text: "第二句真实歌词" },
    ]);
  });

  test("历轮抽样沉淀的署名与噪声家族会被过滤", () => {
    // 以下用例来自对 4298 首收藏歌单的逐轮随机抽样分诊（R2-R6），
    // 每一条都是真实歌词页里出现过、曾长期漏网的无效行，锁定防止回退。
    const dropLines = [
      // 复合录音/混音标签与人名归属
      "人声录音师：钱雷/杨惠琳@Studio 21A",
      "人声录音棚A：RMB Studio爆棚@奔跑怪物",
      "人声录音棚B：Studio 21A Beijing",
      "吉他录音：时俊峰@福达录音棚",
      "录音师 韦生@鲸升音乐",
      "录音棚 鲸升音乐",
      "母带工作室 : Sterling Sound",
      "配唱制作人 : 林俊杰/Dr. Moon",
      "制作人 徐鲤",
      "调声 Tuning : OQQ",
      "编曲 Arrange : 鬼否GriffO",
      "編曲 Arrange : 鬼否GriffO",
      "合成器 Synth : 丸易玄(鬼否GriffO)",
      "和声 Chorus : 丸易玄(鬼否GriffO)",
      "演唱 Voice：车子玉 Ziyu Che (HOYO-MiX)",
      "尺八 Shakuhachi：丁晓逵 Xiaokui Ding",
      "采样：QUIX - Deep Home",
      "Vocal edite：汝文博@SBMS Beijing",
      "版权 Publishing : 上海哔哩哔哩科技有限公司/Vsinger",
      // 英文 `<Role> At/By – <Value>`（en dash 分隔，Discogs 风格）
      "Mixed At – Enterprise Studios",
      "Mastered At – Precision Mastering",
      "Distributed By – EMI (Taiwan) Ltd.",
      "Backing Vocals – Julia Tillman-Waters, Maxine Waters, Oren Waters",
      "Presenter – 刘虞瑞",
      "Executive-Producer – 陈苔威",
      "A&R – 何启弘",
      // 答案泄露（歌名/原名/外语标题头）
      "歌曲原名：夜来香",
      "Bài Hát: See Tình",
      // 弦乐类长标签
      "弦乐指挥 : Adam Klemens",
      "弦乐翻译 : Stanja Vomackova",
      "弦乐线上录音系统及弦乐档案编辑 : Leonard Fong",
      // 颜文字噪声
      "～∧o∧o@∧o@∧o～∧o∧o-∧o～∧o∧o@∧o@∧o～∧o∧o-∧o",
      // R4 家族：助理/序数声部/乐器录音信息/括号制作标注
      "音频编辑：h3R3@1337Studio",
      "附加制作 : Charles Moniz",
      "制作助理 : 哈斯瑚必来",
      "混音助理 : Martin A. Nieves",
      "Chorus by : 陈奕迅",
      "(Music♂)",
      "（烛光制作）",
      "Drums Recorded at Aroom Studio",
      "Strings Recorded at 广州中国唱片社录音室",
      "Vocals & Piano Recorded at Avon Studios,",
      "Music & Vocals Recorded at Avon Acoustic Ltd",
      "Mixing at Avon Acoustic Ltd.",
      "Strings Recording Co-ordination by Stanley Leung",
      "艺人合作总监 : 宫尹琳Rainie/许雯婉",
      "2nd Violins : 谢林、郭慧、罗菁、张建辉",
      "器乐 : Brian Lee/Louis Bell",
      "Soloist – Michael Thompson",
      "和编：清潇Lanoiah",
      "人声录音工程师 : Louis Bell",
      "/ EMI Music Publishing (S.E. Asia) Ltd, Taiwan Branch",
      // R5 家族：独奏/民族乐器拼音/复合后缀
      "音乐编辑 : 汝文博/Sanbist Lin克昶 @ELEVENZ",
      "Guitar Solo : 愤怒的糖",
      "Trombone Solo : 中川 英二郎",
      "管乐录音 : 任允翔@天舞IDG Music Studio",
      "录音制作 : 上海朗夏沐泽音乐工作室",
      "营销推广：噼里啪啦Studio",
      "Video:Zris",
      "混音录音室 Mixing Studio：nOiz",
      "计算机音乐编成 : 魏百谦",
      "助理 Assistant : markmilian/Ream雨舒",
      "长笛、短笛 : 刘伊秾",
      "古筝 Guzheng: 陆莎莎 Shasha Lu、赵墨佳 Mojia Zhao",
      "表演者：星尘/乐正绫/言和/洛天依/牧心/Solaria/沨漪",
      "录音棚 Studio : キング関口台スタジオ King Sekiguchidai Studio",
      "谱务 Scoring : markmilian",
      "本歌曲来自网易喜雨工作室×飓风工作室",
      "Programmer：魏百谦",
      "词曲提供：词曲家",
      "母带后期处理制作人 Mastering Producer：陈建骐 George Chen",
      "母带后期处理录音室 Mastering Studio：馒头音乐工作室 MT Mastering Studio",
      "和音编写及演唱： 小手鹅_，马也_ Crabbit",
      "人声&音频剪辑： LBI利比",
      "通称：愛情対象年齢",
      "声音工程师 Sound Engineer:房大磊 Dalei Fang",
      "混音助理 Mixing Assistant:Tom Bailey",
      "笛子 Dizi:屠化冰 Huabing Tu",
      "琵琶 Pipa:施文卿 Wenqing Shi",
      "班苏里笛 Bansuri：Eliza Marshall",
      "西塔尔琴 Sitar：Arjun Verma",
      "萨兹琴 Saz：Dursuncan Cakin",
      "弦乐实录：starliner strings",
      "作曲者 : suhmeduh",
      "作词者 : suhmeduh",
      "编曲者 : suhmeduh",
      "(*music*)",
      // R6 家族：统筹/经纪/OP 版权行/原曲信息
      "和声录唱：刘潇阳/刘兆伦/俞佳乐/丁嘉昱/王斐/刘震鹤@灼梦Studio",
      "艺人统筹 : 李如嫣/马颖@FLOWSIXTEEN",
      "宣传企划 : 刘亚楠@FLOWSIXTEEN",
      "民乐编写 : 胡皓@光合声动",
      "企划营销 : 微梦传媒",
      "歌词制作 : Li-smalldream",
      "制作人经纪：Shinjiro Nitta (bluesofa)",
      "母版制作：Sterling Sound 的 Randy Merrill",
      "制作统筹Production Coordination：张鹤",
      "音乐出品发行公司：听见时代传媒",
      "音乐制作团队：灼梦Studio",
      "梁翘柏OP : OP of Kubert Leung Musichic LTD.",
      "AlbertOP : OP of Lin Xi Denseline Co. Limited (Warner/Chappell Music H.K. Limited)",
      "——正版授权，改编自《Counting stars》——",
      "（飞机场的10:30 - 陶喆）",
      "小提琴演奏：RO Maestro/ German D.",
      "大提琴演奏：Daniel G. (Venezuela)",
      "中国笛：Chris Bleth",
      "热瓦普：努日亚·阿不力米提",
      "新疆手鼓：依克拉姆·外力",
      "乐器录音棚 Instrumental Recording Studio：升赫录音棚Soundhub Studio",
      "艺人及作品管理：Dan Gerber",
      "作曲Composition : 三宝",
      "演奏Rendition：国际首席爱乐乐团",
      "录音时间Recording Time：2012.11",
      "演唱 Artist：中島美嘉 Mika Nakashima",
      "短笛 Piccolo：程晓华 Xiaohua Cheng",
    ];
    for (const line of dropLines) {
      expect(isUnusableLyricLine(line)).toBe(true);
    }
  });

  test("署名过滤的保留边界：角色唱段、人声切片、外语歌词与念白", () => {
    // 与上一条测试同源（R2-R7 抽样分诊），这些行必须保留。
    const keepLines = [
      // 人名/角色标记 + 歌词正文
      "洛：记起一段你总哼的调调",
      "女:依稀往梦似曾见",
      "合:相伴到天边",
      "男:射雕引弓塞外奔驰",
      "合：乒乒乓乒乓乒乒乒乓乓",
      "刘国正：我啪的一板正手直线打你个措手不及",
      "BY2：像夏天的可乐",
      "汪：已经约定过",
      "女：Hi yeah! oh oh oh...",
      "男：真的好想精于某事情 好想好好的打拼",
      "王太利：那是我日夜思念深深爱着的人啊",
      "肖央：当初的愿望实现了吗",
      "合：如果有明天祝福你亲爱的",
      "韩红：风 让云长出花 漫天的花",
      "林俊杰：漫步在人海的人 你过得好吗",
      "合：前面听说风很大",
      "远：谁晒自拍 按个赞",
      "伍：你开的车 比我多",
      "爸爸(说唱)：猎豹猎豹跑得快",
      "妈妈(说唱)：向日葵花向阳开",
      "全家(说唱)：图图的肚子咕咕咕咕叫不停",
      // 拟声/人声切片
      "Doo-doo-doo, doo-doo-doo",
      "Not gonna c-c-cry cry cry cry cry",
      "You should bet-bet-bet-bet on me",
      "on the stere-ere-ere-ere-o",
      "We are we are ahh-ahh-ahh",
      "How good it wa-a-as",
      "Why-ohhh , why-ohh-ohh-ohh",
      "Ooo-ahoo, ah-yah-ahha",
      "Badda-bang-bang-bang, alright then",
      "Rockabye-rocka-rocka-rocka-bye",
      "Kick it-kick-kick it",
      "GIO-GIO-GIO-GIO-GIO",
      "Corpo",
      "Corporation",
      "Corpo (x2)",
      "Corpo↓",
      "igh----------...",
      // 外语歌词
      "Lumea toata ii incantata",
      "Eu c-o sticla, el c-o sticla",
      "Breaking all the records that thought never could be broken",
      "We definite B-E-P we rappin' it",
      "Waiting on down for the B-boys",
      "And B-girls waiting doin' their thing",
      "Hetero sexual the kids flow is incredible",
      "百年后谁抬眸：“她曾活过”",
      "I will love you--",
      "Do my make-up",
      "Watch out - let me pour you a drink,",
      "le monde serait-il plus beau ?",
      "Leeres Wort: des Armen Rechte,",
      "Ger mun-mot-mun-metoden nu",
      "さぁ始めようか non-stop music",
      "ah non-stop music",
      "War Lie-兵士-War-World Eyes-Hate-(过过过过 过过过过 过错软弱从来不属于我)",
      "You were beside me—now you're not there",
      "The equal-opportunity killer,Alastor!",
      "nobody wanted to f-ck with the white boy",
      // 含 music/producer/conductor 等署名词的正常歌词（防新登记词误杀）
      "Music, makes me, high",
      "只有音乐最安全",
      "We havent had that spirit here since 1969",
      "Fighting every instinct while you hold your pride",
      "节奏和音乐入侵了血脉",
      "三天三夜的三更半夜飘浮只靠音乐",
      "文化是武器",
      "Shout-out to your mom and dad for makin' you",
      "The music dance and sing",
      "华丽的红房间 发霉的旧唱片",
      "Since 2009, I had this b***h jumpin'",
      "Sweet Chin Music, and I won't pass the aux, ayy",
      "Fast-forward, 2024, you got the same agenda",
      "留住这音乐",
      "啦啦啦，为你写下无人铭记的音乐",
      "It's been the same since seventeen",
      "this will hurt a skele-ton",
      "Just move your hand - write the way into his heart!",
      "Music is my only friend",
      "The producer of my pain",
      "Vocal cords are shaking now",
      "I am the conductor of my soul",
      "Open the orchestra pit",
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
      "Ripped jeans – skin was showing",
      "Hot night – Wind was blowing",
      "Your records my empty house",
      "Mali-Mali-Mali-Malibu (Malibu, Mali)",
      // 括号和声与对白
      "兰那罗们 —— 再见动物园合唱团（指挥：孙玥）",
      "雪莉：有人在吗？",
      "神乐：他们有事出去了，你有什么困扰呢？万事屋神乐为您服务阿鲁！",
      "Y2K: \"Nah, da da dadadada nananana\"",
      "Bbno$: Joins; \"da da dadadada\"",
      // 念白/天气预报采样（有内容的表演成分）
      "Saturday:Partly cloudy.",
      "Tonight:Mostly cloudy with isolated showers until midnight,then mostly clear after midnight.",
      // 空格分隔拒绝名单：高频歌词开头的标签词裸写时按歌词保留
      "导演 一场好戏",
      "感谢 这一路的陪伴",
      // R7 空格分隔署名（非 DENY 词）与对应歌词
      "音乐响起：我们的故事",
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
      "黄可爱@维伴音乐",
      "王皓@WONDERWALL",
      "洪信杰@牛班NEWBAND",
      "张人杰Andy@牛班NEWBAND",
    ]) {
      expect(isUnusableLyricLine(line)).toBe(true);
    }
    // 歌词里的 @：有空格、无团队名、或夹在句中；无 @ 的名字行保持原样。
    for (const line of [
      "Sing @ the top of my lungs",
      "Send it to me @ midnight",
      "me@you",
      "I'll be there @ 3am",
      "@ the end of the day",
      "你@我 我@你",
      "love@first sight",
      "洛天依Official",
    ]) {
      expect(isUnusableLyricLine(line)).toBe(false);
    }
  });

  test("官方发行页脚与同人圈混排署名会被过滤", () => {
    // R7 家族：官方发行页脚、裸机构行、双语混排标签。
    for (const line of [
      "Mixer : Rob Kinelski",
      "Studio Personnel : John Greenham / Rob Kinelski",
      "Synthesizer Operator : Genya Kuwajima",
      "Verse 2: G-Eazy",
      "Verse 3: DDG",
      "总监制 : Kevin Shin辛志宇@索尼音乐",
      "歌曲企划：Bella@TiMi Audio",
      "承制：北京龙生堂文化传媒有限公司",
      "混音工程：杨大纬(杨大纬录音工作室)",
      "电影原声发行：太合麦田（天津）音乐有限公司",
      "音乐监督 CARDINAL星海",
      "项目/艺人统筹：李艺佳 李靖",
      "项目/艺人协力：张靓琳 肖晰美（实习） 陈尧天（实习）",
      "宣发支持：凯西/开心",
      "宣发执行：Iris Zhang/佳佳/赵小咪",
      "导演：孙峥 窦琨淇 张天明 张彬",
      "调色：罗梦舟",
      "服装：“龙的传人”国潮品牌",
      "独家短视频平台：抖音",
      "特别说明：啦啦啦来自朵莉亚",
      "原作：《雨宿り》西崎みどり",
      "爱尔兰哨笛 : Brian Finnegan",
      "弦乐录制：星舟爱乐团",
      "改编编曲：周家騵",
      "改编词曲 : G.E.M.邓紫棋",
      "注：本歌曲使用初音未来声库制作",
      // 裸机构行与裸标签行（credit 块段落标题独占一行）
      "出品",
      "联合出品",
      "太合音乐集团",
      "朴林西思文化传媒",
      "北京国际音乐产业大会",
      "主题歌音乐专辑工作团队",
      "本歌曲来自〖云上工作室〗",
      // 同人圈混排标签（中文标签 + 英文后缀 + 斜杠取值）
      "二胡Erhu：马稼骏Jiajun Ma",
      "策划Planner/青天纤云 纳兰清婧",
      "词作Lyric/青天纤云 纳兰清婧",
      "语调教Rap Tuning/六花花",
      "混音Mix down/莫逆iMoNe",
      "PV Promotion Video/墨雨清泉",
      "出品社团Products/中华青云动漫音乐社TsingCloudsCHINA",
      "宣传物料及黑胶设计：周禹颉",
      "绘 ：无机盐_okian",
    ]) {
      expect(isUnusableLyricLine(line)).toBe(true);
    }
    // 裸行边界：两标签粘连与歌词保留（后期|制作人 是真实歌词，不得整行剔除）。
    for (const line of ["后期制作人", "曲终人散：我一个人走"]) {
      expect(isUnusableLyricLine(line)).toBe(false);
    }
  });

  test("R8 抽样沉淀：连字符分隔、多词乐器头与新增署名标签会被过滤", () => {
    // R8 家族一：连字符曾被当作分隔符，把 `Co-ordination` 在词中切碎导致漏网。
    for (const line of [
      "Production Co-ordination : Tania Doko",
      "Prodused : Nisj",
      "Audio Editing : Ivan Handell",
      "Sub Publishing : Warner Chappell Music",
      "Arranged : Henrik Nordenback",
      "Used by permission of Sony Music Publishing",
      "Nightlife reserved.",
      "已买版权 禁止二改二传",
      "版权公司：北京摩登天空文化发展有限公司",
      // 新中文标签：三弦/填词变体/贴混/监督/绘画/录音版权
      "三弦 : 张鑫",
      "中文填词：沈病娇",
      "粤语填词：梁晓璞",
      "国语填词：小克",
      "贴混：阿凯",
      "监督：李三木",
      "绘画：山新",
      "录音版权：腾讯音乐娱乐集团",
      // 连接符 `和`（带取值形态）
      "词和曲：陈信延",
      "填词和编曲：梁翘柏",
      // 多人名空取值分工行（、/／ 连接）
      "封茗囧菌、双笙：",
      "封茗囧菌／双笙：",
      "洛天依、言和、乐正绫：",
      // 拼写数词序数（带取值）
      "First Violin：张毅",
      "Second Violins : 刘云志",
      // 反向粘连：英文标签在前 + 中文标签
      "Vocal录音室：北京 bulletproof studio",
      "Vocal制作助理：蔡周灿",
      // 整行括号包裹的平台企划名
      "【bilibili音乐·2022虚拟歌手贺岁纪】",
      "【QQ音乐·独家企划】",
      "（网易云音乐独家出品）",
      // 多词乐器录音头（Solo Cello 这类空格分隔乐器）
      "Solo Cello Recorded at Avon Studios,",
      "Solo Violin Recorded by Zhang Yi",
      // 连字符作为分隔符的并列署名（空格夹心仍切分）
      "Mixed - Mastered by 张三",
    ]) {
      expect(isUnusableLyricLine(line)).toBe(true);
    }
    // 保留边界：字母夹心连字符不是分隔符（L-O-V-E 是拼写歌词），
    // 裸行走「单标签整体命中」路径不接粘连/序数（后期制作人教训），
    // `和` 两侧非标签、无平台名括号段落、乐器词+非署名动词都保留。
    for (const line of [
      "L-O-V-E",
      "G-Eazy",
      "Break-up song",
      "词和曲",
      "First Violin",
      "Vocal录音室",
      "我和你",
      "早餐和午餐：我吃了面包",
      "First love",
      "Second chance",
      "Love音乐",
      "Hello你好",
      "【副歌】",
      "【回忆】",
      "Spot is forever reserved",
      "Drums are beating at dawn",
      "Guitar solo in the night",
    ]) {
      expect(isUnusableLyricLine(line)).toBe(false);
    }
  });

  test("R9 抽样沉淀：和连接、机构粘连与归属署名会被过滤", () => {
    // R9 家族一：`和` 连接的多标签头（`和` 不进通用 joiner，否则 `和声` 被切碎）。
    for (const line of [
      "词和曲：陈信延",
      "填词和编曲：梁翘柏",
      "吉他、贝司、和声：李荣浩",
      // R9 家族二：新增英文/中文标签
      "Background Vocals: 光良/周博华",
      "和声编写 BACKGROUND VOCAL ARRANGEMENT : 林俊杰",
      "Accordion: 李正帆",
      "Vocoder : Chris \"Tek\" O'Ryan/Monsieur Georges/Pianoman",
      "中提琴 VIOLA : 甘威鹏 Weapon Kan",
      "CO-PRODUCTION：Big Fred/Sander Meland",
      "Recording Engineers: Peter Chong (Mal) / Rahmad",
      "Studios : Dragon Studio/Nippon Phonogram(Rhythm section)/EMI HK (Strings section)",
      "ISRC NO : HK-X58-04-30004",
      "分轨混音/母带：周天澈@Studio21A",
      "录混 : 马涛（上海谭旋音乐工作室）",
      "调/影：纳兰寻风",
      "二创效果Edit：Ryuzaki-L",
      "乐队总监 : Lawrence Ku顾忠山 ＠11zband",
      "前作：《那些我无法原谅的事》",
      // R9 家族三：结构判定
      "Kevin刘瀚文@Soundhub Studios",
      "人声&吉他&鼓（打击乐）录音棚：55Tec studio",
      "升赫录音棚Soundhub Studio",
    ]) {
      expect(isUnusableLyricLine(line)).toBe(true);
    }
    // 保留边界：群星对唱（人名冒号 + 歌词）、`和` 两侧非标签、
    // 英文开头非标签粘连、@ 歌词。
    for (const line of [
      "蔡 琴：轻轻敲醒沉睡的心灵",
      "齐秦 苏芮 余天：唱出你的热情 伸出你双手",
      "阿绫：月儿在手中开呀怀儿笑",
      "我和你",
      "早餐和午餐：我吃了面包",
      "词和曲",
      "Love音乐",
      "Hello你好",
      "在录音棚唱歌的夜晚",
      "Kevin刘瀚文 Sing a song",
      "Sing @ the top of my lungs",
      "me@you",
      "第一次发唱片",
      "想听你听过的音乐",
      "Ooh-la-la-la-la-la-la-la",
      "Doo-doo-doo, doo-doo-doo",
    ]) {
      expect(isUnusableLyricLine(line)).toBe(false);
    }
  });

  test("R10 抽样沉淀：序数尾缀、乐器品牌与版权代理会被过滤", () => {
    for (const line of [
      "Lead Vocals : Bruno Mars",
      "Linn Drum : Mark Ronson",
      "Talkbox : Jeff Bhasker",
      "Mix Engineering : John Hanes",
      "Tenor Saxophone : Neal Sugarman / Dwayne Dagger",
      "Baritone Saxophone : Ian Hendrickson-Smith",
      "Engineers : Mark Ronson / Boo Mitchell / Charles Moniz",
      "Additional Engineering : Ken Lewis / Devin Nakao",
      "Released on : 2006-01-01",
      "Sound Produce：百田留衣",
      "Chamberlin Oboe：陈绮贞",
      "B-Box:陆颢哲",
      "管弦乐配器 Orchestrator:何迦德 Jiade He",
      "电贝司 Electric Bass:张栗 Li Zhang",
      "（以下段落作曲作词：街道办／KT）",
      "监唱 : Victor刘伟德",
      "(Admin. by Warner/Chappell Music Korea)/",
      // 序数尾缀（分谱编号后置写法，与前缀形态相反）
      "Violin 1st：郑泽勋",
      "Violin 2nd：陈晏榕",
      // 结构判定已知边界：「短标签+冒号+无虚词短尾」按署名处理（R5 起既有行为）
      "风铃：响叮当",
    ]) {
      expect(isUnusableLyricLine(line)).toBe(true);
    }
    // 保留边界：裸 `mix`/`produce` 不进词表（`Mix it up` 是歌词）、
    // 结构判定放行含实词正文或高频词的行、历轮锚点回归。
    for (const line of [
      "Mix it up tonight",
      "Produce the beats",
      "风铃响了 叮当叮当",
      "也许可能蒸发",
      "我记得我去年夏天的时候出了一张唱片",
      "男：One two three here we go",
      "合：忘记了姓名的请跟我来",
      "Laisse-moi être libre (let me be free)",
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

    expect(requests[0]?.realIP).toBe(requests[1]?.realIP);
    expect(requests[0]?.realIP).toMatch(/^116\.(?:2[5-9]|[3-8]\d|9[0-4])\.\d{1,3}\.\d{1,3}$/);
    expect(requests[2]?.realIP).toMatch(/^116\.(?:2[5-9]|[3-8]\d|9[0-4])\.\d{1,3}\.\d{1,3}$/);
    expect(requests.every((params) => params.randomCNIP === true)).toBe(true);
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
    // 25 + Math.floor(0.5 * 70) = 60, Math.floor(0.5 * 256) = 128
    expect(requests[0]?.realIP).toBe("116.60.128.128");
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
    await expect(queued).rejects.toMatchObject({
      code: "MUSIC_API_RATE_LIMITED",
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
});
