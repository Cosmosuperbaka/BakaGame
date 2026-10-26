import { describe, expect, test } from "bun:test";

import type { AgentGameClient } from "../src/mcp/GameClient";

import { SeatUi } from "../src/mcp/ui/SeatUi";
import { ABSTAIN_TARGET_ID } from "../src/shared/WhoIsFaker";
import { clampSpeech } from "../src/mcp/ui/Faker";
import {
  baseFakerSnapshot,
  idsOf,
  lastPayloadOf,
  mcpFixture,
  payloadOf,
  typesOf,
} from "./McpFixtures";

const inPhase = (phase: string, status: Record<string, unknown> = {}) => {
  const snapshot = baseFakerSnapshot(phase) as Record<string, unknown>;
  snapshot.status = { phase, started: true, day: 1, ...status };
  return snapshot;
};

const alivePlayers = (snapshot: Record<string, unknown>) => {
  (snapshot.players as Record<string, unknown>[]).forEach((player, index) => {
    player.roundStatus = index === 0 ? "alive" : "alive";
  });
  return snapshot;
};

const open = (
  phase: string,
  options: {
    status?: Record<string, unknown>;
    privateState?: Record<string, unknown>;
    snapshot?: Record<string, unknown>;
    handler?: (type: string, payload: Record<string, unknown>) => unknown;
  } = {}
) => {
  const snapshot = options.snapshot ?? inPhase(phase, options.status);
  return mcpFixture({
    game: "faker",
    snapshot,
    privateState: { playerId: "p1", ...options.privateState },
    handler: options.handler,
  });
};

