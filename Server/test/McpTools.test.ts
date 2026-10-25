import { expect, test } from "bun:test";
import type { AgentGameClient, GameId } from "../src/mcp/GameClient";
import { focusForTool } from "../src/mcp/Focus";
import { TOOLS } from "../src/mcp/Tools";
import { SeatUi } from "../src/mcp/ui/SeatUi";
import type { AgentFocusInput } from "../src/shared/AgentActivity";

type Call = { game: string; type: string; payload: Record<string, unknown> };

const tool = (name: string) => {
  const found = TOOLS.find((entry) => entry.name === name);
  if (!found) throw new Error(`缺少工具 ${name}`);
  return found;
};

const baseFakerSnapshot = (phase = "waiting") => ({
  roomId: "1234",
  name: "测试房",
  phase,
  hostPlayerId: "p1",
  testMode: false,
  allowSpectators: true,
  settings: {
    roleConfig: { undercoverCount: 1, hasAngel: false, hasBlank: false },
    allowAgents: true,
  },
  roleLimits: { maxUndercoverCount: 2, canEnableAngel: false, canEnableBlank: false },
  status: { phase, started: false, day: 1 },
  players: [
    {
      id: "p1",
      name: "测试员",
      score: 0,
      membership: "active",
      online: true,
      isReady: false,
      isBot: false,
      isHost: true,
      roundStatus: "waiting",
    },
    {
      id: "p2",
      name: "对手",
      score: 0,
      membership: "active",
      online: true,
      isReady: true,
      isBot: false,
      isHost: false,
      roundStatus: "waiting",
    },
  ],
  descriptions: [],
  chat: [],
});

interface FixtureOptions {
  game: GameId;
  snapshot: Record<string, unknown>;
  privateState: Record<string, unknown>;
  handler?: (type: string, payload: Record<string, unknown>) => unknown;
}

const fixture = ({ game, snapshot, privateState, handler }: FixtureOptions) => {
  const calls: Call[] = [];
  const focus: AgentFocusInput[] = [];
  let version = 0;
  const client = {
    name: "TestAgent",
    currentRoom: (target: string) => (target === game ? String(snapshot.roomId) : undefined),
    currentPlayerId: () => String(privateState.playerId),
    currentSnapshot: () => snapshot,
    currentPrivateState: () => privateState,
    sendInRoom: async (
      target: string,
      type: string,
      payload: Record<string, unknown> = {}
    ) => {
      calls.push({ game: target, type, payload });
      version += 1;
      return handler ? handler(type, payload) : { ok: true };
    },
    publishAgentFocus: async (input: AgentFocusInput) => {
      focus.push(input);
    },
    stateVersion: () => version,
    waitForStateChange: async () => true,
    requestSync: async () => ({ synced: true }),
  } as unknown as AgentGameClient;
  const ui = new SeatUi(client, { pacing: false });
  (client as unknown as { ui: SeatUi }).ui = ui;
  return { client, ui, calls, focus };
};

test("工具面只保留大厅/进房/屏幕/界面操作，不再暴露绕过控件的动作接口", () => {
  const names = TOOLS.map((entry) => entry.name);
  expect(names).toEqual(
    expect.arrayContaining([
      "list_rooms",
      "create_room",
      "join_room",
      "claim_seat",
      "release_seat",
      "leave_room",
      "get_screen",
      "ui_run",
      "get_mcp_policy",
    ])
  );
  expect(names).not.toContain("faker_action");
  expect(names).not.toContain("song_action");
  expect(names).not.toContain("cee_action");
  expect(names).not.toContain("send_chat");
  expect(names).not.toContain("song_search");
  expect(names).not.toContain("cee_character_search");
});

test("导航工具只上报粗焦点；局内焦点交给控件", () => {
  const { client } = fixture({
    game: "song",
    snapshot: { roomId: "1234", phase: "waiting", players: [], chat: [] },
    privateState: { playerId: "p1" },
  });
  expect(focusForTool("list_rooms", { game: "song" }, client)).toEqual({
    game: "song",
    kind: "lobby",
  });
  expect(focusForTool("create_room", { game: "song" }, client)).toEqual({
    game: "song",
    kind: "enter_room",
  });
  expect(focusForTool("song_search", { keyword: "秘密" }, client)).toBeUndefined();
  expect(focusForTool("faker_action", { action: "vote" }, client)).toBeUndefined();
});

test("屏幕给玩家栏、聊天栏与本人可见信息，但不带会话令牌", async () => {
  const { ui } = fixture({
    game: "faker",
    snapshot: baseFakerSnapshot(),
    privateState: {
      playerId: "p1",
      sessionToken: "secret-token",
      role: "civilian",
      word: "苹果",
      isQuestioner: false,
    },
  });
  const screen = await ui.screen("faker");
  expect(screen.players.map((player) => player.name)).toEqual(["测试员", "对手"]);
  expect(screen.chat).toEqual([]);
  expect(screen.you).toMatchObject({ role: "civilian", word: "苹果" });
  expect(screen.controls.map((entry) => entry.id)).toContain("faker.start");
  expect(JSON.stringify(screen)).not.toContain("secret-token");
});

