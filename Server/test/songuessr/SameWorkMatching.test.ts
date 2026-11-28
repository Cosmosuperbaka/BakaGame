import { describe, expect, test } from "bun:test";
import { SonGuessrService } from "../../src/application/SonGuessrService";
import {
  isSameWork,
  type WorkComparableSong,
} from "../../src/application/songuessr/SameWorkMatching";
import { isSameAnswerSong } from "../../src/application/songuessr/SongTitleMatching";
import { MusicProvider } from "../../src/infrastructure/music/MusicProvider";
import { type SonGuessrPrivateState, type SongDetails } from "../../src/shared/Index";
import {
  connection,
  createRoom,
  execute,
  joinRoom,
  lastEvent,
  makeSong,
  startRound,
} from "./Fixtures";

/** 条目形状取自网易云歌曲详情的真实返回（`alia`、`tns` 已并入别名）。 */
const song = (
  id: string,
  title: string,
  artist: string,
  extra: Partial<WorkComparableSong> & { aliases?: string[] } = {}
): WorkComparableSong => {
  const { aliases, ...rest } = extra;
  return { id, title, artist, encyclopedia: { aliases }, ...rest };
};

const jayChouSunny = song("netease:186016", "晴天", "周杰伦", { originCoverType: 1 });

describe("其他版本也算对：翻唱与改编", () => {
  const cases: Array<{
    name: string;
    guess: WorkComparableSong;
    answer: WorkComparableSong;
    expected: boolean;
  }> = [
    {
      name: "翻唱回指答案本身",
      guess: song("netease:2668397359", "晴天 (原唱 周杰伦)", "RyaVocal", {
        originCoverType: 2,
        originSongId: "netease:186016",
        originSongTitle: "晴天",
        originSongArtist: "周杰伦",
      }),
      answer: jayChouSunny,
      expected: true,
    },
    {
      name: "答案是翻唱、猜的是原唱",
      guess: jayChouSunny,
      answer: song("netease:2653714443", "晴天 (女声版))", "GYBeat", {
        originCoverType: 2,
        originSongId: "netease:186016",
      }),
      expected: true,
    },
    {
      name: "两首翻唱指向同一首原曲",
      guess: song("netease:1", "晴天", "翻唱甲", { originSongId: "netease:186016" }),
      answer: song("netease:2", "晴天 (钢琴版)", "翻唱乙", { originSongId: "netease:186016" }),
      expected: true,
    },
    {
      name: "回指的原曲是另一次上传，靠原曲歌手认出",
      guess: song("netease:3", "晴天", "翻唱甲", {
        originCoverType: 2,
        originSongId: "netease:999",
        originSongTitle: "晴天",
        originSongArtist: "周杰伦",
      }),
      answer: jayChouSunny,
      expected: true,
    },
    {
      name: "翻唱的是别人的同名歌",
      guess: song("netease:4", "Hello", "某翻唱", {
        originCoverType: 2,
        originSongId: "netease:33211676",
        originSongTitle: "Hello",
        originSongArtist: "OMFG",
      }),
      answer: song("netease:35847388", "Hello", "Adele", { originCoverType: 1 }),
      expected: false,
    },
    {
      name: "两位歌手各自的原创同名歌",
      guess: song("netease:247834", "Hello", "金海心", { originCoverType: 1 }),
      answer: song("netease:35847388", "Hello", "Adele", { originCoverType: 1 }),
      expected: false,
    },
    {
      name: "没有任何版本标记的同名歌不放行",
      guess: song("netease:3465688742", "晴天", "Lucky小爱", { originCoverType: 0 }),
      answer: jayChouSunny,
      expected: false,
    },
    {
      name: "平台标为改编、说不出原唱的同名版本",
      guess: song("netease:3455095614", "晴天 (弦乐版)", "球球忘不掉", { originCoverType: 3 }),
      answer: jayChouSunny,
      expected: true,
    },
    {
      name: "曲名里点名原唱",
      guess: song("netease:1945894789", "晴天 (钢琴版) [原唱: 周杰伦]", "纪钧瀚 (Bryan Chi)"),
      answer: jayChouSunny,
      expected: true,
    },
    {
      name: "曲名里点名的原唱对不上",
      guess: song("netease:5", "晴天 (翻自 别的歌手)", "某翻唱"),
      answer: jayChouSunny,
      expected: false,
    },
    {
      name: "通用曲名的来源不明版本不放行",
      guess: song("netease:6", "夜曲 (钢琴版)", "某钢琴"),
      answer: song("netease:7", "夜曲", "周杰伦", { originCoverType: 1 }),
      expected: false,
    },
    {
      name: "通用曲名但原唱对得上",
      guess: song("netease:8", "夜曲", "某翻唱", { originSongArtist: "周杰伦" }),
      answer: song("netease:7", "夜曲", "周杰伦", { originCoverType: 1 }),
      expected: true,
    },
    {
      name: "译名对得上的翻唱",
      guess: song("netease:9", "残酷天使的行动纲领", "某翻唱", { originCoverType: 2 }),
      answer: song("netease:10", "残酷な天使のテーゼ", "高橋洋子", {
        originCoverType: 1,
        aliases: ["残酷天使的行动纲领"],
      }),
      expected: true,
    },
    {
      name: "带编次的括号段区分不同的歌",
      guess: song("netease:11", "Song (Part 1) (Piano Ver.)", "某翻唱", { originCoverType: 2 }),
      answer: song("netease:12", "Song (Part 2)", "原唱"),
      expected: false,
    },
    {
      name: "波浪线紧贴曲名的版本后缀",
      guess: song("netease:13", "晴天～钢琴版～", "某钢琴"),
      answer: jayChouSunny,
      expected: true,
    },
    {
      name: "弹唱后缀（弾き語り）",
      guess: song("netease:14", "晴天 ～弾き語り～", "某弹唱"),
      answer: jayChouSunny,
      expected: true,
    },
    {
      name: "歌手缺失的普通上传不凭曲名放行",
      guess: song("netease:15", "Hello", "未知歌手"),
      answer: song("netease:35847388", "Hello", "Adele", { originCoverType: 1 }),
      expected: false,
    },
  ];

  test.each(cases)("$name", ({ guess, answer, expected }) => {
    expect(isSameWork(guess, answer, [])).toBe(expected);
    expect(isSameWork(answer, guess, [])).toBe(expected);
  });

  test("设置关闭时的严格判对不认翻唱", () => {
    expect(isSameAnswerSong(cases[0]!.guess, jayChouSunny, [])).toBe(false);
  });
});