describe("谁是卧底界面：阶段与控件", () => {
  test("等待阶段房主看得到开始按钮，其他人没准备齐时禁用", async () => {
    const snapshot = baseFakerSnapshot("waiting") as Record<string, unknown>;
    (snapshot.players as Record<string, unknown>[])[1].isReady = false;
    const { ui } = open("waiting", { snapshot });
    const screen = await ui.screen("faker");
    const start = screen.controls.find((control) => control.id === "faker.start");
    expect(start).toMatchObject({ label: "开始游戏", disabled: true });
    expect(start?.hint).toBe("等待其他玩家准备");
    expect(screen.players.map((player) => player.name)).toEqual(["测试员", "对手"]);

    (snapshot.players as Record<string, unknown>[])[1].isReady = true;
    expect(
      (await ui.screen("faker")).controls.find((control) => control.id === "faker.start")
    ).toMatchObject({ disabled: false, hint: undefined });
  });

  test("非房主的活跃玩家看到的是准备按钮，旁观者没有局内按钮", async () => {
    const notHost = baseFakerSnapshot("waiting") as Record<string, unknown>;
    const { ui } = open("waiting", {
      snapshot: notHost,
      privateState: { playerId: "p2" },
    });
    const screen = await ui.screen("faker");
    expect(idsOf(screen.controls)).toEqual(["faker.ready", "chat.input", "chat.send"]);
    expect(screen.controls[0]).toMatchObject({ label: "取消准备" });

    const spectator = baseFakerSnapshot("waiting") as Record<string, unknown>;
    (spectator.players as Record<string, unknown>[])[1].membership = "spectator";
    const spectate = open("waiting", { snapshot: spectator, privateState: { playerId: "p2" } });
    expect(idsOf((await spectate.ui.screen("faker")).controls)).toEqual([
      "chat.input",
      "chat.send",
    ]);
  });

  test("测试房没有其他人也算准备齐，房主可以直接开始", async () => {
    const snapshot = baseFakerSnapshot("waiting") as Record<string, unknown>;
    snapshot.testMode = true;
    const { ui } = open("waiting", { snapshot });
    const screen = await ui.screen("faker");
    expect(screen.controls.find((control) => control.id === "faker.start")).toMatchObject({
      disabled: false,
    });
    expect(screen.notice).toBe("测试房可以单人直接开始");
  });

  test("指定主持人：旁观者带推荐提示，普通玩家没有提示", async () => {
    const snapshot = inPhase("assigningQuestioner");
    (snapshot.players as Record<string, unknown>[])[1].membership = "spectator";
    const { ui } = open("assigningQuestioner", { snapshot, privateState: { isQuestioner: false } });
    const screen = await ui.screen("faker");
    const controls = screen.controls.filter((control) =>
      control.id.startsWith("faker.questioner.")
    );
    expect(idsOf(controls)).toEqual(["faker.questioner.p1", "faker.questioner.p2"]);
    expect(controls[1]).toMatchObject({
      label: "对手",
      hint: "推荐：旁观者主持，全员参战",
    });
  });

  test("非房主非主持人拿不到指定主持人的控件", async () => {
    const snapshot = inPhase("assigningQuestioner");
    (snapshot.players as Record<string, unknown>[])[0].isHost = false;
    const { ui } = open("assigningQuestioner", { snapshot, privateState: { playerId: "p2" } });
    expect(idsOf(await (await ui.screen("faker")).controls)).toEqual(["chat.input", "chat.send"]);
  });

  test("提交词语：开白板时多一个提示框，三项没填全就不能提交", async () => {
    const snapshot = inPhase("wordSubmission");
    snapshot.settings = { roleConfig: { hasBlank: true }, allowAgents: true };
    const { ui } = open("wordSubmission", { snapshot, privateState: { isQuestioner: true } });
    let screen = await ui.screen("faker");
    expect(idsOf(screen.controls)).toEqual([
      "faker.word.civilian",
      "faker.word.undercover",
      "faker.word.blankHint",
      "faker.words.submit",
      "chat.input",
      "chat.send",
    ]);
    expect(screen.controls[3]).toMatchObject({ id: "faker.words.submit", disabled: true });

    ui.state("faker").drafts["faker.word.blankHint"] = "自由发挥";
    ui.state("faker").drafts["faker.word.civilian"] = "苹果";
    ui.state("faker").drafts["faker.word.undercover"] = "梨";
    screen = await ui.screen("faker");
    expect(screen.controls.find((control) => control.id === "faker.words.submit")?.disabled).toBe(
      false
    );
  });

  test("非主持人看不到词语面板", async () => {
    const { ui } = open("wordSubmission", { privateState: { isQuestioner: false } });
    expect(idsOf(await (await ui.screen("faker")).controls)).toEqual(["chat.input", "chat.send"]);
  });

  test("描述阶段：轮到我才给输入框，已提交过就收回", async () => {
    const snapshot = alivePlayers(inPhase("description"));
    const { ui } = open("description", {
      snapshot,
      privateState: { isQuestioner: false },
    });
    let screen = await ui.screen("faker");
    expect(idsOf(screen.controls)).toContain("faker.description.input");
    expect(
      screen.controls.find((control) => control.id === "faker.description.send")
    ).toMatchObject({ disabled: true });

    snapshot.status = { phase: "description", submittedSpeechPlayerIds: ["p1"] };
    screen = await ui.screen("faker");
    expect(idsOf(screen.controls)).not.toContain("faker.description.input");
  });

  test("自由讨论之外的发言顺序只放行名单里的人", async () => {
    const snapshot = alivePlayers(
      inPhase("description", { speechMode: "ordered", speechOrder: ["p1"] })
    );
    const { ui } = open("description", { snapshot });
    expect(idsOf(await (await ui.screen("faker")).controls)).toContain("faker.description.input");

    const other = alivePlayers(
      inPhase("description", { speechMode: "ordered", speechOrder: ["p2"] })
    );
    const blocked = open("description", { snapshot: other });
    expect(idsOf(await (await blocked.ui.screen("faker")).controls)).not.toContain(
      "faker.description.input"
    );
  });

  test("主持人看到推进按钮，阶段标签随发言模式变化", async () => {
    const normal = alivePlayers(inPhase("description"));
    const host = open("description", { snapshot: normal, privateState: { isQuestioner: true } });
    expect(
      (await host.ui.screen("faker")).controls.find((control) => control.id === "faker.advance")
    ).toMatchObject({ label: "进入投票阶段" });

    const pk = alivePlayers(inPhase("description", { speechMode: "vote" }));
    const pkHost = open("description", { snapshot: pk, privateState: { isQuestioner: true } });
    expect(
      (await pkHost.ui.screen("faker")).controls.find((control) => control.id === "faker.advance")
    ).toMatchObject({ label: "继续" });
  });

  test("投票阶段：活人且未投票才拿到候选人，投过之后只剩撤销", async () => {
    const snapshot = alivePlayers(inPhase("voting"));
    const { ui } = open("voting", { snapshot });
    let screen = await ui.screen("faker");
    expect(idsOf(screen.controls)).toEqual([
      "faker.vote.p2",
      "faker.vote.abstain",
      "chat.input",
      "chat.send",
    ]);

    ui.state("faker").drafts = {};
    const voted = alivePlayers(inPhase("voting"));
    const voteBox = open("voting", {
      snapshot: voted,
      privateState: { myCurrentVoteTargetId: "p2" },
    });
    screen = await voteBox.ui.screen("faker");
    expect(screen.controls[0]).toMatchObject({
      id: "faker.cancelVote",
      hint: "当前投给 对手",
    });

    const abstained = open("voting", {
      snapshot: voted,
      privateState: { myCurrentVoteTargetId: ABSTAIN_TARGET_ID },
    });
    expect(
      (await abstained.ui.screen("faker")).controls.find(
        (control) => control.id === "faker.cancelVote"
      )
    ).toMatchObject({ hint: "当前已弃票" });
  });

  test("平票 PK 只让候选之外的人投票，候选人自己被收走投票权", async () => {
    const snapshot = alivePlayers(
      inPhase("tieBreak", { tieBreakCandidateIds: ["p1"], tieBreakStage: "vote" })
    );
    const { ui } = open("tieBreak", { snapshot });
    expect(idsOf(await (await ui.screen("faker")).controls)).toEqual(["chat.input", "chat.send"]);

    const other = alivePlayers(
      inPhase("tieBreak", { tieBreakCandidateIds: ["p1"], tieBreakStage: "vote" })
    );
    const outsider = open("tieBreak", { snapshot: other, privateState: { playerId: "p2" } });
    expect(idsOf(await (await outsider.ui.screen("faker")).controls)).toContain("faker.vote.p1");
  });

  test("平票的描述小阶段沿用描述控件", async () => {
    const snapshot = alivePlayers(inPhase("tieBreak", { tieBreakStage: "description" }));
    const { ui } = open("tieBreak", { snapshot });
    expect(idsOf(await (await ui.screen("faker")).controls)).toContain("faker.description.input");
  });

  test("夜晚：活人拿到出手名单，已行动只剩撤销，主持人只看到天亮", async () => {
    const snapshot = alivePlayers(inPhase("night"));
    const { ui } = open("night", { snapshot, privateState: { role: "undercover" } });
    expect(idsOf(await (await ui.screen("faker")).controls)).toEqual([
      "faker.night.p2",
      "faker.night.skip",
      "chat.input",
      "chat.send",
    ]);

    const acted = open("night", {
      snapshot,
      privateState: { role: "civilian", nightActionSubmitted: true },
    });
    expect(idsOf(await (await acted.ui.screen("faker")).controls)).toContain("faker.cancelNight");

    const host = open("night", { snapshot, privateState: { isQuestioner: true } });
    expect(idsOf(await (await host.ui.screen("faker")).controls)).toContain("faker.advance");

    const dead = alivePlayers(inPhase("night"));
    (dead.players as Record<string, unknown>[])[0].roundStatus = "eliminated";
    const victim = open("night", { snapshot: dead, privateState: { role: "civilian" } });
    expect(idsOf(await (await victim.ui.screen("faker")).controls)).not.toContain(
      "faker.night.skip"
    );
  });

  test("白板猜词：猜词人填两个词，其余人只在待裁定时看到裁定按钮", async () => {
    const snapshot = alivePlayers(inPhase("blankGuess", { blankGuessPlayerId: "p1" }));
    const { ui } = open("blankGuess", { snapshot });
    expect(idsOf(await (await ui.screen("faker")).controls)).toEqual([
      "faker.blank.a",
      "faker.blank.b",
      "faker.blank.submit",
      "chat.input",
      "chat.send",
    ]);

    const reviewing = alivePlayers(
      inPhase("blankGuess", { blankGuessPlayerId: "p1", blankGuessPendingReview: true })
    );
    const guesser = open("blankGuess", { snapshot: reviewing });
    expect(idsOf(await (await guesser.ui.screen("faker")).controls)).toEqual([
      "chat.input",
      "chat.send",
    ]);

    const judge = open("blankGuess", {
      snapshot: reviewing,
      privateState: { playerId: "p2", isQuestioner: true },
    });
    expect(idsOf(await (await judge.ui.screen("faker")).controls)).toContain("faker.blank.approve");
  });

  test("白板入口只在有额度且不在收尾阶段时出现", async () => {
    const snapshot = alivePlayers(inPhase("description"));
    const { ui } = open("description", { snapshot, privateState: { canSubmitBlankGuess: true } });
    expect(idsOf(await (await ui.screen("faker")).controls)).toContain("faker.blank.enter");

    const used = open("description", {
      snapshot,
      privateState: { canSubmitBlankGuess: true, blankGuessUsed: true },
    });
    expect(idsOf(await (await used.ui.screen("faker")).controls)).not.toContain(
      "faker.blank.enter"
    );

    const feedback = open("feedback", {
      snapshot: inPhase("feedback", { feedback: { eliminatedPlayerId: "p2" } }),
      privateState: { canSubmitBlankGuess: true },
    });
    expect(idsOf(await (await feedback.ui.screen("faker")).controls)).not.toContain(
      "faker.blank.enter"
    );
  });

  test("结算与结束阶段：结果提示按身份区分，返回等待只有房主能按", async () => {
    const snapshot = inPhase("feedback", { feedback: { eliminatedPlayerId: "p2" } });
    const { ui } = open("feedback", { snapshot });
    const screen = await ui.screen("faker");
    expect(screen.notice).toBe("结果已出，等待主持人继续");
    expect(screen.title).toBe("阶段结果");

    const host = open("feedback", { snapshot, privateState: { isQuestioner: true } });
    expect((await host.ui.screen("faker")).notice).toBe("结果已出，由主持人继续");

    const over = open("gameOver", { snapshot: inPhase("gameOver") });
    expect((await over.ui.screen("faker")).notice).toBe("本局已结束，房主可以返回等待房间");
    expect(idsOf(await (await over.ui.screen("faker")).controls)).toContain("faker.advance");

    const guest = open("gameOver", {
      snapshot: inPhase("gameOver"),
      privateState: { playerId: "p2" },
    });
    expect(idsOf(await (await guest.ui.screen("faker")).controls)).toEqual([
      "chat.input",
      "chat.send",
    ]);
  });

  test("未知阶段只给聊天栏，标题退回游戏名", async () => {
    const { ui } = open("teleporting", { snapshot: inPhase("teleporting") });
    const screen = await ui.screen("faker");
    expect(screen.title).toBe("谁是卧底");
    expect(idsOf(screen.controls)).toEqual(["chat.input", "chat.send"]);
  });

  test("玩家栏带出公开身份与头像，不带隐藏字段", async () => {
    const snapshot = inPhase("feedback", { feedback: {} });
    const player = (snapshot.players as Record<string, unknown>[])[0];
    player.revealedRole = "undercover";
    player.eliminatedAt = 123;
    player.account = { image: "https://avatar.example/a.png" };
    const { ui } = open("feedback", { snapshot });
    const screen = await ui.screen("faker");
    expect(screen.players[0]).toMatchObject({
      revealedRole: "undercover",
      eliminatedAt: 123,
      avatar: "https://avatar.example/a.png",
    });
  });
});

