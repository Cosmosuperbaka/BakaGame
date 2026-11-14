import { AppError } from "../../src/domain/Errors";
import { describe, expect, test } from "bun:test";
import { SonGuessrService } from "../../src/application/SonGuessrService";
import {
  SonGuessrPrivateState,
  detectExplicitTrackKind,
  detectTrackKindFromText,
  refineTrackKindByText,
  type SonGuessrRoomSnapshot,
} from "../../src/shared/Index";
import {
  anime,
  connection,
  createRoom,
  execute,
  joinRoom,
  lastEvent,
  provider,
  songs,
} from "./Fixtures";
import { type BangumiDataProvider } from "../../src/infrastructure/BangumiDataProvider";
import { type MusicProvider } from "../../src/infrastructure/music/MusicProvider";
import { fakeBangumiProvider } from "../support/Providers";

describe("SonGuessrService 猜番曲目类型校准", () => {
  /**
   * 手动出题后推进到回合结算，返回包含关联歌曲详情的结算摘要。
   * 曲目类型只在结算摘要里公开（出题阶段的快照只带音频地址）。
   */
  const animeRoundSummary = async (
    musicProvider: MusicProvider,
    bangumiProvider: BangumiDataProvider,
    guessedSubjectId: string
  ) => {
    const service = new SonGuessrService({ musicProvider, bangumiProvider });
    const host = connection(service, `anime-kind-host-${Math.random().toString(36).slice(2, 8)}`);
    const guest = connection(service, `anime-kind-guest-${Math.random().toString(36).slice(2, 8)}`);
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    await joinRoom(service, guest, "类型玩家");
    await execute(service, host, {
      id: "anime-kind-settings",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: { questionType: "anime" },
    });
    await execute(service, guest, {
      id: "anime-kind-ready",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
    await execute(service, host, {
      id: "anime-kind-start",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    });
    await execute(service, host, {
      id: "anime-kind-choose",
      type: "song.game.chooseSubmitter",
      roomId: "1234",
      payload: { playerId: hostState.playerId },
    });
    await execute(service, host, {
      id: "anime-kind-submit",
      type: "song.game.submitAnime",
      roomId: "1234",
      payload: { subjectId: anime.id },
    });
    await execute(service, guest, {
      id: "anime-kind-audio",
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 1 },
    });
    await execute(service, guest, {
      id: "anime-kind-guess",
      type: "song.game.guessAnime",
      roomId: "1234",
      payload: { subjectId: guessedSubjectId },
    });
    const snapshot = lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot");
    if (snapshot.phase !== "roundResult" || !snapshot.roundSummary) {
      throw new AppError("BANGUMI_NO_MUSIC", `回合未结算：${snapshot.phase}`);
    }
    return snapshot.roundSummary;
  };

  /** 直接校验歌曲元数据到曲目类型的映射，避免依赖出题随机性。 */
  test("detectExplicitTrackKind 识别片尾曲标注", () => {
    const song = {
      ...songs.answer,
      title: "喜劇《SPY×FAMILY》TV动画片尾曲)",
      album: "《间谍过家家》片尾曲ED",
    };
    expect(detectExplicitTrackKind(`${song.title} ${song.album}`)).toBe("ending");
  });

  test("片头曲与插入歌的中日文标注均可识别", () => {
    expect(
      detectExplicitTrackKind("ミックスナッツ (TVアニメ『SPY×FAMILY』オープニングテーマ)")
    ).toBe("opening");
    expect(detectExplicitTrackKind("片头曲「ミックスナッツ」")).toBe("opening");
    expect(detectExplicitTrackKind("第5话插入歌「TBD」")).toBe("insert");
    expect(detectExplicitTrackKind("劇中歌「TBD」")).toBe("insert");
  });

  test("普通歌名不会因出现 in 或 ed 片段被误判成插入歌或片尾曲", () => {
    expect(detectExplicitTrackKind("Dreaming")).toBeUndefined();
    expect(detectExplicitTrackKind("Inside Out")).toBeUndefined();
    expect(detectExplicitTrackKind("Redo")).toBeUndefined();
    expect(detectExplicitTrackKind("This Game")).toBeUndefined();
  });

  test("附带显式片尾曲标注的歌曲覆盖 Bangumi 的插曲类型", async () => {
    // 模拟 Bangumi 把片尾曲的专辑条目挂在「插入歌」下：不校准就会出现
    // 「片尾曲的歌配着插曲徽章」。
    const edSong = {
      ...songs.answer,
      id: "ed-song",
      title: "答案歌《答案番剧》TV动画片尾曲)",
      album: "《答案番剧》片尾曲ED",
    };
    const musicProvider: MusicProvider = {
      ...provider,
      search: async () => [edSong],
      getSong: async () => edSong,
    };
    const bangumiProvider = fakeBangumiProvider({
      getSubject: async () => ({
        ...anime,
        musicTracks: [{ title: "答案歌", artist: "测试歌手", kind: "insert" }],
      }),
      searchSubjects: async () => [anime],
    });

    const summary = await animeRoundSummary(musicProvider, bangumiProvider, anime.id);
    expect(summary.song.title).toBe(edSong.title);
    expect(summary.animeTrack?.kind).toBe("ending");
  });

  test("歌曲元数据无显式主题曲标注时保留 Bangumi 的原分类", async () => {
    const plainSong = { ...songs.answer, id: "plain-song", title: "答案歌", album: "答案专辑" };
    const musicProvider: MusicProvider = {
      ...provider,
      search: async () => [plainSong],
      getSong: async () => plainSong,
    };
    const bangumiProvider = fakeBangumiProvider({
      getSubject: async () => ({
        ...anime,
        musicTracks: [{ title: "答案歌", artist: "测试歌手", kind: "insert" }],
      }),
      searchSubjects: async () => [anime],
    });

    const summary = await animeRoundSummary(musicProvider, bangumiProvider, anime.id);
    expect(summary.animeTrack?.kind).toBe("insert");
  });

  test("番剧级兜底拿回的歌按歌曲自身推类型，不沿用条目的电台分类", async () => {
    // 条目是电台 CD（条目级检索必然落空），兜底按番剧名拿回的却是 OST 专辑里的曲目 ——
    // 类型跟条目走会显示成 Radio（实测《四月は君の嘘 第8巻 特典CD》就是这样）。
    const fallbackSong = {
      ...songs.answer,
      id: "fallback-ost",
      title: "答案歌",
      artist: "测试歌手",
      album: "答案番剧 オリジナルサウンドトラック",
      audioUrl: "https://audio/fallback-ost.mp3",
    };
    const musicProvider: MusicProvider = {
      ...provider,
      search: async () => [fallbackSong],
      getSong: async () => fallbackSong,
    };
    const bangumiProvider = fakeBangumiProvider({
      getSubject: async () => ({
        ...anime,
        musicTracks: [{ title: "ラジオCD 出張版 Vol.1", artist: "测试歌手", kind: "radio" }],
      }),
      searchSubjects: async () => [anime],
    });

    const summary = await animeRoundSummary(musicProvider, bangumiProvider, anime.id);
    expect(summary.animeTrack?.kind).toBe("ost");
  });
});
describe("SonGuessr 曲目类型细化：主题曲桶不得吞掉原声带与特典 CD", () => {
  test("带空格的 SOUND TRACK、特典 CD 不再标成主题曲", () => {
    // 用户截图反馈的三条：K-ON!! OST 的校歌、四月是你的谎言特典 CD 的 アゲイン、
    // 以及番剧级兜底召回的同名曲 —— 一律被标成「主题曲」。
    expect(
      refineTrackKindByText(
        "theme",
        "桜が丘女子高等学校校歌 百石元 K-ON!! ORIGINAL SOUND TRACK Vol.2"
      )
    ).toBe("ost");
    expect(refineTrackKindByText("theme", "アゲイン 横山克 四月は君の嘘 第3巻 特典CD")).toBe(
      "special"
    );
    expect(
      refineTrackKindByText(
        "theme",
        "不可思議のカルテ (桜島麻衣ソロVer.) 瀬戸麻沙美 青春ブタ野郎はバニーガール先輩の夢を見ない 1 Special CD"
      )
    ).toBe("special");
    // 真正的主题歌仍是主题曲。
    expect(refineTrackKindByText("theme", "残酷な天使のテーゼ")).toBe("theme");
    // 关系码已经给出具体类型时不被文本覆盖（片头 / 片尾 / 角色歌…）。
    expect(refineTrackKindByText("opening", "君のせい the peggies")).toBe("opening");
    expect(refineTrackKindByText("character", "キャラクターソング Vol.1")).toBe("character");
    // 显式标注优先于 Bangumi 的粗分类（既有语义：片尾曲的歌不能配插曲徽章）。
    expect(refineTrackKindByText("insert", "答案歌《答案番剧》TV动画片尾曲")).toBe("ending");
  });

  test("条目名里的广播剧 / 电台形态要分出来", () => {
    // 旧规则只认拉丁 `drama` / `radio`，满篇 `ドラマCD`「ラジオCD」全落进主题曲桶。
    expect(detectTrackKindFromText("ちょびっツ ドラマCD chapter.1")).toBe("drama");
    expect(detectTrackKindFromText("CLANNAD ラジオCD 渚と早苗のおまえにレインボー Vol.1")).toBe(
      "radio"
    );
    // 「ドラマチック」是正常曲名，不得误判成广播剧。
    expect(detectTrackKindFromText("ドラマチック")).toBeUndefined();
    // 原声带的关键词必须覆盖连写与带空格两种写法。
    expect(detectTrackKindFromText("君の名は。オリジナルサウンドトラック")).toBe("ost");
    expect(detectTrackKindFromText("K-ON!! ORIGINAL SOUND TRACK Vol.2")).toBe("ost");
    // 英文形态的广播剧 / 电台盘同样要分出来（CHAOS;CHILD 整条关联都是这类盘）。
    expect(detectTrackKindFromText("CHAOS;CHILD AUDIO DRAMA & RADIO DIGEST VOL.1")).toBe("drama");
    expect(detectTrackKindFromText("○○ RADIO DIGEST Vol.2")).toBe("radio");
  });
});
