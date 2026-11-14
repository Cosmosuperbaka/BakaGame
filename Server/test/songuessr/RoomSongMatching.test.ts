import { describe, expect, test } from "bun:test";
import {
  albumNameScore,
  buildAlbumQueries,
  isSongTitleMatch,
} from "../../src/application/songuessr/SongTitleMatching";
import { BangumiSubjectDetails } from "../../src/shared/Index";

describe("SonGuessrService", () => {
  test("歌名匹配度门禁精准识别兼容版本并拒绝无关歌曲", () => {
    expect(isSongTitleMatch("答案歌", "答案歌")).toBe(true);
    expect(isSongTitleMatch("Cagayake!GIRLS [5人Ver.]", "Cagayake!GIRLS")).toBe(true);
    expect(isSongTitleMatch("だんご大家族", "メグメル／だんご大家族")).toBe(true);
    expect(
      isSongTitleMatch("TAKE ME HIGHER (コロムビア・カヴァー・ヴァージョン)", "石原立也")
    ).toBe(false);
    expect(isSongTitleMatch("战斗! 原始回归", "轻音少女")).toBe(false);
    expect(isSongTitleMatch("A", "B")).toBe(false);
    // 反向子串（候选是原名的截断）必须收紧：实测《いつだってYELL》匹配上 2026 年
    // 无关的《Yell》、《ぼくらは小さな悪魔》匹配上《ぼくら》，都因此把无关歌出了题。
    expect(isSongTitleMatch("Yell", "いつだってYELL")).toBe(false);
    expect(isSongTitleMatch("ぼくら", "ぼくらは小さな悪魔")).toBe(false);
    // 反向子串里「截断得不多」的仍要放行，避免误伤版本后缀差异。
    expect(isSongTitleMatch("Shooting Star", "Shooting Star 完整版")).toBe(true);
  });

  test("条目名内部的标点不构成「多曲并列」", () => {
    // 实测事故：条目 `CHAOS;CHILD AUDIO DRAMA & RADIO DIGEST VOL.1` 被 `;` / `&` 拆段后
    // 「chaos」成了一个合法段，毫不相关的《Chaos》(Parry Music) 靠这段匹配过了门禁 ——
    // 该番只有广播剧，本来就不该出题。
    expect(isSongTitleMatch("Chaos", "CHAOS;CHILD AUDIO DRAMA & RADIO DIGEST VOL.1")).toBe(false);
    expect(
      isSongTitleMatch("Chaos", "CHAOS;CHILD ドラマCD 〜拓留と世莉架は力士シールの夢を見るか?〜")
    ).toBe(false);
    // 真正的多曲并列（双 A 面 / 合作曲）仍必须放行。
    expect(isSongTitleMatch("だんご大家族", "メグメル／だんご大家族")).toBe(true);
    expect(isSongTitleMatch("ごはんはおかず", "ごはんはおかず/U&I")).toBe(true);
  });

  test("专辑名相似度认命名差异，但不认同番的其它专辑", () => {
    const animeNames = ["ひみつのアイプリ", "秘密的偶像公主"];
    const trackTitle =
      "TVアニメ『ひみつのアイプリ』キャラクターソングミニアルバム VERSE IN SONG 03";
    // 网易云的命名：少「キャラクターソングミニアルバム」、多「リング編」、「VERSEIN」还没空格。
    // 实测按条目名搜专辑返回 0 张，必须靠「番剧名 + 特征词」认出来（否则该条目永远零候选）。
    const sameSeries = "TVアニメ『ひみつのアイプリ リング編』VERSEIN SONG 03";
    expect(albumNameScore(sameSeries, trackTitle, animeNames)).toBeGreaterThan(0);
    // 同系列只差一个序号的邻张，分数必须更低 —— 否则会抽到隔壁那张的歌。
    const sibling =
      "TVアニメ『ひみつのアイプリ リング編』キャラクターソングミニアルバム VERSE IN SONG 02";
    expect(albumNameScore(sibling, trackTitle, animeNames)).toBeLessThan(
      albumNameScore(sameSeries, trackTitle, animeNames)
    );
    // 全等最高，互相包含次之（原有宽松档保留）。
    expect(albumNameScore("勇者", "勇者")).toBe(100);
    expect(albumNameScore("君の名は。 オリジナルサウンドトラック", "君の名は。")).toBeGreaterThan(
      0
    );
    // 番剧名对不上的其它作品专辑：只共享「キャラクターソング集」这种通用词也不算。
    expect(
      albumNameScore(
        "TVアニメ『别部番』キャラクターソング集",
        "TVアニメ『本番』キャラクターソング集",
        ["本番"]
      )
    ).toBe(0);
    // 不含番剧名的同名短专辑不该被认（旧的长度比例判据会误判）。
    expect(albumNameScore("另一部番 OST", "角色歌合辑", animeNames)).toBe(0);
  });

  test("专辑名恰好等于番剧名时不给分：同名撞车的「互相包含」是结构性必然", () => {
    // 实测事故：网易云用户自建的《青春ブタ野郎はバニーガール先輩の夢を見ない》（梁神，
    // 一首同名说唱）在专辑检索里靠「互相包含」拿到 60 分，压过官方《… 4 Special CD》
    // （35 分），被当成特典 CD 的曲目出了题。番剧名与条目名互为前缀时这条证据恒真。
    const entry = "青春ブタ野郎はバニーガール先輩の夢を見ない 特典CD Vol.4";
    const animeNames = [
      "青春ブタ野郎はバニーガール先輩の夢を見ない",
      "青春猪头少年不会梦到兔女郎学姐",
    ];
    expect(albumNameScore("青春ブタ野郎はバニーガール先輩の夢を見ない", entry, animeNames)).toBe(0);
    // 歌手与条目记录对得上时仍认：官方同名盘不能被这条规则连坐。
    expect(
      albumNameScore("青春ブタ野郎はバニーガール先輩の夢を見ない", entry, animeNames, true)
    ).toBeGreaterThan(0);
    // 带发行上下文（特典 CD / 原声带 / アニメ…）的同名盘照旧认。
    expect(
      albumNameScore("青春ブタ野郎はバニーガール先輩の夢を見ない 特典CD", entry, animeNames)
    ).toBeGreaterThan(0);
    // 条目名与专辑名全等时不受影响（官方盘点名就是作品名，如《君の名は。》）。
    expect(albumNameScore("君の名は。", "君の名は。", ["君の名は。"])).toBe(100);
  });

  test("专辑型条目的检索词覆盖番剧名与类型关键词", () => {
    const anime = { name: "ひみつのアイプリ", nameCn: "秘密的偶像公主" } as BangumiSubjectDetails;
    const queries = buildAlbumQueries(
      {
        title: "TVアニメ『ひみつのアイプリ』キャラクターソングミニアルバム VERSE IN SONG 03",
        kind: "character",
      },
      anime
    );
    // 条目名原样
    expect(queries).toContain(
      "TVアニメ『ひみつのアイプリ』キャラクターソングミニアルバム VERSE IN SONG 03"
    );
    // 剥掉番剧名包裹后的余部（网易云的专辑名多接近这一形态）
    expect(queries).toContain("キャラクターソングミニアルバム VERSE IN SONG 03");
    // 番剧名 + 类型关键词、以及裸番剧名（实测只有它能搜到该系列专辑）
    expect(queries).toContain("ひみつのアイプリ キャラクターソング");
    expect(queries).toContain("ひみつのアイプリ");
    expect(queries).toContain("秘密的偶像公主");

    const cluster = buildAlbumQueries(
      { title: "「クラスターエッジ」キャラクターコレクション", kind: "character" },
      { name: "CLUSTER EDGE", nameCn: "克拉斯特学院" } as BangumiSubjectDetails
    );
    // 番剧的日文片假名搜不到任何东西，但原名 / 中文名能搜出该番的歌
    expect(cluster).toContain("CLUSTER EDGE");
    expect(cluster).toContain("克拉斯特学院");
  });
});
