import { describe, expect, test } from "bun:test";

import { idsOf, lastPayloadOf, mcpFixture, payloadOf, typesOf } from "./McpFixtures";

const player = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  name: id === "p1" ? "房主" : "对手",
  score: 0,
  team: null,
  membership: "active",
  online: true,
  isReady: true,
  isBot: false,
  isHost: id === "p1",
  roundStatus: "guessing",
  guessesUsed: 0,
  correctGuesses: 0,
  totalGuesses: 0,
  ...overrides,
});

const round = {
  roundNumber: 3,
  submitterPlayerId: "p2",
  audioUrl: "https://audio.example/3.mp3",
  lyricClip: {
    startTime: 1000,
    endTime: 16000,
    lines: [{ time: 1000, text: "歌词" }],
  },
};

const songSnapshot = (phase: string, overrides: Record<string, unknown> = {}) => ({
  roomId: "1234",
  name: "猜歌房",
  phase,
  hostPlayerId: "p1",
  solo: false,
  musicAccountReady: true,
  settings: { questionType: "song", questionMode: "manual", showLyrics: true, allowAgents: true },
  roundNumber: 3,
  currentRound: round,
  players: [player("p1"), player("p2")],
  chat: [],
  ...overrides,
});

const open = (
  phase: string,
  options: {
    snapshot?: Record<string, unknown>;
    privateState?: Record<string, unknown>;
    handler?: (type: string, payload: Record<string, unknown>) => unknown;
  } = {}
) =>
  mcpFixture({
    game: "song",
    snapshot: options.snapshot ?? songSnapshot(phase),
    privateState: {
      playerId: "p1",
      submitterCandidateIds: ["p1"],
      visibleAttempts: [],
      ...options.privateState,
    },
    handler: options.handler,
  });

const searchResults = (
  type: string,
  payload: Record<string, unknown>,
  results: Array<Record<string, unknown>> = [
    { id: "netease:9", title: "测试歌", artist: "歌手", durationMs: 120_000 },
  ]
): unknown => {
  if (type === "song.music.search") return { results };
  if (type === "song.bangumi.search")
    return { results: [{ id: "bangumi:1", nameCn: "孤独摇滚", year: 2022 }] };
  if (type === "song.bangumi.songs")
    return {
      results: [{ song: { id: "netease:9", title: "关联曲" }, track: { kind: "op", title: "OP" } }],
    };
  if (type === "song.music.detail")
    return {
      song: {
        id: "netease:9",
        title: "测试歌",
        artist: "歌手",
        durationMs: 120_000,
        audioUrl: "https://audio.example/9.mp3",
        lyrics: [
          { time: 1000, endTime: 5000, text: "第一句" },
          { time: 6000, endTime: 40000, text: "第二句" },
        ],
        chorus: { startTime: 20000, endTime: 45000 },
      },
    };
  void payload;
  return { ok: true };
};

