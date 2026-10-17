import { describe, expect, it, mock, afterEach } from "bun:test";
import { QQMusicProvider, stripHtmlTags, parseQrcLyrics, parseLrcLyrics } from "../src/infrastructure/QQMusicProvider";
import qqmusic from "qqmusic-api-enhanced";

const originals = {
  search: qqmusic.search,
  login_status: qqmusic.login_status,
  login_refresh: qqmusic.login_refresh,
  song_detail: qqmusic.song_detail,
  song_url: qqmusic.song_url,
  lyric: qqmusic.lyric,
  playlist_detail: qqmusic.playlist_detail,
  playlist_track_all: qqmusic.playlist_track_all,
  artist_songs: qqmusic.artist_songs,
  login_qr_create: qqmusic.login_qr_create,
  login_qr_check: qqmusic.login_qr_check,
};

const restore = () => Object.assign(qqmusic, originals);

afterEach(restore);

/** 让 provider 永远不真的打 AMLL 公网：注入总是失败/返回空的 fetcher。 */
const offlineAmll = {
  amllFetcher: async () => {
    throw new Error("network down");
  },
  fetchAmllLyrics: async () => undefined,
  fetchAmllSearchLyrics: async () => undefined,
};

const LRC = "[00:01.00]第一句\n[00:03.50]第二句";

describe("QQMusicProvider · 歌词解析纯函数", () => {
  it("parseLrcLyrics 解析时间轴、翻译与罗马音", () => {
    const raw = "[00:01.00]Hello\n[00:02.00]你好\n[00:03.00]こんにちは";
    const lines = parseLrcLyrics(raw);
    expect(lines.length).toBe(3);
    expect(lines[0].time).toBe(1000);
    expect(lines[0].text).toBe("Hello");
  });

  it("parseLrcLyrics 空输入与解析异常都返回空数组", () => {
    expect(parseLrcLyrics("")).toEqual([]);
    expect(parseLrcLyrics("   ")).toEqual([]);
    expect(parseLrcLyrics("这不是歌词")).toEqual([]);
  });

  it("parseQrcLyrics 空输入返回空数组", () => {
    expect(parseQrcLyrics("")).toEqual([]);
    expect(parseQrcLyrics("   ")).toEqual([]);
  });

  it("parseQrcLyrics 解析逐字歌词（含逐字时间轴）", () => {
    // QQ 音乐逐字段落格式：[行起始,行时长]字1(起,长)字2(起,长)
    const qrc = "[0,500]晴(0,250)天(250,250)\n";
    const lines = parseQrcLyrics(qrc);
    expect(lines.length).toBe(1);
    expect(lines[0].text).toBe("晴天");
    expect(lines[0].words?.length).toBe(2);
    expect(lines[0].words?.[0].word).toBe("晴");
  });

  it("parseQrcLyrics 忽略空行与无文字行", () => {
    const qrc = "[0,500]晴(0,250)天(250,250)\n[500,100]\n";
    const lines = parseQrcLyrics(qrc);
    expect(lines.length).toBe(1);
  });

  it("parseQrcLyrics 兼容 XML 包裹的 QRC（剥出 LyricContent 并还原换行）", () => {
    const xml = `<?xml version="1.0"?><QrcInfos><LyricInfo><Lyric_1 LyricContent="[0,500]晴(0,250)天(250,250)\\n[500,500]雨(0,250)天(250,250)\\n"/></LyricInfo></QrcInfos>`;
    const lines = parseQrcLyrics(xml);
    expect(lines.length).toBe(2);
    expect(lines[0].text).toBe("晴天");
    expect(lines[1].text).toBe("雨天");
  });
});

