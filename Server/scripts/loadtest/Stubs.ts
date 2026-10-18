import type {
  CEEDataProvider,
  CEERawAppearance,
  CEERawCharacter,
} from "../../src/infrastructure/CEEData";
import type { BangumiDataProvider } from "../../src/infrastructure/LocalBangumiProvider";
import type {
  MusicCookieInput,
  MusicLoginSession,
  MusicProvider,
} from "../../src/infrastructure/NeteaseMusicProvider";
import type {
  CEEAppearance,
  CEECharacterSummary,
  CEECharacterView,
  CEEDirectoryResult,
  CEEExtraTagSection,
  CEESettings,
  CEESubjectSummary,
  SongDetails,
  SongLyricLine,
} from "../../src/shared/Index";

/**
 * 压测桩数据层：只替换「外部数据源」，不替换任何业务逻辑。
 *
 * 文本长度按线上真实快照量级合成（歌词 32 行、切片机选 5 行、角色介绍 150 字、标签 8 个），
 * 因为带宽与补丁体积由这些字段决定 —— 用空字符串会把吞吐上限测得虚高。
 */

const SONG_TITLES = [
  "夜晚的回声",
  "指尖的光",
  "无人应答的信",
  "第七个夏天",
  "逆行的鲸",
  "玻璃海",
  "风停在窗边",
  "未寄出的明信片",
  "长椅上的雪",
  "星期三的雨",
  "把月亮借给你",
  "南方的城",
  "过期罐头",
  "白色脚步声",
  "海底两万里",
  "迟到的春天",
];
const SONG_ARTISTS = [
  "河图",
  "陈绮贞",
  "TK from 凛として時雨",
  "Aimer",
  "YOASOBI",
  "花澤香菜",
  "周深",
  "藤原さくら",
  "米津玄師",
  "手嶌葵",
  "郁可唯",
  "Reol",
  "坂本真綾",
  "毛不易",
  "LiSA",
  "品冠",
];
const SONG_ALBUMS = [
  "夜的第七章",
  "遥远的你",
  "声音玩具",
  "时光机",
  "潮汐",
  "纸上雪",
  "未命名",
  "长镜头",
  "夏日最后的吻",
  "冬眠",
  "候鸟",
  "旧船票",
  "无人区",
  "银河",
  "回声",
  "慢灵魂",
];
const LYRIC_LINES = [
  "夜色落在你肩上",
  "风把云吹成形状",
  "我数着心跳走过",
  "那条没人的长廊",
  "灯一盏一盏亮起",
  "像星星掉进水里",
  "你说过的话还在",
  "停在半空的句点",
  "时间慢得看不见",
  "我们都忘了道别",
  "雨把街道洗干净",
  "却洗不掉那背影",
  "梦里的人醒不来",
  "醒来的人不回头",
  "我把歌声折起来",
  "夹进未寄的信",
  "窗外的树又高了一寸",
  "去年的雪还没化尽",
  "你说远方不远",
  "只是没有归期",
  "月光铺满空房间",
  "照不见你的脸",
  "我把名字念一遍",
  "像念一句咒语",
  "风停了",
  "云还在走",
  "我还站在这里",
  "你已经走远",
];
const SUBJECT_NAMES = [
  "四月是你的谎言",
  "紫罗兰永恒花园",
  "CLANNAD",
  "星际牛仔",
  "攻壳机动队",
  "玲音",
  "奇蛋物语",
  "比宇宙更远的地方",
  "白箱",
  "乒乓",
  "强风吹拂",
  "排球少年",
  "宝石之国",
  "来自深渊",
  "夏目友人帐",
  "虫师",
];
const CHARACTER_NAMES: [string, string][] = [
  ["宫水三叶", "Miyamizu Mitsuha"],
  ["薇尔莉特", "Violet Evergarden"],
  ["坂井悠二", "Sakai Yuji"],
  ["立华奏", "Tachibana Kanade"],
  ["阿尔托莉雅", "Artoria"],
  ["绫波丽", "Rei Ayanami"],
  ["五河士道", "Itsuka Shido"],
  ["牧濑红莉栖", "Makise Kurisu"],
  ["桐谷和人", "Kirito"],
  ["御坂美琴", "Misaka Mikoto"],
  ["长门有希", "Nagato Yuki"],
  ["晓美焰", "Akemi Homura"],
];
const TAG_POOL = [
  "日常",
  "战斗",
  "科幻",
  "校园",
  "治愈",
  "催泪",
  "运动",
  "音乐",
  "悬疑",
  "奇幻",
  "机战",
  "恋爱",
  "群像",
  "文艺",
  "推理",
  "冒险",
  "百合",
  "后宫",
  "历史",
  "社会",
];
const VOICE_ACTORS = [
  "早见沙织",
  "神谷浩史",
  "花澤香菜",
  "林原めぐみ",
  "山口勝平",
  "水樹奈々",
  "梶裕貴",
  "佐藤聡美",
];
const LONG_SUMMARY =
  "性格内向却极其认真的少女，习惯把情绪写进日记而不是说出口。转学到海滨小镇后，她在放学后的天文台结识了一群愿意听她把话说完的同伴，" +
  "也开始学着把自己的想法讲给别人听。她擅长在夜里独自校对乐谱，习惯用铅笔在谱面边缘画小小的星号作为提醒。";