describe("猜歌界面：阶段与控件", () => {
  test("等待阶段房主看开始按钮，缺音乐账号时给出登录提示", async () => {
    const { ui } = open("waiting");
    const screen = await ui.screen("song");
    expect(screen.controls[0]).toMatchObject({ id: "song.start", disabled: false });
    expect(screen.title).toBe("等待开始");

    const noMusic = open("waiting", {
      snapshot: songSnapshot("waiting", { musicAccountReady: false }),
    });
    expect(
      (await noMusic.ui.screen("song")).controls.find((control) => control.id === "song.start")
    ).toMatchObject({
      disabled: true,
      hint: "请先登录网易云或 QQ 音乐账号",
    });
  });

  test("QQ 音乐账号同样算已登录，非房主只看到准备与组队", async () => {
    const qqOnly = open("waiting", {
      snapshot: songSnapshot("waiting", { musicAccountReady: false, qqMusicAccountReady: true }),
    });
    expect(
      (await qqOnly.ui.screen("song")).controls.find((control) => control.id === "song.start")
    ).toMatchObject({ disabled: false, hint: undefined });

    const guest = open("waiting", { privateState: { playerId: "p2" } });
    const screen = await guest.ui.screen("song");
    expect(idsOf(screen.controls)).toEqual(["song.ready", "song.team", "chat.input", "chat.send"]);
    expect(screen.controls[0]).toMatchObject({ label: "取消准备" });
  });

  test("手动出题没有候选出题人时不能开局", async () => {
    const { ui } = open("waiting", { privateState: { submitterCandidateIds: [] } });
    expect(
      (await ui.screen("song")).controls.find((control) => control.id === "song.start")
    ).toMatchObject({ disabled: true, hint: "等待其他玩家准备，或暂无可选出题人" });
  });

  test("单人房不需要其他玩家准备", async () => {
    const snapshot = songSnapshot("waiting", {
      solo: true,
      players: [player("p1")],
    });
    const { ui } = open("waiting", {
      snapshot,
      privateState: { playerId: "p1", submitterCandidateIds: [] },
    });
    expect((await ui.screen("song")).controls[0]).toMatchObject({
      id: "song.start",
      disabled: false,
    });
  });

  test("指定出题人只列候选，非房主看不到", async () => {
    const { ui } = open("choosingSubmitter", { privateState: { submitterCandidateIds: ["p1"] } });
    const screen = await ui.screen("song");
    expect(idsOf(screen.controls)).toEqual(["song.submitter.p1", "chat.input", "chat.send"]);
    expect(screen.controls[0]?.data).toEqual({ playerId: "p1", team: null });

    const guest = open("choosingSubmitter", { privateState: { playerId: "p2" } });
    expect(idsOf(await (await guest.ui.screen("song")).controls)).toEqual([
      "chat.input",
      "chat.send",
    ]);
  });

  test("出题阶段：非出题人只看到等待提示", async () => {
    const snapshot = songSnapshot("submittingSong", { pendingSubmitterPlayerId: "p2" });
    const { ui } = open("submittingSong", {
      snapshot,
      privateState: { canSubmitSong: false },
    });
    const screen = await ui.screen("song");
    expect(screen.notice).toBe("对手 正在选歌");
    expect(idsOf(screen.controls)).toEqual(["chat.input", "chat.send"]);
  });

  test("出题阶段：搜索框提示按题目类型变化", async () => {
    const songMode = open("submittingSong", { privateState: { canSubmitSong: true } });
    let screen = await songMode.ui.screen("song");
    expect(screen.controls[0]).toMatchObject({
      id: "song.submit.search.input",
      hint: "停止输入后自动检索；点一条结果进入片段确认",
    });

    const anime = open("submittingSong", {
      snapshot: songSnapshot("submittingSong", {
        settings: { questionType: "anime", questionMode: "manual" },
      }),
      privateState: { canSubmitSong: true },
    });
    screen = await anime.ui.screen("song");
    expect(screen.controls[0]).toMatchObject({
      hint: "先搜番剧；点开一部番剧后再点关联曲提交",
    });
  });

  test("片段确认台在选中歌曲后接管控件", async () => {
    const { ui } = open("submittingSong", { privateState: { canSubmitSong: true } });
    await ui.screen("song");
    ui.state("song").songPreview = { id: "netease:9", title: "测试歌", durationMs: 120_000 };
    ui.state("song").songClip = { startTime: 1000, endTime: 16000 };
    const screen = await ui.screen("song");
    expect(idsOf(screen.controls)).toEqual([
      "song.clip.range",
      "song.clip.confirm",
      "song.clip.cancel",
      "chat.input",
      "chat.send",
    ]);
    expect(screen.controls[0]).toMatchObject({
      role: "slider",
      value: { startTime: 1000, endTime: 16000 },
      hint: "时间轴总长 120 秒；用 set 设置 startTime/endTime",
    });
    expect(screen.panel).toMatchObject({
      preview: { id: "netease:9", selectedClip: { endTime: 16000 } },
    });
  });

  test("播放回合给出音频与猜测入口，猜过的结果标灰", async () => {
    const { ui } = open("playing", {
      privateState: { canGuess: true, canGiveUp: true, remainingGuesses: 2 },
    });
    let screen = await ui.screen("song");
    expect(idsOf(screen.controls)).toEqual([
      "song.audio.play",
      "song.audio.retry",
      "song.guess.search.input",
      "song.guess.giveup",
      "chat.input",
      "chat.send",
    ]);
    expect(screen.you).toMatchObject({ canGuess: true, remainingGuesses: 2 });
    expect(screen.panel).toMatchObject({
      audio: {
        available: true,
        roundNumber: 3,
        audioUrl: "https://audio.example/3.mp3",
        clip: { startTime: 1000, endTime: 16000, lines: [{ time: 1000, text: "歌词" }] },
        lyricsVisible: true,
      },
    });

    await ui.screen("song");
    ui.state("song").search = {
      prefix: "song.guess.search",
      purpose: "song_guess",
      kind: "song",
      keyword: "测试",
      status: "ready",
      results: [{ id: "netease:9", title: "测试歌", artist: "歌手" }],
    };
    ui.state("song").drafts["song.guess.search.input"] = "测试";
    screen = await ui.screen("song");
    expect(
      screen.controls.find((control) => control.id === "song.guess.search.result.0")
    ).toMatchObject({ disabled: false });
  });

  test("已猜过的歌曲与番剧按本人尝试记录禁用", async () => {
    const attempts = [
      { playerId: "p1", guessedSong: { id: "netease:9" } },
      { playerId: "p1", guessedAnime: { id: "bangumi:1" } },
      { playerId: "p2", guessedSong: { id: "netease:7" } },
    ];
    const { ui } = open("playing", { privateState: { canGuess: true, visibleAttempts: attempts } });
    await ui.screen("song");
    ui.state("song").search = {
      prefix: "song.guess.search",
      purpose: "song_guess",
      kind: "song",
      keyword: "测试",
      status: "ready",
      results: [
        { id: "netease:9", title: "猜过的歌" },
        { id: "netease:7", title: "别人猜过的歌" },
      ],
    };
    let screen = await ui.screen("song");
    expect(
      screen.controls.find((control) => control.id === "song.guess.search.result.0")
    ).toMatchObject({ disabled: true, hint: "已经猜过这一条" });
    expect(
      screen.controls.find((control) => control.id === "song.guess.search.result.1")
    ).toMatchObject({ disabled: false });

    ui.state("song").search = {
      prefix: "song.guess.search",
      purpose: "song_guess",
      kind: "anime",
      keyword: "测试",
      status: "ready",
      results: [
        { id: "bangumi:1", nameCn: "猜过的番" },
        { id: "bangumi:2", nameCn: "没猜过的番" },
      ],
    };
    screen = await ui.screen("song");
    expect(
      screen.controls.find((control) => control.id === "song.guess.search.result.0")
    ).toMatchObject({ disabled: true });
    expect(
      screen.controls.find((control) => control.id === "song.guess.search.result.1")
    ).toMatchObject({ disabled: false });
  });

  test("不可播放的结果带原因并禁用", async () => {
    const { ui } = open("submittingSong", { privateState: { canSubmitSong: true } });
    await ui.screen("song");
    ui.state("song").search = {
      prefix: "song.submit.search",
      purpose: "song_submit",
      kind: "song",
      keyword: "测试",
      status: "ready",
      results: [
        { id: "netease:9", title: "无版权", playable: false, unplayableReason: "需要 VIP" },
      ],
    };
    const screen = await ui.screen("song");
    expect(
      screen.controls.find((control) => control.id === "song.submit.search.result.0")
    ).toMatchObject({ disabled: true, hint: "需要 VIP" });
    expect(screen.panel).toMatchObject({
      search: { results: [{ playable: false, unplayableReason: "需要 VIP" }] },
    });
  });

  test("番剧搜索结果展开为关联曲视图", async () => {
    const { ui } = open("submittingSong", {
      snapshot: songSnapshot("submittingSong", {
        settings: { questionType: "anime", questionMode: "manual" },
      }),
      privateState: { canSubmitSong: true },
    });
    await ui.screen("song");
    ui.state("song").search = {
      prefix: "song.submit.search",
      purpose: "song_submit",
      kind: "anime",
      keyword: "孤独",
      status: "ready",
      subject: { id: "bangumi:1", nameCn: "孤独摇滚" },
      results: [
        {
          candidate: {
            song: { id: "netease:9", title: "青春コンプレックス", artist: "結束バンド" },
            track: { kind: "op", title: "OP" },
          },
        },
        { id: "bangumi:2", nameCn: "另一部", year: 2022 },
      ],
    };
    const screen = await ui.screen("song");
    const first = screen.controls.find((control) => control.id === "song.submit.search.result.0");
    expect(first).toMatchObject({ label: "青春コンプレックス" });
    expect(first?.data).toMatchObject({ trackKind: "op", trackTitle: "OP", id: "netease:9" });
    expect(
      screen.controls.find((control) => control.id === "song.submit.search.result.1")?.data
    ).toMatchObject({ id: "bangumi:2", year: 2022 });
    expect(idsOf(screen.controls)).toContain("song.submit.search.back");
    expect(screen.panel).toMatchObject({ search: { subject: { id: "bangumi:1" } } });
  });

  test("没有回合时音频面板说明原因，关掉歌词就不带行", async () => {
    const noRound = open("waiting", { snapshot: songSnapshot("waiting", { currentRound: null }) });
    expect((await noRound.ui.screen("song")).panel).toMatchObject({
      audio: { available: false, reason: "当前不在播放回合" },
    });

    const noLyrics = open("playing", {
      snapshot: songSnapshot("playing", {
        settings: { questionType: "song", questionMode: "manual", showLyrics: false },
      }),
      privateState: { canGuess: true },
    });
    const panel = (await noLyrics.ui.screen("song")).panel as Record<string, unknown>;
    expect((panel.audio as Record<string, unknown>).clip).toEqual({
      startTime: 1000,
      endTime: 16000,
    });
    expect(panel).toMatchObject({ audio: { lyricsVisible: false } });
  });

  test("结算阶段只有房主能收尾，自动出题缺账号时不能再开一轮", async () => {
    const { ui } = open("roundResult");
    let screen = await ui.screen("song");
    expect(idsOf(screen.controls)).toEqual([
      "song.finish",
      "song.nextRound",
      "chat.input",
      "chat.send",
    ]);
    expect(screen.controls[0]).toMatchObject({ label: "返回等待阶段" });

    const automatic = open("roundResult", {
      snapshot: songSnapshot("roundResult", {
        musicAccountReady: false,
        settings: { questionType: "song", questionMode: "automatic" },
      }),
    });
    expect(
      (await automatic.ui.screen("song")).controls.find(
        (control) => control.id === "song.nextRound"
      )
    ).toMatchObject({ disabled: true, hint: "自动出题需要可用的音乐账号" });

    const solo = open("roundResult", {
      snapshot: songSnapshot("roundResult", { solo: true }),
    });
    expect(
      (await solo.ui.screen("song")).controls.find((control) => control.id === "song.finish")
    ).toMatchObject({ label: "结束本局" });

    const guest = open("roundResult", { privateState: { playerId: "p2" } });
    screen = await guest.ui.screen("song");
    expect(screen.notice).toBe("等待房主开始下一轮");
    expect(idsOf(screen.controls)).toEqual(["chat.input", "chat.send"]);
  });

  test("未知阶段只留聊天栏，标题退回游戏名", async () => {
    const { ui } = open("teleporting");
    const screen = await ui.screen("song");
    expect(screen.title).toBe("猜歌");
    expect(idsOf(screen.controls)).toEqual(["chat.input", "chat.send"]);
  });

  test("玩家栏带出队伍、回合标记与头像", async () => {
    const snapshot = songSnapshot("waiting");
    const first = (snapshot.players as Record<string, unknown>[])[0];
    first.team = 2;
    first.roundMarks = "✓✓";
    first.account = { image: "https://avatar.example/a.png" };
    const { ui } = open("waiting", { snapshot });
    expect((await ui.screen("song")).players[0]).toMatchObject({
      team: 2,
      roundMarks: "✓✓",
      avatar: "https://avatar.example/a.png",
    });
  });
});