test("输入必须先 focus；聚焦后逐字输入并在一次请求里串行提交词语", async () => {
  const snapshot = baseFakerSnapshot("wordSubmission");
  snapshot.status = { phase: "wordSubmission", started: true, day: 1 } as never;
  const { ui, calls, focus } = fixture({
    game: "faker",
    snapshot,
    privateState: { playerId: "p1", isQuestioner: true, role: "civilian", word: "苹果" },
    handler: () => ({ ok: true }),
  });

  const missingFocus = await ui.run("faker", [{ action: "type", text: "苹果" }]);
  expect(missingFocus.ok).toBe(false);
  expect(missingFocus.steps[0]?.feedback).toContain("focus");

  const result = await ui.run("faker", [
    { action: "focus", control: "faker.word.civilian" },
    { action: "type", text: "苹果" },
    { action: "focus", control: "faker.word.undercover" },
    { action: "type", text: "香蕉" },
    { action: "click", control: "faker.words.submit" },
  ]);
  expect(result.ok).toBe(true);
  expect(result.steps).toHaveLength(5);
  expect(calls.at(-1)).toMatchObject({
    game: "faker",
    type: "game.submitWords",
    payload: { words: ["苹果", "香蕉"] },
  });
  const typing = focus
    .filter((entry) => entry.action === "type" && entry.controlId === "faker.word.civilian")
    .at(-1);
  expect(typing).toMatchObject({ part: "game", label: "平民词" });
  expect(typing?.input).toContain("苹果");
  expect(result.screen.players).toHaveLength(2);
});

test("猜歌：搜索结果与玩家栏/聊天栏一起返回，点结果才提交猜测", async () => {
  const snapshot: Record<string, unknown> = {
    roomId: "1234",
    phase: "playing",
    hostPlayerId: "p2",
    solo: false,
    settings: { questionType: "song", showLyrics: true, allowAgents: true },
    roundNumber: 1,
    currentRound: {
      roundNumber: 1,
      submitterPlayerId: "p2",
      audioUrl: "https://audio.example/song.mp3",
      lyricClip: { startTime: 1000, endTime: 16000, lines: [{ time: 1000, text: "歌词" }] },
    },
    players: [
      { id: "p1", name: "测试员", score: 0, team: null, membership: "active", online: true, isReady: true, isBot: false, isHost: false, roundStatus: "guessing", guessesUsed: 0, correctGuesses: 0, totalGuesses: 0 },
      { id: "p2", name: "出题人", score: 0, team: null, membership: "active", online: true, isReady: true, isBot: false, isHost: true, roundStatus: "submitter", guessesUsed: 0, correctGuesses: 0, totalGuesses: 0 },
    ],
    chat: [
      { id: "c1", playerId: "p2", playerName: "出题人", text: "来猜", createdAt: 1, system: false },
    ],
  };
  const { ui, calls } = fixture({
    game: "song",
    snapshot,
    privateState: {
      playerId: "p1",
      canGuess: true,
      canGiveUp: true,
      remainingGuesses: 3,
      visibleAttempts: [],
      isSubmitter: false,
      teamObserver: false,
      submitterCandidateIds: [],
    },
    handler: (type) => {
      if (type === "song.music.search")
        return { results: [{ id: "netease:1", title: "测试歌", artist: "歌手" }] };
      return { ok: true };
    },
  });

  const result = await ui.run("song", [
    { action: "focus", control: "song.guess.search.input" },
    { action: "type", text: "测试" },
    { action: "click", control: "song.guess.search.result.0" },
  ]);
  expect(result.ok).toBe(true);
  expect(calls.map((call) => call.type)).toContain("song.music.search");
  expect(calls.map((call) => call.type)).toContain("song.game.guess");
  expect(calls.find((call) => call.type === "song.game.guess")?.payload).toEqual({
    songId: "netease:1",
  });
  expect(result.screen.chat[0]).toMatchObject({ text: "来猜" });
  expect(result.screen.players.map((player) => player.name)).toEqual(["测试员", "出题人"]);
});