const pick = <T>(pool: readonly T[], index: number): T =>
  pool[Math.abs(Math.trunc(index)) % pool.length]!;
const sliceTags = (offset: number, count: number): string[] =>
  Array.from({ length: count }, (_, index) => TAG_POOL[(offset + index) % TAG_POOL.length]!);

const lyricLine = (index: number): SongLyricLine => {
  const time = index * 4200;
  return { time, endTime: time + 3800, text: pick(LYRIC_LINES, index) };
};

const songOf = (songId: string): SongDetails => {
  const seed = Number.isNaN(Number(songId.replace(/\D/g, "")))
    ? songId.length * 31 + 1
    : Number(songId.replace(/\D/g, "")) || 1;
  const title = pick(SONG_TITLES, seed);
  return {
    id: songId,
    title,
    artist: pick(SONG_ARTISTS, seed * 3 + 1),
    album: pick(SONG_ALBUMS, seed * 5 + 2),
    pictureUrl: `https://p3.music.126.net/${(Math.abs(seed * 7919) % 1_000_000).toString(36)}/${seed}.jpg?param=300y300`,
    durationMs: 190_000 + (seed % 7) * 8_000,
    audioUrl: `https://m8.music.126.net/${(Math.abs(seed * 104_729) % 1_000_000).toString(36)}/${seed}.mp3?rsdtl=1&bitrate=320000`,
    lyrics: Array.from({ length: 32 }, (_, index) => lyricLine(index)),
    releaseYear: 2005 + (seed % 20),
    popularity: 40 + (seed % 60),
    language: seed % 3 === 0 ? "日语" : "国语",
    requiresVip: seed % 4 === 0,
    originCoverType: seed % 5 === 0 ? 1 : undefined,
    encyclopedia: {
      summary: LONG_SUMMARY,
      aliases: [`${title} (Live)`, `${title} 钢琴版`],
      tags: sliceTags(seed, 5),
    },
    chorus: { startTime: 78_000, endTime: 96_000 },
  };
};

const searchResultOf = (songId: string) => {
  const {
    lyrics: _lyrics,
    encyclopedia: _encyclopedia,
    chorus: _chorus,
    audioUrl: _audioUrl,
    ...rest
  } = songOf(songId);
  return rest;
};

const characterViewOf = (id: number): CEECharacterView => {
  const [nameCn, name] = pick(CHARACTER_NAMES, id);
  const appearances: CEEAppearance[] = Array.from({ length: 6 }, (_, index) => {
    const subject = pick(SUBJECT_NAMES, id + index);
    return {
      id: id * 100 + index,
      name: `${subject} ${index === 0 ? "TV" : "剧场版"}`,
      nameCn: subject,
      year: 2008 + ((id + index * 3) % 18),
      rating: Math.round((68 + ((id * 7 + index * 13) % 27)) * 10) / 10,
      ratingCount: 3_000 + ((id * 977 + index * 61) % 180_000),
    };
  });
  const extraTags: CEEExtraTagSection[] = [
    { section: "萌点", tags: sliceTags(id, 5) },
    { section: "属性", tags: sliceTags(id + 7, 5) },
  ];
  return {
    id,
    name,
    nameCn,
    imageUrl: `https://s3.picovideo.cc/subject/crt/${id}_large.jpg`,
    gender: id % 4 === 0 ? "male" : "female",
    popularity: 200 + ((id * 37) % 9_800),
    summary: LONG_SUMMARY,
    appearances,
    highestRating: appearances[0]!.rating,
    earliestAppearance: Math.min(...appearances.map((item) => item.year)),
    latestAppearance: Math.max(...appearances.map((item) => item.year)),
    subjectTags: sliceTags(id, 8),
    characterTags: sliceTags(id + 3, 8),
    voiceActors: VOICE_ACTORS.slice(id % 4, (id % 4) + 3),
    metaTags: id % 2 === 0 ? ["日韩动漫", "日本"] : ["日韩动漫", "日本", "TV"],
    comparisonAppearances: appearances
      .slice(0, 5)
      .map(({ id: appearanceId, name: appearanceName, nameCn: appearanceNameCn }) => ({
        id: appearanceId,
        name: appearanceName,
        nameCn: appearanceNameCn,
      })),
    extraTags,
  };
};