describe("谁是卧底界面：控件动作", () => {
  test("准备与开始都落到真实命令", async () => {
    const snapshot = baseFakerSnapshot("waiting") as Record<string, unknown>;
    (snapshot.players as Record<string, unknown>[])[1].isReady = false;
    const { ui, calls } = open("waiting", { snapshot, privateState: { playerId: "p2" } });
    await ui.screen("faker");
    const result = await ui.run("faker", [{ action: "click", control: "faker.ready" }]);
    expect(result.ok).toBe(true);
    expect(result.steps[0]?.feedback).toBe("已准备");
    expect(payloadOf(calls, "player.setReady")).toEqual({ ready: true });
  });

  test("指定主持人、投票、弃票与夜晚行动都按控件编号还原目标", async () => {
    const assign = alivePlayers(inPhase("assigningQuestioner"));
    const first = open("assigningQuestioner", { snapshot: assign });
    await first.ui.run("faker", [{ action: "click", control: "faker.questioner.p2" }]);
    expect(payloadOf(first.calls, "game.assignQuestioner")).toEqual({ playerId: "p2" });
    expect((await first.ui.screen("faker")).feedback).toContain("对手");

    const voting = alivePlayers(inPhase("voting"));
    const vote = open("voting", { snapshot: voting });
    await vote.ui.screen("faker");
    await vote.ui.run("faker", [{ action: "click", control: "faker.vote.p2" }]);
    expect(payloadOf(vote.calls, "game.submitVote")).toEqual({ targetId: "p2" });
    await vote.ui.run("faker", [{ action: "click", control: "faker.vote.abstain" }]);
    expect(lastPayloadOf(vote.calls, "game.submitVote")).toEqual({ targetId: ABSTAIN_TARGET_ID });

    const night = alivePlayers(inPhase("night"));
    const act = open("night", { snapshot: night, privateState: { role: "undercover" } });
    await act.ui.screen("faker");
    await act.ui.run("faker", [{ action: "click", control: "faker.night.p2" }]);
    expect(payloadOf(act.calls, "game.submitNightAction")).toEqual({ targetId: "p2" });
    await act.ui.run("faker", [{ action: "click", control: "faker.night.skip" }]);
    expect(lastPayloadOf(act.calls, "game.submitNightAction")).toEqual({ targetId: null });
  });

  test("撤销投票与撤销夜晚行动各自回到自己的命令", async () => {
    const snapshot = alivePlayers(inPhase("voting"));
    const cancel = open("voting", {
      snapshot,
      privateState: { myCurrentVoteTargetId: "p2" },
    });
    await cancel.ui.run("faker", [{ action: "click", control: "faker.cancelVote" }]);
    expect(typesOf(cancel.calls)).toEqual(["game.cancelVote"]);

    const night = alivePlayers(inPhase("night"));
    const cancelNight = open("night", {
      snapshot: night,
      privateState: { role: "civilian", nightActionSubmitted: true },
    });
    await cancelNight.ui.run("faker", [{ action: "click", control: "faker.cancelNight" }]);
    expect(typesOf(cancelNight.calls)).toEqual(["game.cancelNightAction"]);
  });

  test("白板猜词的发起、提交与裁定", async () => {
    const entry = alivePlayers(inPhase("description"));
    const start = open("description", {
      snapshot: entry,
      privateState: { canSubmitBlankGuess: true },
    });
    await start.ui.run("faker", [{ action: "click", control: "faker.blank.enter" }]);
    expect(typesOf(start.calls)).toEqual(["game.enterBlankGuess"]);

    const guessSnapshot = alivePlayers(inPhase("blankGuess", { blankGuessPlayerId: "p1" }));
    const guess = open("blankGuess", { snapshot: guessSnapshot });
    const result = await guess.ui.run("faker", [
      { action: "focus", control: "faker.blank.a" },
      { action: "type", text: "苹果" },
      { action: "focus", control: "faker.blank.b" },
      { action: "type", text: "梨" },
      { action: "click", control: "faker.blank.submit" },
    ]);
    expect(result.ok).toBe(true);
    expect(payloadOf(guess.calls, "game.submitBlankGuess")).toEqual({ words: ["苹果", "梨"] });

    const reviewing = alivePlayers(
      inPhase("blankGuess", { blankGuessPlayerId: "p1", blankGuessPendingReview: true })
    );
    const judge = open("blankGuess", {
      snapshot: reviewing,
      privateState: { playerId: "p2", isQuestioner: true },
    });
    await judge.ui.screen("faker");
    await judge.ui.run("faker", [{ action: "click", control: "faker.blank.approve" }]);
    expect(payloadOf(judge.calls, "game.reviewBlankGuess")).toEqual({ approve: true });
  });

  test("描述按服务端口径截断，超长输入不会打出去", async () => {
    const snapshot = alivePlayers(inPhase("description"));
    const { ui, calls } = open("description", { snapshot });
    await ui.screen("faker");
    ui.state("faker").drafts["faker.description.input"] = "十个汉字的描述刚好占满额度";
    const result = await ui.run("faker", [{ action: "click", control: "faker.description.send" }]);
    expect(result.ok).toBe(true);
    expect(payloadOf(calls, "game.submitDescription")).toEqual({ text: "十个汉字的描述刚好占" });
  });

  test("回车发送描述，其它按键与控件不绑动作", async () => {
    const snapshot = alivePlayers(inPhase("description"));
    const { ui, calls } = open("description", { snapshot });
    await ui.screen("faker");
    ui.state("faker").drafts["faker.description.input"] = "梨";
    const result = await ui.run("faker", [
      { action: "focus", control: "faker.description.input" },
      { action: "press", key: "Enter" },
    ]);
    expect(result.ok).toBe(true);
    expect(payloadOf(calls, "game.submitDescription")).toEqual({ text: "梨" });

    const miss = await ui.run("faker", [
      { action: "focus", control: "chat.input" },
      { action: "press", key: "Escape" },
    ]);
    expect(miss.ok).toBe(false);
    expect(miss.steps.at(-1)?.feedback).toContain("没有绑定按键");
  });

  test("聊天为空不发送，回车与点击都拒", async () => {
    const { ui } = open("waiting");
    const empty = await ui.run("faker", [{ action: "click", control: "chat.send" }]);
    expect(empty.ok).toBe(false);
    expect(empty.steps.at(-1)?.feedback).toContain("禁用");
  });

  test("谁是卧底没有可设置取值的控件，误用 set 直接报错", async () => {
    const { ui } = open("waiting");
    const result = await ui.run("faker", [
      { action: "focus", control: "chat.input" },
      { action: "set", control: "chat.input", value: "1" },
    ]);
    expect(result.steps.at(-1)).toMatchObject({
      ok: false,
      feedback: "控件「聊天消息」不是可设置取值的控件",
    });
  });

  test("控件不存在时给出可读提示并停在失败步骤", async () => {
    const { ui } = open("waiting");
    const result = await ui.run("faker", [{ action: "click", control: "faker.nope" }]);
    expect(result.ok).toBe(false);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.feedback).toContain("在当前页面不可见");
  });

  test("描述截断按显示宽度算，半角字符不占双倍", () => {
    expect(clampSpeech("abcdefghijklmnopqrst")).toBe("abcdefghijklmnopqrst");
    expect(clampSpeech("abcdefghijklmnopqrstu")).toBe("abcdefghijklmnopqrst");
    expect(clampSpeech("五个汉字加五个字")).toBe("五个汉字加五个字");
    expect(clampSpeech("十个汉字的描述刚好占满额度")).toBe("十个汉字的描述刚好占");
    expect(clampSpeech("")).toBe("");
  });

  test("私密状态里的词语与特权预览会出现在本人面板，但绝不进聊天控件", async () => {
    const snapshot = inPhase("wordSubmission");
    const { ui } = open("wordSubmission", {
      snapshot,
      privateState: {
        isQuestioner: true,
        role: "civilian",
        side: "light",
        word: "苹果",
        blankHint: "自由发挥",
        angelWordOptions: ["a"],
        globalWords: { civilianWord: "苹果" },
        questionerView: [{ playerId: "p2" }],
        privilegedActionPreview: { votes: [] },
      },
    });
    const screen = await ui.screen("faker");
    expect(screen.you).toMatchObject({
      role: "civilian",
      side: "light",
      word: "苹果",
      blankHint: "自由发挥",
      angelWordOptions: ["a"],
      globalWords: { civilianWord: "苹果" },
      questionerView: [{ playerId: "p2" }],
      privilegedActionPreview: { votes: [] },
    });
    expect(screen.panel).toMatchObject({
      day: 1,
      blankGuessPendingReview: false,
    });
  });

  test("房间号变化时清空本地草稿，换房不会带着上一间的输入", async () => {
    const snapshot = inPhase("wordSubmission");
    const { ui } = open("wordSubmission", { snapshot, privateState: { isQuestioner: true } });
    ui.state("faker").drafts["faker.word.civilian"] = "苹果";
    await ui.screen("faker");
    snapshot.roomId = "5678";
    const screen = await ui.screen("faker");
    expect(screen.controls.find((control) => control.id === "faker.word.civilian")).toMatchObject({
      value: "",
    });
  });

  test("SeatUi 在没有房间画面时报错提示先入房", async () => {
    const client = {
      name: "TestAgent",
      currentRoom: () => undefined,
      currentSnapshot: () => undefined,
      currentPrivateState: () => undefined,
      currentPlayerId: () => undefined,
      sendInRoom: async () => ({}),
      publishAgentFocus: async () => {},
      stateVersion: () => 0,
      waitForStateChange: async () => true,
    } as unknown as AgentGameClient;
    const ui = new SeatUi(client, { pacing: false });
    await expect(ui.screen("faker")).rejects.toThrow("尚未收到房间画面");
  });
});