test("猜歌出题：搜索、选中详情、设置片段、确认出题都在控件上完成", async () => {
  const snapshot: Record<string, unknown> = {
    roomId: "1234",
    phase: "submittingSong",
    hostPlayerId: "p1",
    solo: false,
    settings: { questionType: "song", showLyrics: true, allowAgents: true },
    pendingSubmitterPlayerId: "p1",
    players: [
      { id: "p1", name: "测试员", score: 0, team: null, membership: "active", online: true, isReady: true, isBot: false, isHost: true, roundStatus: "submitter", guessesUsed: 0, correctGuesses: 0, totalGuesses: 0 },
    ],
    chat: [],
  };
  const { ui, calls } = fixture({
    game: "song",
    snapshot,
    privateState: {
      playerId: "p1",
      isSubmitter: true,
      canSubmitSong: true,
      submitterCandidateIds: [],
      visibleAttempts: [],
    },
    handler: (type) => {
      if (type === "song.music.search")
        return { results: [{ id: "netease:9", title: "测试歌", artist: "歌手", durationMs: 120_000 }] };
      if (type === "song.music.detail")
        return {
          song: {
            id: "netease:9",
            title: "测试歌",
            artist: "歌手",
            durationMs: 120_000,
            audioUrl: "https://audio.example/9.mp3",
            lyrics: [{ time: 1000, endTime: 5000, text: "第一句" }],
            suggestedClip: { startTime: 1000, endTime: 20_000 },
          },
        };
      return { ok: true };
    },
  });

  const result = await ui.run("song", [
    { action: "focus", control: "song.submit.search.input" },
    { action: "type", text: "测试" },
    { action: "click", control: "song.submit.search.result.0" },
    { action: "set", control: "song.clip.range", value: { startTime: 2000, endTime: 18_000 } },
    { action: "click", control: "song.clip.confirm" },
  ]);
  expect(result.ok).toBe(true);
  expect(calls.find((call) => call.type === "song.game.submitSong")?.payload).toEqual({
    songId: "netease:9",
    clip: { startTime: 2000, endTime: 18_000 },
  });
});

test("猜角色出题：搜角色、选中答案、输入提示并确认", async () => {
  const snapshot: Record<string, unknown> = {
    roomId: "1234",
    source: "native",
    phase: "answering",
    hostPlayerId: "p1",
    settings: { allowAgents: true, answerMode: "manual", subjectSearch: true },
    players: [
      { id: "p1", name: "测试员", online: true, ready: true, team: null, membership: "active", score: 0, status: "waiting", attempts: 0, marks: "" },
    ],
    spectateRequests: [],
    chat: [],
  };
  const { ui, calls } = fixture({
    game: "cee",
    snapshot,
    privateState: {
      playerId: "p1",
      canSetAnswer: true,
      setterCandidateIds: [],
      guesses: [],
      hints: [],
      bannedCharacterIds: [],
    },
    handler: (type) => {
      if (type === "cee.character.search")
        return { results: [{ id: 7, name: "后藤一里", nameCn: "后藤一里" }] };
      return { ok: true };
    },
  });

  const result = await ui.run("cee", [
    { action: "focus", control: "cee.answer.search.input" },
    { action: "type", text: "后藤" },
    { action: "click", control: "cee.answer.search.result.0" },
    { action: "focus", control: "cee.answer.hint.0" },
    { action: "type", text: "粉发" },
    { action: "click", control: "cee.answer.confirm" },
  ]);
  expect(result.ok).toBe(true);
  expect(calls.find((call) => call.type === "cee.game.setAnswer")?.payload).toEqual({
    characterId: 7,
    hints: ["粉发"],
  });
});

test("发送聊天后返回的屏幕同步包含新的聊天栏内容", async () => {
  const snapshot = baseFakerSnapshot();
  const { ui } = fixture({
    game: "faker",
    snapshot,
    privateState: { playerId: "p1", isQuestioner: false },
    handler: (type, payload) => {
      if (type === "chat.send") {
        (snapshot.chat as unknown[]).push({
          id: "c2",
          playerId: "p1",
          playerName: "测试员",
          text: String(payload.text),
          createdAt: 2,
          system: false,
        });
      }
      return { sent: true };
    },
  });
  const result = await ui.run("faker", [
    { action: "focus", control: "chat.input" },
    { action: "type", text: "大家好" },
    { action: "click", control: "chat.send" },
  ]);
  expect(result.ok).toBe(true);
  expect(result.screen.chat.at(-1)).toMatchObject({ playerName: "测试员", text: "大家好" });
  expect(result.steps.at(-1)?.feedback).toContain("聊天");
});

test("ui_run 工具拒绝空步骤并透传界面操作", async () => {
  const snapshot = baseFakerSnapshot();
  const { client } = fixture({
    game: "faker",
    snapshot,
    privateState: { playerId: "p1" },
  });
  await expect(
    tool("ui_run").handler({ steps: [] }, { client, agentName: "TestAgent" })
  ).rejects.toThrow("至少");
  const result = (await tool("get_screen").handler(
    { game: "faker" },
    { client, agentName: "TestAgent" }
  )) as { screen: { game: string } };
  expect(result.screen.game).toBe("faker");
});