describe("其他版本也算对：古典乐同一作品", () => {
  const opus9No2 = [
    song("netease:1060914", "Nocturne No. 2 in E Flat Major, Op. 9, No. 2", "Arthur Rubinstein", {
      originCoverType: 1,
      aliases: ["肖邦：降E大调夜曲，作品第9号第2首", "降E大调第2号夜曲，作品 9"],
    }),
    song("netease:82118", "夜曲，作品9，降E大调，第二号", "傅聪", {
      originCoverType: 2,
      aliases: ["Nocturne No.2 in E-flat major Op.9"],
    }),
    song("netease:117240", "Nocturne,Op.9,No.2", "李云迪", {
      originCoverType: 3,
      aliases: ["肖邦：夜曲，Op.9,No.2", "降E大调第2号夜曲，作品 9"],
    }),
    song("netease:1", "Nocturnes in E-Flat Major, Op. 9: II. Andante", "Some Pianist"),
    song("netease:1860596450", "肖邦: 夜曲作品9第2号 (钢琴)", "古典音乐诗", { originCoverType: 2 }),
  ];

  test("Op.9 No.2 的各种写法两两判为同一作品", () => {
    for (const left of opus9No2) {
      for (const right of opus9No2) expect(isSameWork(left, right, [])).toBe(true);
    }
  });

  const cases: Array<{
    name: string;
    guess: WorkComparableSong;
    answer: WorkComparableSong;
    expected: boolean;
  }> = [
    {
      name: "同调同体裁的另一首夜曲（Op.55 No.2）",
      guess: song("netease:473315919", "Nocturne No.16 in E flat Op.55 No.2", "Claudio Arrau", {
        aliases: ["降E大调第2号夜曲，作品 55"],
      }),
      answer: opus9No2[0]!,
      expected: false,
    },
    {
      name: "同一作品号的另一首（Op.9 No.1）",
      guess: song(
        "netease:1060910",
        "Nocturne No. 1 in B Flat Minor, Op. 9, No. 1",
        "Arthur Rubinstein",
        {
          aliases: ["肖邦：降B小调夜曲，作品第9号第1首", "降b小调第1号夜曲，作品 9"],
        }
      ),
      answer: opus9No2[3]!,
      expected: false,
    },
    {
      name: "月光奏鸣曲第一乐章：中文标题与英文全称",
      guess: song("netease:25729599", "月光奏鸣曲第一乐章", "Ludwig van Beethoven", {
        aliases: ["Piano Sonata No.14 in C-sharp minor Op.27: I. Adagio sostenuto Moonlight"],
      }),
      answer: song(
        "netease:25842621",
        'Sonata No. 14 in C-Sharp Minor, Op. 27 No. 2 "Moonlight": I. Adagio sostenuto',
        "Arthur Rubinstein"
      ),
      expected: true,
    },
    {
      name: "月光奏鸣曲第一乐章与第三乐章",
      guess: song(
        "netease:25842624",
        'Sonata No. 14 in C-Sharp Minor, Op. 27 No. 2 "Moonlight": III. Presto agitato',
        "Arthur Rubinstein"
      ),
      answer: song("netease:25729599", "月光奏鸣曲第一乐章", "Ludwig van Beethoven"),
      expected: false,
    },
    {
      name: "不同作曲家的 Op.27 No.2",
      guess: song("netease:2", "Nocturne No.8 in D-flat major, Op.27 No.2", "Arthur Rubinstein"),
      answer: song("netease:1434893542", "Moonlight Sonata", "Ludwig van Beethoven"),
      expected: false,
    },
    {
      name: "译名把 BWV 写成「作品」",
      guess: song("netease:5251167", "Cello Suite No.1, Prelude", "Johann Sebastian Bach", {
        originCoverType: 3,
        aliases: ["G大调第1号大提琴组曲，作品 1007 - 第1乐章“前奏曲”"],
      }),
      answer: song(
        "netease:1698603",
        "Cello Suite No. 1 in G Major, BWV 1007:I. Prélude",
        "马友友"
      ),
      expected: true,
    },
    {
      name: "同一组曲的另一乐章",
      guess: song(
        "netease:1501611",
        "Cello Suite No. 1 in G Major, BWV 1007:Allemande",
        "Janos Starker",
        {
          aliases: ["G大调第1号大提琴组曲，BWV1007-第2乐章“阿勒曼德舞曲”"],
        }
      ),
      answer: song(
        "netease:1698603",
        "Cello Suite No. 1 in G Major, BWV 1007:I. Prélude",
        "马友友"
      ),
      expected: false,
    },
    {
      name: "只写昵称但带作曲家",
      guess: song("netease:2147005422", "献给爱丽丝(贝多芬无损经典版)", "陈爱琳"),
      answer: song("netease:1944983536", "贝多芬 钢琴曲《致爱丽丝》", "天之籁音乐", {
        aliases: ["Piano Bagatelle in A minor WoO.59:   Für Elise"],
      }),
      expected: true,
    },
    {
      name: "德彪西《月光》：昵称、组曲全称与日文标题",
      guess: song("netease:1349806268", "德彪西-月光（Clair de Lune）", "ShJie__苦茶世界"),
      answer: song(
        "netease:1347650984",
        "ベルガマスククミキョク:Clair de lune, CD 82 No. 3",
        "郎朗",
        {
          aliases: ["III. 月光", "降D大调《贝加莫组曲》，L.75-第3首“月光”"],
        }
      ),
      expected: true,
    },
    {
      name: "同名流行歌不当成古典乐（毛不易《小狗圆舞曲》）",
      guess: song("netease:2626116892", "小狗圆舞曲", "毛不易", {
        originCoverType: 1,
        aliases: ["Puppy Waltz"],
      }),
      answer: song("netease:2132947392", "肖邦：小狗圆舞曲", "纯音乐钢琴曲", {
        aliases: ["Chopin：Minute Waltz, Op.64, No.1"],
      }),
      expected: false,
    },
    {
      name: "昵称与目录号互认（小狗圆舞曲 = Op.64 No.1）",
      guess: song("netease:2135514511", "小狗圆舞曲 肖邦", "古典留声机", { originCoverType: 2 }),
      answer: song(
        "netease:27708286",
        'Waltz No.6 in D Flat, Op.64 No.1 -"Minute"',
        "Claudio Arrau",
        {
          aliases: ["降D大调第1号圆舞曲，作品 64"],
        }
      ),
      expected: true,
    },
    {
      name: "通用的「作品 N」对专属目录号缺旁证时不论谁是答案都不定论",
      guess: song("netease:16", "作品 1007", "某演奏"),
      answer: song("netease:17", "BWV 1007", "另一演奏"),
      expected: false,
    },
  ];

  test.each(cases)("$name", ({ guess, answer, expected }) => {
    expect(isSameWork(guess, answer, [])).toBe(expected);
    expect(isSameWork(answer, guess, [])).toBe(expected);
  });

  test("平台把《离别曲》错回指到 Op.9 No.1 时以作品键为准", () => {
    const farewell = song("netease:1401237559", "肖邦: 离别曲", "Noble Kids Chorus", {
      originCoverType: 2,
      originSongId: "netease:1933996577",
      originSongTitle: "降B小调「夜曲」，作品 Op. 9，第一号",
      originSongArtist: "Frédéric François Chopin",
    });
    const opus9No1 = song(
      "netease:1933996577",
      "降B小调「夜曲」，作品 Op. 9，第一号",
      "Frédéric François Chopin"
    );
    const opus10No3 = song("netease:2122317326", "肖邦：离别曲，作品10-3", "纯音乐钢琴曲", {
      aliases: ["Chopin：Etude, Op.10, No.3, Tristesse"],
    });
    expect(isSameWork(farewell, opus9No1, [])).toBe(false);
    expect(isSameWork(farewell, opus10No3, [])).toBe(true);
  });
});

