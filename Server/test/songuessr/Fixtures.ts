import { SonGuessrService } from "../../src/application/SonGuessrService";
import { MusicProvider } from "../../src/infrastructure/music/MusicProvider";
import { type BangumiDataProvider } from "../../src/infrastructure/BangumiDataProvider";
import { type RandomSource } from "../../src/domain/Rules";
import {
  BangumiSubjectDetails,
  ConnectionRecord,
  SonGuessrClientMessage,
  SonGuessrPrivateState,
  type SongDetails,
  type SonGuessrRoomSnapshot,
} from "../../src/shared/Index";
import { createTestConnection } from "../support/Connection";

export const makeSong = (id: string, title: string, year: number): SongDetails => ({
  id,
  title,
  artist: "测试歌手",
  album: "测试专辑",
  pictureUrl: `https://img/${id}.jpg`,
  durationMs: 180_000,
  audioUrl: `https://audio/${id}.mp3`,
  lyrics: Array.from({ length: 8 }, (_, index) => ({
    time: (index + 1) * 1_000,
    endTime: (index + 2) * 1_000,
    text: `歌词${index + 1}`,
  })),
  releaseYear: year,
  popularity: id === "answer" ? 90 : 60,
  language: "国语",
  encyclopedia: { summary: "百科", tags: ["流行", id] },
  chorus: { startTime: 50_000, endTime: 90_000 },
});

export const songs = {
  answer: makeSong("answer", "答案歌", 2022),
  wrong: makeSong("wrong", "错误歌", 2018),
};

export const anime: BangumiSubjectDetails = {
  id: "anime-answer",
  name: "Answer Anime",
  nameCn: "答案番剧",
  imageUrl: "https://img.example/anime.jpg",
  year: 2024,
  rating: 8.8,
  ratingCount: 1200,
  tags: ["奇幻"],
  metaTags: ["动画"],
  summary: "测试番剧简介",
  musicTracks: [{ title: "答案歌", artist: "测试歌手", kind: "opening" }],
};

export const wrongAnime: BangumiSubjectDetails = {
  ...anime,
  id: "anime-wrong",
  name: "Wrong Anime",
  nameCn: "错误番剧",
};

export const provider: MusicProvider = {
  search: async () => [songs.answer, songs.wrong],
  getSong: async (id) => songs[id as keyof typeof songs],
  getSongMetadata: async (id) => songs[id as keyof typeof songs],
  getLoginStatus: async (cookie) => ({
    cookie,
    account: { nickname: "测试账号", vipStatus: "vip" },
  }),
};

export interface TestConnection {
  record: ConnectionRecord;
  sent: Array<{ type?: string; event?: string; payload?: unknown }>;
}

export const connection = (service: SonGuessrService, id: string): TestConnection => {
  const sent: TestConnection["sent"] = [];
  const record = createTestConnection(id, {
    send: (payload) => sent.push(payload as TestConnection["sent"][number]),
  });
  service.registerConnection(record);
  return { record, sent };
};

export const execute = <T = unknown>(
  service: SonGuessrService,
  client: TestConnection,
  message: SonGuessrClientMessage
): Promise<T> => service.execute(client.record.id, message) as Promise<T>;

export const lastEvent = <T>(client: TestConnection, event: string): T =>
  client.sent.filter((item) => item.type === "event" && item.event === event).at(-1)!.payload as T;

/**
 * 本回合选中的是哪首歌：直接读服务端回合记录。快照里的播放地址是不透明地址，
 * 不能当作「选了哪首歌」的凭据，测试判定选曲只认歌曲标识。
 */
export const chosenSongId = (service: SonGuessrService, roomId: string): string | undefined =>
  service.rooms.get(roomId)?.currentRound?.song.id;

/** 快照里站内播放地址的最后一段：票据。地址形态不对就当场失败。 */
export const audioTicketOf = (snapshot: SonGuessrRoomSnapshot): string => {
  const audioUrl = snapshot.currentRound?.audioUrl;
  const match = audioUrl?.match(/\/api\/songuessr\/audio\/[^/]+\/([^/?#]+)$/);
  if (!match) throw new Error(`播放地址不是站内票据地址：${audioUrl}`);
  return match[1]!;
};

export const createRoom = async (
  service: SonGuessrService,
  host: TestConnection,
  overrides: Partial<Extract<SonGuessrClientMessage, { type: "song.room.create" }>["payload"]> = {}
) => {
  const created = await execute(service, host, {
    id: "create",
    type: "song.room.create",
    payload: {
      roomId: "1234",
      name: "猜歌房",
      visibility: "public",
      allowSpectators: true,
      userName: "房主",
      ...overrides,
    },
  });
  await execute(service, host, {
    id: "host-account",
    type: "song.auth.useCookie",
    roomId: overrides.roomId ?? "1234",
    payload: { cookie: "MUSIC_U=test-host" },
  });
  return created;
};

export const joinRoom = async (
  service: SonGuessrService,
  client: TestConnection,
  userName: string,
  roomId = "1234",
  password?: string
) => {
  await execute(service, client, {
    id: `join-${client.record.id}`,
    type: "song.room.join",
    roomId,
    payload: password ? { userName, password } : { userName },
  });
  return lastEvent<SonGuessrPrivateState>(client, "song.game.privateState");
};

export const startRound = async (
  service: SonGuessrService,
  host: TestConnection,
  guest: TestConnection,
  submitterPlayerId: string,
  songId = "answer"
) => {
  await execute(service, guest, {
    id: "ready",
    type: "song.player.setReady",
    roomId: "1234",
    payload: { ready: true },
  });
  await execute(service, host, {
    id: "start",
    type: "song.game.start",
    roomId: "1234",
    payload: {},
  });
  await execute(service, host, {
    id: "choose",
    type: "song.game.chooseSubmitter",
    roomId: "1234",
    payload: { playerId: submitterPlayerId },
  });
  return execute(service, host, {
    id: "submit",
    type: "song.game.submitSong",
    roomId: "1234",
    payload: { songId },
  });
};

export interface AnimeSoloOptions {
  musicProvider: MusicProvider;
  bangumiProvider: BangumiDataProvider;
  /** 连接 ID：同一用例里多次开局时用来区分连接。 */
  connectionId?: string;
  roomId?: string;
  random?: RandomSource;
  /** false 时只建好番剧单人房并切到番剧题库，由调用方自己发开局命令。 */
  start?: boolean;
}

/** 单人房切番剧题库（缺省直接开局），返回服务、连接与本局选中的歌曲 ID。 */
export const startAnimeSolo = async ({
  musicProvider,
  bangumiProvider,
  connectionId = "anime-solo",
  roomId = "8888",
  random = { nextInt: () => 0 },
  start = true,
}: AnimeSoloOptions) => {
  const service = new SonGuessrService({ musicProvider, bangumiProvider, random });
  const solo = connection(service, connectionId);
  await createRoom(service, solo, {
    roomId,
    name: "猜番单人",
    userName: "独狼",
    solo: true,
  });
  await execute(service, solo, {
    id: "anime-solo-settings",
    type: "song.room.updateSettings",
    roomId,
    payload: { questionType: "anime" },
  });
  if (start) {
    await execute(service, solo, {
      id: "anime-solo-start",
      type: "song.game.start",
      roomId,
      payload: {},
    });
  }
  return {
    service,
    solo,
    chosenId: start ? chosenSongId(service, roomId) : undefined,
  };
};