const subjectSummaryOf = (id: number): CEESubjectSummary => {
  const name = pick(SUBJECT_NAMES, id);
  return {
    id,
    name: `${name} 第${1 + (id % 3)}季`,
    nameCn: name,
    type: 2,
    year: 2008 + (id % 18),
    rating: Math.round((60 + (id % 38)) * 10) / 10,
    heat: 100 + ((id * 53) % 5_000),
    imageUrl: `https://s3.picovideo.cc/subject/${id}_grid.jpg`,
  };
};

const characterSummaryOf = (id: number): CEECharacterSummary => {
  const [nameCn, name] = pick(CHARACTER_NAMES, id);
  return { id, name, nameCn, imageUrl: `https://s3.picovideo.cc/crt/${id}.jpg` };
};

/** 猜歌链路：桩只回答「这首歌是什么」，判定与切片仍走真实服务。 */
export const createStubMusicProvider = (): MusicProvider => ({
  search: async (keyword, limit) =>
    Array.from({ length: Math.min(20, Math.max(1, limit ?? 20)) }, (_, index) =>
      searchResultOf(`netease:${keyword.length * 31 + index + 1}`)
    ),
  getSong: async (songId) => songOf(songId),
  getSongMetadata: async (songId) => songOf(songId),
  getSongPopularity: async (songId) => songOf(songId).popularity,
  getSongChorus: async (songId) => songOf(songId).chorus,
  refreshSongAudio: async (songId) => songOf(songId).audioUrl,
  getLoginStatus: async (
    cookie: string,
    platform?: "netease" | "qq"
  ): Promise<MusicLoginSession> => ({
    cookie,
    account: {
      platform: platform ?? "netease",
      userId: "10000",
      nickname: "压测账号",
      avatarUrl: "https://p1.music.126.net/avatar/10000.jpg",
      vipStatus: "vip",
      vipType: 110,
      vipTier: "svip",
      vipLevel: 9,
      vipYear: true,
    },
  }),
  getPlaylistSongs: async (playlistId: string, cookie?: MusicCookieInput) => {
    void cookie;
    const seed = Number(playlistId.replace(/\D/g, "")) || 1;
    return {
      info: { id: playlistId, name: "压测歌单", songCount: 40 },
      songs: Array.from({ length: 40 }, (_, index) => searchResultOf(`netease:${seed + index}`)),
    };
  },
  searchArtists: async (keyword) => [
    { id: "1", name: keyword, avatarUrl: "https://p1.music.126.net/avatar/1.jpg" },
  ],
  getArtistSongs: async (artistId) =>
    Array.from({ length: 20 }, (_, index) => searchResultOf(`netease:${artistId}${index}`)),
  searchAlbums: async (keyword) => [
    { id: "1", name: keyword, artist: pick(SONG_ARTISTS, 1), songCount: 12 },
  ],
  getAlbumSongs: async (albumId) =>
    Array.from({ length: 12 }, (_, index) => searchResultOf(`netease:${albumId}${index}`)),
});