describe("其他版本也算对：房间设置", () => {
  const detailed = (
    id: string,
    title: string,
    artist: string,
    extra: Partial<SongDetails> = {}
  ) => ({
    ...makeSong(id, title, 2020),
    artist,
    ...extra,
  });

  const playRound = async (allowOtherVersions: boolean | undefined) => {
    const answer = detailed("answer", "晴天", "周杰伦", { originCoverType: 1 });
    const cover = detailed("netease:2668397359", "晴天 (原唱 周杰伦)", "RyaVocal", {
      originCoverType: 2,
      originSongId: "answer",
    });
    const musicProvider: MusicProvider = {
      search: async () => [],
      getSong: async () => answer,
      getSongMetadata: async () => cover,
      getLoginStatus: async (cookie) => ({ cookie, account: { nickname: "测试账号" } }),
    };
    const service = new SonGuessrService({ musicProvider, random: { nextInt: () => 0 } });
    const host = connection(service, "version-host");
    const guest = connection(service, "version-guest");
    await createRoom(service, host);
    const hostId = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState").playerId;
    await joinRoom(service, guest, "猜歌玩家");
    if (allowOtherVersions !== undefined) {
      await execute(service, host, {
        id: "version-settings",
        type: "song.room.updateSettings",
        roomId: "1234",
        payload: { allowOtherVersions },
      });
    }
    await startRound(service, host, guest, hostId);
    await execute(service, guest, {
      id: "version-audio",
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 1 },
    });
    return execute<{ attempt: { result: string } }>(service, guest, {
      id: "version-guess",
      type: "song.game.guess",
      roomId: "1234",
      payload: { songId: cover.id },
    });
  };

  test("缺省关闭：翻唱判错", async () => {
    await expect(playRound(undefined)).resolves.toMatchObject({ attempt: { result: "wrong" } });
  });

  test("开启后翻唱判对", async () => {
    await expect(playRound(true)).resolves.toMatchObject({ attempt: { result: "correct" } });
  });
});