describe("QQMusicProvider · search 字段映射与降级", () => {
  it("空关键词直接返回空数组，不触发上游", async () => {
    const provider = new QQMusicProvider();
    const spy = mock(async () => ({ status: 200, body: {} }));
    qqmusic.search = spy as any;
    expect(await provider.search("   ")).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("兼容多种响应形状（body.songs / data.body.item_song）并映射 VIP 与封面", async () => {
    const provider = new QQMusicProvider();
    qqmusic.search = mock(async () => ({
      status: 200,
      body: {
        songs: [
          {
            mid: "001",
            title: "<em>夜曲</em>",
            singer: [{ name: "周杰伦" }, { name: "费玉清" }],
            album: { id: 1234, name: "十一月的萧邦" },
            interval: 227,
            pay: { pay_play: 1 },
          },
        ],
      },
    })) as any;

    const res = await provider.search("夜曲", 10);
    expect(res).toHaveLength(1);
    expect(res[0].id).toBe("qq:001");
    expect(res[0].title).toBe("夜曲");
    expect(res[0].artist).toBe("周杰伦 / 费玉清");
    expect(res[0].album).toBe("十一月的萧邦");
    expect(res[0].durationMs).toBe(227000);
    expect(res[0].requiresVip).toBe(true);
    // 封面路径按 albumId % 100 分桶
    expect(res[0].pictureUrl).toContain("/34/500_albumpic_1234_0.jpg");
  });

  it("singer 为字符串或缺失时回退「未知歌手」，且过滤掉缺 id/title 的项", async () => {
    const provider = new QQMusicProvider();
    qqmusic.search = mock(async () => ({
      status: 200,
      body: {
        songs: [
          { mid: "002", title: "有歌名", singer: "某歌手" },
          { mid: "", title: "无 mid" },
          { mid: "003", title: "" },
        ],
      },
    })) as any;

    const res = await provider.search("x", 10);
    expect(res).toHaveLength(1);
    expect(res[0].artist).toBe("某歌手");

    qqmusic.search = mock(async () => ({ status: 200, body: { songs: [{ mid: "004", title: "T" }] } })) as any;
    const res2 = await provider.search("y", 10);
    expect(res2[0].artist).toBe("未知歌手");
  });

  it("同名同 limit 第二次请求命中缓存，不再打上游", async () => {
    const provider = new QQMusicProvider();
    let calls = 0;
    qqmusic.search = mock(async () => {
      calls++;
      return { status: 200, body: { songs: [{ mid: "005", title: "缓存" }] } };
    }) as any;

    await provider.search("缓存测试", 5);
    await provider.search("缓存测试", 5);
    expect(calls).toBe(1);
  });
});

describe("QQMusicProvider · 歌曲 ID（URN）校验", () => {
  it("拒绝空 ID、非 qq 平台 URN，接受裸 mid 与 qq URN", async () => {
    const provider = new QQMusicProvider();
    await expect(provider.getSongMetadata("")).rejects.toThrow();
    await expect(provider.getSongMetadata("netease:123")).rejects.toThrow();
  });
});

describe("QQMusicProvider · getSongMetadata", () => {
  it("解析曲目字段并回填歌词（QRC 优先）", async () => {
    const provider = new QQMusicProvider(offlineAmll);
    qqmusic.song_detail = mock(async () => ({
      status: 200,
      body: {
        data: {
          track_info: {
            name: "反方向的钟",
            singer: [{ name: "周杰伦" }],
            album: { id: 55, name: "范特西" },
            interval: 258,
            time_public: "2001-09-14",
          },
        },
      },
    })) as any;
    qqmusic.lyric = mock(async () => ({
      status: 200,
      body: { lyric: `<?xml version="1.0"?><QrcInfos><LyricInfo><Lyric_1 LyricContent="[0,500]回到(0,250)过去(250,250)\\n"/></LyricInfo></QrcInfos>` },
    })) as any;

    const meta = await provider.getSongMetadata("qq:0017K7gL4WYnw2");
    expect(meta.title).toBe("反方向的钟");
    expect(meta.artist).toBe("周杰伦");
    expect(meta.album).toBe("范特西");
    expect(meta.releaseYear).toBe(2001);
    expect(meta.lyrics.length).toBeGreaterThan(0);
  });

  it("查无此曲时抛 INVALID_SONG", async () => {
    const provider = new QQMusicProvider(offlineAmll);
    qqmusic.song_detail = mock(async () => ({ status: 200, body: { data: { track_info: {} } } })) as any;
    await expect(provider.getSongMetadata("qq:nope")).rejects.toThrow();
  });

  it("元数据第二次请求命中缓存", async () => {
    const provider = new QQMusicProvider(offlineAmll);
    let calls = 0;
    qqmusic.song_detail = mock(async () => {
      calls++;
      return { status: 200, body: { data: { track_info: { name: "T", singer: [{ name: "A" }] } } } };
    }) as any;
    qqmusic.lyric = mock(async () => ({ status: 200, body: { lyric: LRC } })) as any;

    await provider.getSongMetadata("qq:cache1");
    await provider.getSongMetadata("qq:cache1");
    expect(calls).toBe(1);
  });
});

describe("QQMusicProvider · 歌词三级降级", () => {
  it("QRC 缺失时降级到普通 LRC", async () => {
    const provider = new QQMusicProvider(offlineAmll);
    qqmusic.song_detail = mock(async () => ({
      status: 200,
      body: { data: { track_info: { name: "LRC歌", singer: [{ name: "A" }] } } },
    })) as any;
    qqmusic.lyric = mock(async () => ({ status: 200, body: { lyric: LRC } })) as any;

    const meta = await provider.getSongMetadata("qq:lrc1");
    expect(meta.lyrics.length).toBe(2);
    expect(meta.lyrics[0].text).toBe("第一句");
  });

  it("歌词接口异常时返回空歌词而非整体失败", async () => {
    const provider = new QQMusicProvider(offlineAmll);
    qqmusic.song_detail = mock(async () => ({
      status: 200,
      body: { data: { track_info: { name: "无词歌", singer: [{ name: "A" }] } } },
    })) as any;
    qqmusic.lyric = mock(async () => {
      throw new Error("lyric api down");
    }) as any;

    const meta = await provider.getSongMetadata("qq:nolyric");
    expect(meta.lyrics).toEqual([]);
  });

  it("注入的 fetchAmllLyrics 优先于公网请求，并按 mid 缓存", async () => {
    let calls = 0;
    const provider = new QQMusicProvider({
      fetchAmllLyrics: async () => {
        calls++;
        return undefined;
      },
    });
    qqmusic.song_detail = mock(async () => ({
      status: 200,
      body: { data: { track_info: { name: "T", singer: [{ name: "A" }] } } },
    })) as any;
    qqmusic.lyric = mock(async () => ({ status: 200, body: { lyric: LRC } })) as any;

    await provider.getSongMetadata("qq:amll1");
    expect(calls).toBe(1);
  });
});

describe("QQMusicProvider · getSong 与音频直链", () => {
  it("320k 为空时降级到 128k 与 m4a，并且过滤 RS02 幽灵链接", async () => {
    const provider = new QQMusicProvider(offlineAmll);
    qqmusic.song_detail = mock(async () => ({
      status: 200,
      body: { data: { track_info: { name: "VIP歌", singer: [{ name: "A" }] } } },
    })) as any;
    qqmusic.lyric = mock(async () => ({ status: 200, body: { lyric: LRC } })) as any;

    const urlCalls: string[] = [];
    qqmusic.song_url = mock(async ({ type }: any) => {
      urlCalls.push(type);
      if (type === "320") return { status: 200, body: { data: [{ url: "" }] } };
      if (type === "128") return { status: 200, body: { data: [{ url: "https://ws.stream.qqmusic.qq.com/RS02_fake.mp3" }] } }; // 模拟 RS02 幽灵链接被过滤
      if (type === "m4a") return { status: 200, body: { data: [{ url: "https://cdn.example/valid.m4a" }] } };
      return { status: 200, body: { data: [{}] } };
    }) as any;

    const song = await provider.getSong("qq:multi_tier", "uin=123");
    expect(song.audioUrl).toBe("https://cdn.example/valid.m4a");
    expect(urlCalls).toEqual(["320", "128", "m4a"]);
  });

  it("直链与试听都为空时抛 SONG_UNAVAILABLE", async () => {
    const provider = new QQMusicProvider(offlineAmll);
    qqmusic.song_detail = mock(async () => ({
      status: 200,
      body: { data: { track_info: { name: "无音", singer: [{ name: "A" }] } } },
    })) as any;
    qqmusic.lyric = mock(async () => ({ status: 200, body: { lyric: LRC } })) as any;
    qqmusic.song_url = mock(async () => ({ status: 200, body: { data: [{}] } })) as any;

    await expect(provider.getSong("qq:noaudio")).rejects.toThrow();
  });

  it("refreshSongAudio 绕过缓存重新取直链", async () => {
    const provider = new QQMusicProvider(offlineAmll);
    let n = 0;
    qqmusic.song_url = mock(async () => {
      n++;
      return { status: 200, body: { data: [{ url: `https://cdn.example/${n}.mp3` }] } };
    }) as any;

    const first = await provider.refreshSongAudio("qq:refresh1");
    const second = await provider.refreshSongAudio("qq:refresh1");
    expect(first).not.toBe(second);
    expect(n).toBe(2);
  });
});

describe("QQMusicProvider · 歌单 / 歌手 / 专辑", () => {
  it("getPlaylistSongs 提取纯数字 ID 并映射曲目", async () => {
    const provider = new QQMusicProvider();
    qqmusic.playlist_detail = mock(async () => ({
      status: 200,
      body: { dirinfo: { title: "我的歌单" } },
    })) as any;
    qqmusic.playlist_track_all = mock(async () => ({
      status: 200,
      body: { songs: [{ songmid: "101", songname: "<em>晴天</em>", singer: [{ name: "周杰伦" }], interval: 269 }] },
    })) as any;

    const { info, songs } = await provider.getPlaylistSongs("https://y.qq.com/n/ryqq/playlist/12345678");
    expect(info.name).toBe("我的歌单");
    expect(songs[0].id).toBe("qq:101");
    expect(songs[0].title).toBe("晴天");
    expect(info.songCount).toBe(1);
  });

  it("getPlaylistSongs 对无数字 ID 抛 INVALID_PLAYLIST", async () => {
    const provider = new QQMusicProvider();
    await expect(provider.getPlaylistSongs("abc")).rejects.toThrow();
  });

  it("searchArtists 映射歌手与头像", async () => {
    const provider = new QQMusicProvider();
    qqmusic.search = mock(async () => ({
      status: 200,
      body: { data: { body: { singer: [{ singerMID: "mid1", singerID: 7788, singerName: "周杰伦" }] } } },
    })) as any;

    const artists = await provider.searchArtists("周杰伦", 10);
    expect(artists[0].id).toBe("qq:mid1");
    expect(artists[0].name).toBe("周杰伦");
    expect(artists[0].avatarUrl).toContain("/88/300_singerpic_7788_0.jpg");
  });

  it("getArtistSongs 从 songInfo 嵌套结构映射曲目", async () => {
    const provider = new QQMusicProvider();
    qqmusic.artist_songs = mock(async () => ({
      status: 200,
      body: { songs: [{ songInfo: { mid: "201", name: "轨迹", singer: [{ name: "周杰伦" }], album: { id: 9, name: "寻找周杰伦" }, interval: 300 } }] },
    })) as any;

    const songs = await provider.getArtistSongs("qq:artist1");
    expect(songs[0].id).toBe("qq:201");
    expect(songs[0].title).toBe("轨迹");
    expect(songs[0].album).toBe("寻找周杰伦");
  });

  it("searchAlbums 映射专辑与曲目数", async () => {
    const provider = new QQMusicProvider();
    qqmusic.search = mock(async () => ({
      status: 200,
      body: { data: { body: { item_album: [{ albumMID: "alb1", albumID: 4321, albumName: "范特西", song_count: 10 }] } } },
    })) as any;

    const albums = await provider.searchAlbums("范特西", 5);
    expect(albums[0].id).toBe("qq:alb1");
    expect(albums[0].name).toBe("范特西");
    expect(albums[0].songCount).toBe(10);
  });
});

describe("QQMusicProvider · 扫码登录", () => {
  it("createQrLogin 支持 qq / wx / mobile 三种类型", async () => {
    const provider = new QQMusicProvider();
    qqmusic.login_qr_create = mock(async ({ type }: any) => ({
      status: 200,
      body:
        type === "qq"
          ? { qrsig: "sig", ptqrtoken: 123, url: "https://qr", qrimg: "data:img" }
          : type === "wx"
            ? { uuid: "uuid-1" }
            : { qrcodeID: "qc-1", qrcode: "data:qc" },
    })) as any;

    const qq = await provider.createQrLogin("qq", "qq");
    expect(qq.key).toBe("sig:::123");
    expect(qq.qrUrl).toBe("https://qr");

    const wx = await provider.createQrLogin("qq", "wx");
    expect(wx.key).toBe("uuid-1");

    const mob = await provider.createQrLogin("qq", "mobile");
    expect(mob.key).toBe("qc-1");
  });

  it("checkQrLogin 覆盖等待 / 已扫码 / 过期 / 成功四态", async () => {
    const provider = new QQMusicProvider();
    qqmusic.login_status = mock(async () => ({
      status: 200,
      body: { isLogin: true, account: { userId: "1", nickname: "淋雨之前" } },
    })) as any;

    qqmusic.login_qr_check = mock(async () => ({ status: 200, body: { code: 801 } })) as any;
    expect((await provider.checkQrLogin("sig:::123", "qq", "qq")).status).toBe("waiting");

    qqmusic.login_qr_check = mock(async () => ({ status: 200, body: { code: 802 } })) as any;
    expect((await provider.checkQrLogin("sig:::123", "qq", "qq")).status).toBe("scanned");

    qqmusic.login_qr_check = mock(async () => ({ status: 200, body: { code: 800 } })) as any;
    expect((await provider.checkQrLogin("sig:::123", "qq", "qq")).status).toBe("expired");

    qqmusic.login_qr_check = mock(async () => ({ status: 200, body: { code: 200, cookieStr: "qm_keyst=abc" } })) as any;
    const ok = await provider.checkQrLogin("sig:::123", "qq", "qq");
    expect(ok.status).toBe("authorized");
    expect(ok.session?.account.nickname).toBe("淋雨之前");
  });
});

describe("QQMusicProvider · getLoginStatus 刷新降级", () => {
  it("首次未登录时尝试 login_refresh，刷新后取到新 Cookie 与账号", async () => {
    const provider = new QQMusicProvider();
    let statusCalls = 0;
    qqmusic.login_status = mock(async ({ cookie }: any) => {
      statusCalls++;
      if (cookie === "old_cookie") return { status: 200, body: { isLogin: false } };
      return {
        status: 200,
        body: { isLogin: true, account: { userId: "9", nickname: "刷新后", vipLevel: 8 } },
      };
    }) as any;
    qqmusic.login_refresh = mock(async () => ({ status: 200, body: { cookieStr: "new_cookie" } })) as any;

    const session = await provider.getLoginStatus("old_cookie");
    expect(session.cookie).toBe("new_cookie");
    expect(session.account.nickname).toBe("刷新后");
    expect(session.account.vipLevel).toBe(8);
    expect(statusCalls).toBe(2);
  });

  it("login_refresh 刷新后仍未登录或抛异常时，严格抛出 MUSIC_SESSION_INVALID", async () => {
    const provider = new QQMusicProvider();
    qqmusic.login_status = mock(async () => ({
      status: 200,
      body: { isLogin: false, account: { nickname: "匿名" } },
    })) as any;
    qqmusic.login_refresh = mock(async () => {
      throw new Error("refresh down");
    }) as any;

    await expect(provider.getLoginStatus("some_cookie")).rejects.toThrow("QQ 音乐登录状态已失效");
  });

  it("未登录的会话不写缓存，每次都重新探测并抛出异常", async () => {
    const provider = new QQMusicProvider();
    let calls = 0;
    qqmusic.login_status = mock(async () => {
      calls++;
      return { status: 200, body: { isLogin: false, account: {} } };
    }) as any;
    qqmusic.login_refresh = mock(async () => ({ status: 200, body: {} })) as any;

    await expect(provider.getLoginStatus("nocache")).rejects.toThrow("QQ 音乐登录状态已失效");
    await expect(provider.getLoginStatus("nocache")).rejects.toThrow("QQ 音乐登录状态已失效");
    expect(calls).toBe(2);
  });
});

describe("QQMusicProvider · stripHtmlTags", () => {
  it("非字符串输入返回空串", () => {
    expect(stripHtmlTags(123 as any)).toBe("");
    expect(stripHtmlTags({} as any)).toBe("");
  });
});
