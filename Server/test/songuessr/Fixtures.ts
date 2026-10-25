import { SonGuessrService } from "../../src/application/SonGuessrService";
import { MusicProvider } from "../../src/infrastructure/NeteaseMusicProvider";
import {
  BangumiSubjectDetails,
  ConnectionRecord,
  SonGuessrClientMessage,
  SonGuessrPrivateState,
  type SongDetails,
} from "../../src/shared/Index";

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
  const record: ConnectionRecord = {
    id,
    lobbySubscribed: false,
    send: (payload) => sent.push(payload as TestConnection["sent"][number]),
    close: () => {},
  };
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
  submitterPlayerId: string
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
  await execute(service, host, {
    id: "submit",
    type: "song.game.submitSong",
    roomId: "1234",
    payload: { songId: "answer" },
  });
};

export const deferredServiceResult = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