describe("猜歌界面：控件动作", () => {
  test("准备、开局、指定出题人、投降、返回与下一轮", async () => {
    const { ui, calls } = open("waiting", { privateState: { playerId: "p2" } });
    await ui.screen("song");
    await ui.run("song", [{ action: "click", control: "song.ready" }]);
    expect(payloadOf(calls, "song.player.setReady")).toEqual({ ready: false });

    const host = open("waiting");
    await host.ui.screen("song");
    await host.ui.run("song", [{ action: "click", control: "song.start" }]);
    expect(typesOf(host.calls)).toContain("song.game.start");

    const choose = open("choosingSubmitter", { privateState: { submitterCandidateIds: ["p1"] } });
    await choose.ui.screen("song");
    await choose.ui.run("song", [{ action: "click", control: "song.submitter.p1" }]);
    expect(payloadOf(choose.calls, "song.game.chooseSubmitter")).toEqual({ playerId: "p1" });

    const playing = open("playing", { privateState: { canGuess: true, canGiveUp: true } });
    await playing.ui.screen("song");
    await playing.ui.run("song", [{ action: "click", control: "song.guess.giveup" }]);
    expect(typesOf(playing.calls)).toContain("song.game.giveUp");

    const result = open("roundResult");
    await result.ui.screen("song");
    await result.ui.run("song", [{ action: "click", control: "song.finish" }]);
    await result.ui.run("song", [{ action: "click", control: "song.nextRound" }]);
    expect(typesOf(result.calls)).toEqual(["song.game.finish", "song.game.nextRound"]);
  });

  test("搜索后点歌曲进入片段确认，默认取副歌", async () => {
    const { ui, calls } = open("submittingSong", {
      privateState: { canSubmitSong: true },
      handler: (type, payload) => searchResults(type, payload),
    });
    const run = await ui.run("song", [
      { action: "focus", control: "song.submit.search.input" },
      { action: "type", text: "测试" },
      { action: "click", control: "song.submit.search.result.0" },
    ]);
    expect(run.ok).toBe(true);
    expect(typesOf(calls)).toContain("song.music.search");
    expect(payloadOf(calls, "song.music.detail")).toEqual({ songId: "netease:9" });
    // 副歌 20s–45s 落在 120 秒的时间轴内，直接作为默认片段。
    expect(ui.state("song").songClip).toEqual({ startTime: 20000, endTime: 45000 });
    expect(run.steps.at(-1)?.feedback).toContain("请确认截取片段");
  });

  test("没有副歌时退回首句歌词，再退回零起点", async () => {
    const { ui } = open("submittingSong", {
      privateState: { canSubmitSong: true },
      handler: (type) =>
        type === "song.music.detail"
          ? {
              song: {
                id: "netease:9",
                title: "测试歌",
                lyrics: [{ time: 30000, endTime: 35000, text: "第一句" }],
              },
            }
          : searchResults(type, {}),
    });
    await ui.screen("song");
    ui.state("song").search = {
      prefix: "song.submit.search",
      purpose: "song_submit",
      kind: "song",
      keyword: "测试",
      status: "ready",
      results: [{ id: "netease:9", title: "测试歌" }],
    };
    await ui.run("song", [{ action: "click", control: "song.submit.search.result.0" }]);
    // 时间轴按「末句 + 30 秒」与 60 秒取大者兜底，片段仍守 15 秒默认长度。
    expect(ui.state("song").songClip).toEqual({ startTime: 30000, endTime: 45000 });

    const bare = open("submittingSong", {
      privateState: { canSubmitSong: true },
      handler: (type) =>
        type === "song.music.detail"
          ? { song: { id: "netease:9", title: "无词歌", durationMs: 9000 } }
          : searchResults(type, {}),
    });
    await bare.ui.screen("song");
    bare.ui.state("song").search = {
      prefix: "song.submit.search",
      purpose: "song_submit",
      kind: "song",
      keyword: "测试",
      status: "ready",
      results: [{ id: "netease:9", title: "测试歌" }],
    };
    await bare.ui.run("song", [{ action: "click", control: "song.submit.search.result.0" }]);
    // 时长不足 15 秒时按整条音轨收尾，起点仍守 5 秒下限。
    expect(bare.ui.state("song").songClip).toEqual({ startTime: 0, endTime: 9000 });
  });

  test("详情没有返回歌曲时报错，不进入半截确认台", async () => {
    const { ui } = open("submittingSong", {
      privateState: { canSubmitSong: true },
      handler: (type) => (type === "song.music.detail" ? { ok: true } : searchResults(type, {})),
    });
    await ui.screen("song");
    ui.state("song").search = {
      prefix: "song.submit.search",
      purpose: "song_submit",
      kind: "song",
      keyword: "测试",
      status: "ready",
      results: [{ id: "netease:9", title: "测试歌" }],
    };
    const run = await ui.run("song", [{ action: "click", control: "song.submit.search.result.0" }]);
    expect(run.steps[0]?.feedback).toBe("歌曲详情没有返回");
    expect(ui.state("song").songPreview).toBeUndefined();
  });

  test("出题带上来源与会员标记，确认后回到选歌状态", async () => {
    const { ui, calls } = open("submittingSong", {
      privateState: { canSubmitSong: true },
      handler: (type, payload) => searchResults(type, payload),
    });
    await ui.screen("song");
    ui.state("song").songPreview = {
      id: "netease:9",
      title: "测试歌",
      durationMs: 120_000,
      sources: ["netease", "qq"],
      requiresVip: true,
    };
    ui.state("song").songClip = { startTime: 1000, endTime: 16000 };
    const run = await ui.run("song", [{ action: "click", control: "song.clip.confirm" }]);
    expect(run.ok).toBe(true);
    expect(payloadOf(calls, "song.game.submitSong")).toEqual({
      songId: "netease:9",
      clip: { startTime: 1000, endTime: 16000 },
      sources: ["netease", "qq"],
      requiresVip: true,
    });
    expect(ui.state("song").songPreview).toBeUndefined();
    expect(ui.state("song").songClip).toBeUndefined();
  });

  test("取消片段确认会清掉预览并退回搜索框", async () => {
    const { ui } = open("submittingSong", { privateState: { canSubmitSong: true } });
    await ui.screen("song");
    ui.state("song").songPreview = { id: "netease:9", title: "测试歌" };
    ui.state("song").songClip = { startTime: 0, endTime: 5000 };
    ui.state("song").search = {
      prefix: "song.submit.search",
      purpose: "song_submit",
      kind: "song",
      keyword: "测试",
      status: "ready",
      results: [{ id: "netease:9" }],
    };
    const run = await ui.run("song", [{ action: "click", control: "song.clip.cancel" }]);
    expect(run.steps[0]?.feedback).toContain("重新选歌");
    expect(ui.state("song").songPreview).toBeUndefined();
    expect(ui.state("song").search).toBeUndefined();
    expect(ui.state("song").drafts["song.submit.search.input"]).toBeUndefined();
  });

  test("没选片段就确认、缺 songId 都明确失败", async () => {
    const { ui } = open("submittingSong", { privateState: { canSubmitSong: true } });
    await ui.screen("song");
    let run = await ui.run("song", [{ action: "click", control: "song.clip.confirm" }]);
    expect(run.steps[0]?.feedback).toContain("在当前页面不可见");

    ui.state("song").songPreview = { title: "缺编号" };
    ui.state("song").songClip = { startTime: 0, endTime: 5000 };
    run = await ui.run("song", [{ action: "click", control: "song.clip.confirm" }]);
    expect(run.steps[0]?.feedback).toBe("歌曲缺少 songId");
  });

  test("番剧出题：先点开番剧，再点关联曲提交", async () => {
    const { ui, calls } = open("submittingSong", {
      snapshot: songSnapshot("submittingSong", {
        settings: { questionType: "anime", questionMode: "manual" },
      }),
      privateState: { canSubmitSong: true },
      handler: (type, payload) => searchResults(type, payload),
    });
    await ui.screen("song");
    ui.state("song").search = {
      prefix: "song.submit.search",
      purpose: "song_submit",
      kind: "anime",
      keyword: "孤独",
      status: "ready",
      results: [{ id: "bangumi:1", nameCn: "孤独摇滚" }],
    };
    let run = await ui.run("song", [{ action: "click", control: "song.submit.search.result.0" }]);
    expect(run.ok).toBe(true);
    expect(ui.state("song").search?.subject).toMatchObject({ id: "bangumi:1" });
    expect(calls.map((call) => call.type)).toContain("song.bangumi.songs");

    // 换一部番剧：退回作品列表后重新展开，再点关联曲才真正出题。
    run = await ui.run("song", [{ action: "click", control: "song.submit.search.back" }]);
    expect(run.steps[0]?.feedback).toBe("已返回番剧结果");
    expect(ui.state("song").search?.subject).toBeUndefined();
    expect(calls.map((call) => call.type)).toContain("song.bangumi.search");

    run = await ui.run("song", [{ action: "click", control: "song.submit.search.result.0" }]);
    expect(run.ok).toBe(true);
    run = await ui.run("song", [{ action: "click", control: "song.submit.search.result.0" }]);
    expect(run.ok).toBe(true);
    expect(payloadOf(calls, "song.game.submitAnime")).toEqual({
      subjectId: "bangumi:1",
      songId: "netease:9",
    });
    expect(ui.state("song").search).toBeUndefined();
  });

  test("番剧与关联曲缺编号时分别报错", async () => {
    const { ui } = open("submittingSong", {
      snapshot: songSnapshot("submittingSong", {
        settings: { questionType: "anime", questionMode: "manual" },
      }),
      privateState: { canSubmitSong: true },
      handler: (type, payload) => searchResults(type, payload),
    });
    await ui.screen("song");
    ui.state("song").search = {
      prefix: "song.submit.search",
      purpose: "song_submit",
      kind: "anime",
      keyword: "孤独",
      status: "ready",
      results: [{ nameCn: "无编号番剧" }],
    };
    let run = await ui.run("song", [{ action: "click", control: "song.submit.search.result.0" }]);
    expect(run.steps[0]?.feedback).toBe("番剧缺少 subjectId");

    ui.state("song").search = {
      prefix: "song.submit.search",
      purpose: "song_submit",
      kind: "anime",
      keyword: "孤独",
      status: "ready",
      subject: { nameCn: "无编号番剧" },
      results: [{ song: { title: "无编号曲" }, track: { kind: "op" } }],
    };
    run = await ui.run("song", [{ action: "click", control: "song.submit.search.result.0" }]);
    expect(run.steps[0]?.feedback).toBe("关联曲缺少 songId");
  });

  test("猜歌曲与猜番剧各自落到对应命令", async () => {
    const { ui, calls } = open("playing", {
      privateState: { canGuess: true, visibleAttempts: [] },
      handler: (type, payload) => searchResults(type, payload),
    });
    await ui.screen("song");
    ui.state("song").search = {
      prefix: "song.guess.search",
      purpose: "song_guess",
      kind: "song",
      keyword: "测试",
      status: "ready",
      results: [{ id: "netease:9", title: "测试歌" }],
    };
    await ui.run("song", [{ action: "click", control: "song.guess.search.result.0" }]);
    expect(payloadOf(calls, "song.game.guess")).toEqual({ songId: "netease:9" });
    expect(ui.state("song").search).toBeUndefined();

    ui.state("song").search = {
      prefix: "song.guess.search",
      purpose: "song_guess",
      kind: "anime",
      keyword: "孤独",
      status: "ready",
      results: [{ id: "bangumi:1", nameCn: "孤独摇滚" }],
    };
    await ui.run("song", [{ action: "click", control: "song.guess.search.result.0" }]);
    expect(lastPayloadOf(calls, "song.game.guessAnime")).toEqual({ subjectId: "bangumi:1" });

    ui.state("song").search = {
      prefix: "song.guess.search",
      purpose: "song_guess",
      kind: "song",
      keyword: "测试",
      status: "ready",
      results: [{ title: "无编号" }],
    };
    const missing = await ui.run("song", [
      { action: "click", control: "song.guess.search.result.0" },
    ]);
    expect(missing.steps[0]?.feedback).toBe("歌曲缺少 songId");

    ui.state("song").search = {
      prefix: "song.guess.search",
      purpose: "song_guess",
      kind: "anime",
      keyword: "孤独",
      status: "ready",
      results: [{ nameCn: "无编号" }],
    };
    const missingAnime = await ui.run("song", [
      { action: "click", control: "song.guess.search.result.0" },
    ]);
    expect(missingAnime.steps[0]?.feedback).toBe("番剧缺少 subjectId");
  });

  test("上一阶段残留的搜索结果不会漏进本阶段的猜测面板", async () => {
    const { ui } = open("playing", { privateState: { canGuess: true } });
    await ui.screen("song");
    ui.state("song").search = {
      prefix: "song.submit.search",
      purpose: "song_submit",
      kind: "song",
      keyword: "测试",
      status: "ready",
      results: [{ id: "netease:9" }],
    };
    const run = await ui.run("song", [{ action: "click", control: "song.guess.search.result.0" }]);
    expect(run.steps[0]?.feedback).toContain("在当前页面不可见");
  });

  test("播放与重取音频按回合口径回话", async () => {
    const { ui, calls } = open("playing", { privateState: { canGuess: true } });
    await ui.screen("song");
    let run = await ui.run("song", [{ action: "click", control: "song.audio.play" }]);
    expect(run.steps[0]?.feedback).toBe(
      "请播放 https://audio.example/3.mp3 的 1000–16000 毫秒区间"
    );

    run = await ui.run("song", [{ action: "click", control: "song.audio.retry" }]);
    expect(run.ok).toBe(true);
    expect(payloadOf(calls, "song.game.audioFailed")).toEqual({ roundNumber: 3 });

    const noRound = open("waiting", { snapshot: songSnapshot("waiting", { currentRound: null }) });
    await noRound.ui.screen("song");
    run = await noRound.ui.run("song", [{ action: "click", control: "song.start" }]);
    expect(run.ok).toBe(true);

    const broken = open("playing", {
      snapshot: songSnapshot("playing", {
        currentRound: { ...round, roundNumber: "x" },
        phase: "playing",
      }),
      privateState: { canGuess: true },
    });
    await broken.ui.screen("song");
    run = await broken.ui.run("song", [{ action: "click", control: "song.audio.retry" }]);
    expect(run.steps[0]?.feedback).toBe("当前没有播放中的回合");
  });

  test("片段设置夹进时间轴并守住最短 5 秒", async () => {
    const { ui } = open("submittingSong", { privateState: { canSubmitSong: true } });
    await ui.screen("song");
    ui.state("song").songPreview = { id: "netease:9", title: "测试歌", durationMs: 30_000 };
    ui.state("song").songClip = { startTime: 0, endTime: 5000 };
    let run = await ui.run("song", [
      { action: "set", control: "song.clip.range", value: { startTime: -100, endTime: 90_000 } },
    ]);
    expect(run.ok).toBe(true);
    expect(ui.state("song").songClip).toEqual({ startTime: 0, endTime: 30000 });
    expect(run.steps[0]?.feedback).toBe("片段已设为 0–30 秒");

    // 起点被夹到「总长 - 5 秒」，短请求自动长回到 5 秒而不是报错。
    run = await ui.run("song", [
      { action: "set", control: "song.clip.range", value: { startTime: 28_000, endTime: 30_000 } },
    ]);
    expect(run.steps[0]?.feedback).toBe("片段已设为 25–30 秒");

    run = await ui.run("song", [{ action: "set", control: "song.clip.range", value: "1000" }]);
    expect(run.steps[0]?.feedback).toBe("片段需要 startTime 与 endTime 两个毫秒值");

    // 预览被清掉后确认台整体收回，也就没有还能被误设的片段滑块。
    ui.state("song").songPreview = undefined;
    run = await ui.run("song", [
      { action: "set", control: "song.clip.range", value: { startTime: 0, endTime: 10_000 } },
    ]);
    expect(run.steps[0]?.feedback).toContain("在当前页面不可见");
  });

  test("组队取值只接受 1–8 或不组队", async () => {
    const { ui, calls } = open("waiting", { privateState: { playerId: "p2" } });
    await ui.screen("song");
    await ui.run("song", [{ action: "set", control: "song.team", value: "5" }]);
    expect(payloadOf(calls, "song.player.setTeam")).toEqual({ team: 5 });
    const back = await ui.run("song", [{ action: "set", control: "song.team", value: "none" }]);
    expect(back.steps[0]?.feedback).toBe("已退出队伍");
    expect(lastPayloadOf(calls, "song.player.setTeam")).toEqual({ team: null });
    const bad = await ui.run("song", [{ action: "set", control: "song.team", value: "0" }]);
    expect(bad.steps[0]?.feedback).toBe("队伍必须是 1–8 或不组队");
  });

  test("回车触发搜索并回报命中数，空词拒绝", async () => {
    const { ui, calls } = open("submittingSong", {
      privateState: { canSubmitSong: true },
      handler: (type, payload) => searchResults(type, payload),
    });
    await ui.screen("song");
    ui.state("song").drafts["song.submit.search.input"] = "测试";
    let run = await ui.run("song", [
      { action: "focus", control: "song.submit.search.input" },
      { action: "press", key: "Enter" },
    ]);
    expect(run.ok).toBe(true);
    expect(run.steps.at(-1)?.feedback).toBe("找到 1 条结果");
    expect(calls.map((call) => call.type)).toContain("song.music.search");

    ui.state("song").drafts["song.submit.search.input"] = "   ";
    run = await ui.run("song", [
      { action: "focus", control: "song.submit.search.input" },
      { action: "press", key: "Enter" },
    ]);
    expect(run.steps.at(-1)?.feedback).toBe("搜索词不能为空");
  });

  test("搜索上游报错时把错误留在搜索状态并抛出", async () => {
    const { ui } = open("submittingSong", {
      privateState: { canSubmitSong: true },
      handler: (type) => {
        if (type === "song.music.search") throw new Error("上游 502");
        return { ok: true };
      },
    });
    await ui.screen("song");
    ui.state("song").drafts["song.submit.search.input"] = "测试";
    const run = await ui.run("song", [
      { action: "focus", control: "song.submit.search.input" },
      { action: "press", key: "Enter" },
    ]);
    expect(run.ok).toBe(false);
    expect(run.steps.at(-1)?.feedback).toContain("上游 502");
  });

  test("自动检索在关键词清空时收回结果面板", async () => {
    const { ui, calls } = open("submittingSong", {
      privateState: { canSubmitSong: true },
      handler: (type, payload) => searchResults(type, payload),
    });
    const run = await ui.run("song", [
      { action: "focus", control: "song.submit.search.input" },
      { action: "type", text: "测试" },
    ]);
    expect(run.ok).toBe(true);
    expect(ui.state("song").search).toMatchObject({ status: "ready", keyword: "测试" });
    expect((await ui.screen("song")).panel).toMatchObject({
      search: { status: "ready", results: [{ id: "netease:9", title: "测试歌" }] },
    });

    const cleared = await ui.run("song", [
      { action: "focus", control: "song.submit.search.input" },
      { action: "type", text: "   ", replace: true },
    ]);
    expect(cleared.ok).toBe(true);
    expect(ui.state("song").search).toBeUndefined();
    expect(typesOf(calls).filter((type) => type === "song.music.search")).toHaveLength(1);
  });

  test("聊天回车与不可操作控件", async () => {
    const { ui, calls } = open("waiting", { privateState: { playerId: "p2" } });
    await ui.screen("song");
    ui.state("song").drafts["chat.input"] = "开猜";
    let run = await ui.run("song", [
      { action: "focus", control: "chat.input" },
      { action: "press", key: "Enter" },
    ]);
    expect(run.ok).toBe(true);
    expect(payloadOf(calls, "song.chat.send")).toEqual({ text: "开猜" });

    run = await ui.run("song", [{ action: "click", control: "song.guess.giveup" }]);
    expect(run.steps[0]?.feedback).toContain("在当前页面不可见");

    run = await ui.run("song", [{ action: "set", control: "song.ready", value: "1" }]);
    expect(run.steps[0]?.feedback).toContain("不是可设置取值的控件");
  });

  test("进入播放回合后自动上报音频就绪，同一回合不重复报", async () => {
    const { ui, calls } = open("playing", { privateState: { canGuess: true } });
    await ui.screen("song");
    await ui.screen("song");
    expect(typesOf(calls).filter((type) => type === "song.game.audioReady")).toHaveLength(1);
    expect(payloadOf(calls, "song.game.audioReady")).toEqual({ roundNumber: 3 });

    const spectator = open("playing", {
      snapshot: songSnapshot("playing", {
        players: [player("p1", { membership: "spectator" }), player("p2")],
      }),
      privateState: { canGuess: true },
    });
    await spectator.ui.screen("song");
    expect(typesOf(spectator.calls)).toEqual([]);
  });

  test("音频就绪上报失败时不记档位，下一次读屏会重试", async () => {
    const { ui, calls } = open("playing", {
      privateState: { canGuess: true },
      handler: (type) => {
        if (type === "song.game.audioReady") throw new Error("上游未确认");
        return { ok: true };
      },
    });
    await ui.screen("song");
    expect(typesOf(calls).filter((type) => type === "song.game.audioReady")).toHaveLength(1);
    await ui.screen("song");
    expect(typesOf(calls).filter((type) => type === "song.game.audioReady")).toHaveLength(2);
  });

  test("非播放回合不发音频就绪", async () => {
    const { ui, calls } = open("submittingSong", { privateState: { canSubmitSong: true } });
    await ui.screen("song");
    expect(typesOf(calls)).toEqual([]);
  });
});