/** 番剧条目桩：猜歌「按番出题」路径，字段量级对齐真实数据集。 */
export const createStubBangumiProvider = (): BangumiDataProvider => {
  const subjectOf = (subjectId: string) => {
    const numeric = Number(subjectId.replace(/\D/g, "")) || 1;
    const name = pick(SUBJECT_NAMES, numeric);
    return {
      id: subjectId,
      name,
      nameCn: name,
      imageUrl: `https://s3.picovideo.cc/subject/${subjectId}.jpg`,
      year: 2008 + (numeric % 18),
      rating: Math.round((65 + (numeric % 33)) * 10) / 10,
      ratingCount: 5_000 + ((numeric * 613) % 200_000),
      tags: sliceTags(numeric, 6),
      metaTags: ["日韩动漫", "日本", "TV"],
      summary: LONG_SUMMARY,
      musicTracks: Array.from({ length: 8 }, (_, index) => ({
        title: `${name} ${["OP", "ED", "IN", "IM"][index % 4]} ${1 + index}`,
        artist: pick(SONG_ARTISTS, numeric + index),
        kind: (index % 2 === 0 ? "opening" : "ending") as "opening" | "ending",
      })),
    };
  };
  return {
    searchSubjects: async (keyword, limit) => {
      const count = Math.min(10, Math.max(1, limit ?? 10));
      return Array.from({ length: count }, (_, index) => {
        const subject = subjectOf(`${keyword.length * 17 + index + 1}`);
        const { summary: _summary, musicTracks: _tracks, ...rest } = subject;
        return { ...rest, musicTracks: undefined };
      }).map(({ musicTracks: _musicTracks, ...rest }) => rest);
    },
    getSubject: async (subjectId) => subjectOf(subjectId),
    chooseRandomSubject: async (filters) =>
      subjectOf(`${Number(filters?.songMinPopularity ?? 0) + 7}`),
    resolveCharacterImage: async (characterId) =>
      `https://s3.picovideo.cc/crt/${characterId}_large.jpg`,
    resolveSubjectImage: async (subjectId) =>
      `https://s3.picovideo.cc/subject/${subjectId}_large.jpg`,
  };
};

/** 猜番数据桩：11 个方法全部返回真实量级的数据，避免把桩耗时算进服务端容量。 */
export const createStubCEEDataProvider = (): CEEDataProvider => ({
  searchCharacters: async (keyword, limit) =>
    Array.from({ length: Math.min(20, Math.max(1, limit ?? 20)) }, (_, index) =>
      characterSummaryOf(keyword.length * 101 + index + 1)
    ),
  searchSubjects: async (keyword, limit) =>
    Array.from({ length: Math.min(20, Math.max(1, limit ?? 20)) }, (_, index) =>
      subjectSummaryOf(keyword.length * 71 + index + 1)
    ),
  getSubjectCharacters: async (subjectId, limit) =>
    Array.from({ length: Math.min(20, Math.max(1, limit ?? 20)) }, (_, index) =>
      characterSummaryOf(subjectId * 13 + index + 1)
    ),
  getSubjects: async (subjectIds) => subjectIds.map(subjectSummaryOf),
  getRawCharacter: async (id): Promise<CEERawCharacter> => {
    const view = characterViewOf(id);
    const appearances: CEERawAppearance[] = view.appearances.map((appearance, index) => ({
      id: appearance.id,
      type: 2,
      name: appearance.name,
      nameCn: appearance.nameCn,
      date: `${appearance.year}-0${1 + (index % 9)}-01`,
      relationType: index === 0 ? 1 : 3,
      rating: appearance.rating,
      ratingCount: appearance.ratingCount,
      heat: 500 + index * 37,
      rawTags: Object.fromEntries(
        sliceTags(appearance.id, 6).map((tag, tagIndex) => [tag, tagIndex + 1])
      ),
      metaTags: ["日韩动漫", "日本"],
    }));
    return {
      id: view.id,
      name: view.name,
      nameCn: view.nameCn,
      imageUrl: view.imageUrl,
      aliases: [`${view.nameCn}（幼年）`, view.name],
      gender: view.gender,
      popularity: view.popularity,
      summary: view.summary,
      appearances,
      characterTags: view.characterTags,
      voiceActors: view.voiceActors,
      extraTagsBySubject: { [appearances[0]!.id]: view.extraTags },
    };
  },
  getCharacter: async (id) => characterViewOf(id),
  chooseRandomCharacter: async (settings: CEESettings, random?: () => number) => {
    void settings;
    const roll = Math.floor((random?.() ?? Math.random()) * 1_000);
    return characterViewOf(1_000 + roll);
  },
  importDirectory: async (indexId): Promise<CEEDirectoryResult> => ({
    id: indexId,
    subjectIds: Array.from({ length: 50 }, (_, item) => indexId * 100 + item),
    missingSubjectIds: [],
    importedAt: Date.now(),
  }),
  resolveCharacterImage: async (id, size = "large") =>
    `https://s3.picovideo.cc/crt/${id}_${size}.jpg`,
  resolveSubjectImage: async (id, size = "large") =>
    `https://s3.picovideo.cc/subject/${id}_${size}.jpg`,
  close: () => {},
});
