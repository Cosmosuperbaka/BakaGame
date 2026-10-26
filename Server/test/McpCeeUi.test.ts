import { describe, expect, test } from "bun:test";

import { idsOf, lastPayloadOf, mcpFixture, payloadOf, typesOf } from "./McpFixtures";

const player = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  name: id === "p1" ? "测试员" : "对手",
  online: true,
  ready: false,
  team: null,
  membership: "active",
  score: 0,
  status: "waiting",
  attempts: 0,
  marks: "",
  ...overrides,
});

const ceeSnapshot = (phase: string, overrides: Record<string, unknown> = {}) => ({
  roomId: "1234",
  name: "猜番房",
  source: "local",
  phase,
  hostPlayerId: "p1",
  settings: { allowAgents: true, answerMode: "manual", subjectSearch: true },
  players: [player("p1", { isHost: true }), player("p2")],
  spectateRequests: [],
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
    game: "cee",
    snapshot: options.snapshot ?? ceeSnapshot(phase),
    privateState: { playerId: "p1", ...options.privateState },
    handler: options.handler,
  });

const searchHandler = (
  results: Array<Record<string, unknown>> = [
    { id: 7, name: "Hitori", nameCn: "后藤一里" },
    { id: 8, name: "Nijika", nameCn: "伊地知虹夏" },
  ]
) =>
  ((type: string) => {
    if (type === "cee.character.search" || type === "cee.subject.search") return { results };
    if (type === "cee.subject.characters")
      return { results: [{ id: 7, name: "Hitori", nameCn: "后藤一里" }] };
    return { ok: true };
  }) as never;

describe("猜角色界面：阶段与控件", () => {
  test("等待阶段房主能开局，未指定出题人时按钮带说明", async () => {
    const { ui } = open("waiting", { privateState: { canStart: false } });
    const screen = await ui.screen("cee");
    expect(screen.controls[0]).toMatchObject({
      id: "cee.start",
      label: "开始并指定出题人",
      disabled: true,
      hint: "等待其他玩家准备，或暂无可选出题人",
    });
    expect(screen.title).toBe("等待开始");
  });

  test("活跃玩家看到准备与组队，队伍控件带 8 个队与不组队", async () => {
    const { ui } = open("waiting", { privateState: { playerId: "p2" } });
    const screen = await ui.screen("cee");
    expect(idsOf(screen.controls)).toEqual(["cee.ready", "cee.team", "chat.input", "chat.send"]);
    const team = screen.controls.find((control) => control.id === "cee.team");
    expect(team).toMatchObject({ role: "select", value: "none", hint: "同队共享猜测次数" });
    expect(team?.options?.map((option) => option.value)).toEqual([
      "none",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
    ]);
  });

  test("旁观申请逐个给出批准与拒绝按钮", async () => {
    const snapshot = ceeSnapshot("waiting", {
      spectateRequests: [{ playerId: "p2", name: "对手" }, { name: "缺编号" }],
    });
    const { ui } = open("waiting", { snapshot });
    const screen = await ui.screen("cee");
    expect(idsOf(screen.controls)).toEqual([
      "cee.start",
      "cee.team",
      "cee.spectate.approve.p2",
      "cee.spectate.reject.p2",
      "chat.input",
      "chat.send",
    ]);
  });

  test("指定出题人只列出候选，并保留返回等待", async () => {
    const snapshot = ceeSnapshot("choosingSetter");
    const { ui } = open("choosingSetter", {
      snapshot,
      privateState: { setterCandidateIds: ["p2"] },
    });
    const screen = await ui.screen("cee");
    expect(idsOf(screen.controls)).toEqual([
      "cee.setter.p2",
      "cee.cancel",
      "chat.input",
      "chat.send",
    ]);
    expect(screen.controls[0]?.data).toEqual({ playerId: "p2", membership: "active", team: null });
  });

  test("非房主在指定出题人阶段没有任何局内控件", async () => {
    const { ui } = open("choosingSetter", { privateState: { playerId: "p2" } });
    expect(idsOf(await (await ui.screen("cee")).controls)).toEqual(["chat.input", "chat.send"]);
  });

  test("准备与结算阶段按来源给出不同按钮", async () => {
    const preparing = open("preparing", {
      snapshot: ceeSnapshot("preparing", { source: "native" }),
    });
    expect(idsOf(await (await preparing.ui.screen("cee")).controls)).toContain("cee.cancel");

    const remotePreparing = open("preparing", {
      snapshot: ceeSnapshot("preparing", { source: "native", hostPlayerId: "p2" }),
    });
    expect(idsOf(await (await remotePreparing.ui.screen("cee")).controls)).not.toContain(
      "cee.cancel"
    );

    const settled = open("settled");
    const screen = await settled.ui.screen("cee");
    expect(idsOf(screen.controls)).toContain("cee.next");
    expect(screen.controls.find((control) => control.id === "cee.next")?.label).toBe(
      "指定下一局出题人"
    );

    const nativeSettled = open("settled", {
      snapshot: ceeSnapshot("settled", { source: "native" }),
      privateState: { canStart: true },
    });
    const native = await nativeSettled.ui.screen("cee");
    expect(idsOf(native.controls)).toEqual(["cee.next", "cee.start", "chat.input", "chat.send"]);
    expect(native.notice).toBeUndefined();

    const guest = open("settled", {
      snapshot: ceeSnapshot("settled", { source: "native" }),
      privateState: { playerId: "p2" },
    });
    expect((await guest.ui.screen("cee")).notice).toBe("等待房主开始下一局");
  });

  test("答题阶段只有出题人拿到搜索与提示控件", async () => {
    const waiting = open("answering", {
      snapshot: ceeSnapshot("answering", { setterPlayerId: "p2" }),
      privateState: { playerId: "p1", canSetAnswer: false },
    });
    const screen = await waiting.ui.screen("cee");
    expect(screen.notice).toBe("等待 对手 出题");
    expect(idsOf(screen.controls)).toEqual(["chat.input", "chat.send"]);

    const setter = open("answering", {
      privateState: { canSetAnswer: true, bannedCharacterIds: [8] },
    });
    const setterScreen = await setter.ui.screen("cee");
    expect(idsOf(setterScreen.controls)).toEqual([
      "cee.answer.search.input",
      "cee.answer.search.mode.character",
      "cee.answer.search.mode.subject",
      "cee.answer.hint.0",
      "cee.answer.hint.1",
      "cee.answer.hint.2",
      "cee.answer.confirm",
      "chat.input",
      "chat.send",
    ]);
    expect(
      setterScreen.controls.find((control) => control.id === "cee.answer.confirm")
    ).toMatchObject({ disabled: true });
  });

  test("搜索框在检索中才出现立即搜索，结果按禁用态还原已选过的角色", async () => {
    const setter = open("answering", {
      privateState: { canSetAnswer: true, bannedCharacterIds: [8] },
    });
    await setter.ui.screen("cee");
    setter.ui.state("cee").search = {
      prefix: "cee.answer.search",
      purpose: "cee_answer",
      kind: "character",
      keyword: "后藤",
      status: "loading",
      results: [],
    };
    let screen = await setter.ui.screen("cee");
    expect(idsOf(screen.controls)).toContain("cee.answer.search.refresh");

    setter.ui.state("cee").search = {
      prefix: "cee.answer.search",
      purpose: "cee_answer",
      kind: "character",
      keyword: "后藤",
      status: "ready",
      results: [
        { id: 7, name: "Hitori", nameCn: "后藤一里" },
        { id: 8, name: "Nijika", nameCn: "伊地知虹夏" },
      ],
    };
    screen = await setter.ui.screen("cee");
    const results = screen.controls.filter((control) =>
      control.id.startsWith("cee.answer.search.result.")
    );
    expect(idsOf(results)).toEqual(["cee.answer.search.result.0", "cee.answer.search.result.1"]);
    expect(results[0]).toMatchObject({ label: "后藤一里", disabled: false });
    expect(results[1]).toMatchObject({
      label: "伊地知虹夏",
      disabled: true,
      hint: "这位角色本局已被选过",
    });
  });

  test("搜作品模式先列作品，点开作品后带返回按钮并列出角色", async () => {
    const setter = open("answering", { privateState: { canSetAnswer: true } });
    await setter.ui.screen("cee");
    setter.ui.state("cee").search = {
      prefix: "cee.answer.search",
      purpose: "cee_answer",
      kind: "subject",
      keyword: "孤独摇滚",
      status: "ready",
      results: [{ id: 300, name: "Bocchi", nameCn: "孤独摇滚", type: "animation" }],
    };
    let screen = await setter.ui.screen("cee");
    expect(
      screen.controls.find((control) => control.id === "cee.answer.search.mode.subject")
    ).toMatchObject({ disabled: true, hint: "当前查询范围" });
    expect(screen.controls.find((control) => control.id === "cee.answer.search.input")?.label).toBe(
      "搜索作品"
    );
    expect(
      screen.controls.find((control) => control.id === "cee.answer.search.result.0")?.data
    ).toMatchObject({ kind: "subject", id: 300 });

    setter.ui.state("cee").search = {
      prefix: "cee.answer.search",
      purpose: "cee_answer",
      kind: "subject",
      keyword: "孤独摇滚",
      status: "ready",
      subject: { id: 300, name: "Bocchi", nameCn: "孤独摇滚" },
      results: [{ id: 7, name: "Hitori", nameCn: "后藤一里" }],
    };
    screen = await setter.ui.screen("cee");
    expect(idsOf(screen.controls)).toContain("cee.answer.search.back");
    const cast = screen.controls.find((control) => control.id === "cee.answer.search.result.0");
    expect(cast?.data).toMatchObject({ kind: "character", pickedSubject: { id: 300 } });
    expect(screen.panel).toMatchObject({
      search: { kind: "character", subject: { id: 300, nameCn: "孤独摇滚" } },
    });
  });

  test("已选答案出现在面板上，确认前不提交", async () => {
    const setter = open("answering", { privateState: { canSetAnswer: true } });
    await setter.ui.screen("cee");
    setter.ui.state("cee").ceeAnswer = { id: 7, name: "Hitori", nameCn: "后藤一里" };
    const screen = await setter.ui.screen("cee");
    expect(idsOf(screen.controls)).toContain("cee.answer.selected");
    expect(idsOf(screen.controls)).toContain("cee.answer.selected.clear");
    expect(screen.controls.find((control) => control.id === "cee.answer.confirm")?.disabled).toBe(
      false
    );
    expect(screen.panel).toMatchObject({ selectedAnswer: { id: 7 } });
  });

  test("猜测阶段按能力位给出图片提示、搜索与放弃", async () => {
    const guessing = open("guessing", {
      privateState: { canGuess: true, canSurrender: true, imageHintAvailable: true },
    });
    const screen = await guessing.ui.screen("cee");
    expect(idsOf(screen.controls)).toEqual([
      "cee.hint.image",
      "cee.guess.search.input",
      "cee.guess.search.mode.character",
      "cee.guess.search.mode.subject",
      "cee.guess.surrender",
      "chat.input",
      "chat.send",
    ]);
    expect(screen.controls[0]).toMatchObject({ hint: "当前第 0 级" });
    // 关掉作品搜索就不给「搜作品」入口。
    const noSubject = open("guessing", {
      snapshot: ceeSnapshot("guessing", { settings: { subjectSearch: false } }),
      privateState: { canGuess: true },
    });
    expect(idsOf(await (await noSubject.ui.screen("cee")).controls)).not.toContain(
      "cee.guess.search.mode.subject"
    );
  });

  test("未知阶段只留聊天栏，标题退回游戏名", async () => {
    const { ui } = open("teleporting");
    const screen = await ui.screen("cee");
    expect(screen.title).toBe("猜角色");
    expect(idsOf(screen.controls)).toEqual(["chat.input", "chat.send"]);
  });

  test("玩家栏带出账号头像", async () => {
    const snapshot = ceeSnapshot("waiting");
    (snapshot.players as Record<string, unknown>[])[0].account = {
      image: "https://avatar.example/a.png",
    };
    const { ui } = open("waiting", { snapshot });
    expect((await ui.screen("cee")).players[0]).toMatchObject({
      avatar: "https://avatar.example/a.png",
    });
  });
});

describe("猜角色界面：控件动作", () => {
  test("准备、开局、推进、取消与放弃都落到真实命令", async () => {
    const ready = open("waiting", { privateState: { playerId: "p2" } });
    await ready.ui.screen("cee");
    await ready.ui.run("cee", [{ action: "click", control: "cee.ready" }]);
    expect(payloadOf(ready.calls, "cee.player.ready")).toEqual({ ready: true });

    const start = open("waiting", { privateState: { canStart: true } });
    await start.ui.screen("cee");
    await start.ui.run("cee", [{ action: "click", control: "cee.start" }]);
    await start.ui.run("cee", [{ action: "click", control: "cee.next" }]);
    expect(typesOf(start.calls)).toContain("cee.game.start");
  });

  test("旁观申请的批准与拒绝带上玩家编号", async () => {
    const snapshot = ceeSnapshot("waiting", {
      spectateRequests: [{ playerId: "p2", name: "对手" }],
    });
    const { ui, calls } = open("waiting", { snapshot });
    await ui.screen("cee");
    await ui.run("cee", [{ action: "click", control: "cee.spectate.approve.p2" }]);
    expect(payloadOf(calls, "cee.player.approveSpectate")).toEqual({
      playerId: "p2",
      approved: true,
    });
    await ui.run("cee", [{ action: "click", control: "cee.spectate.reject.p2" }]);
    expect(lastPayloadOf(calls, "cee.player.approveSpectate")).toEqual({
      playerId: "p2",
      approved: false,
    });
  });

  test("指定出题人与取消本局", async () => {
    const { ui, calls } = open("choosingSetter", {
      snapshot: ceeSnapshot("choosingSetter"),
      privateState: { setterCandidateIds: ["p2"] },
    });
    await ui.screen("cee");
    await ui.run("cee", [{ action: "click", control: "cee.setter.p2" }]);
    expect(payloadOf(calls, "cee.game.chooseSetter")).toEqual({ playerId: "p2" });
    await ui.run("cee", [{ action: "click", control: "cee.cancel" }]);
    expect(lastPayloadOf(calls, "cee.game.cancel")).toEqual({});
  });

  test("输入关键词自动检索，点角色即选定为答案", async () => {
    const { ui } = open("answering", {
      privateState: { canSetAnswer: true },
      handler: searchHandler(),
    });
    const result = await ui.run("cee", [
      { action: "focus", control: "cee.answer.search.input" },
      { action: "type", text: "后藤" },
      { action: "click", control: "cee.answer.search.result.0" },
    ]);
    expect(result.ok).toBe(true);
    expect(ui.state("cee").ceeAnswer).toMatchObject({ id: 7, nameCn: "后藤一里" });
    expect(result.steps.at(1)?.feedback).toContain("2 个字符");
  });

  test("搜索失败把上游错误留在反馈里，不静默清空结果", async () => {
    const { ui } = open("answering", {
      privateState: { canSetAnswer: true },
      handler: (type) => {
        if (type === "cee.character.search") throw new Error("上游超时");
        return { ok: true };
      },
    });
    const result = await ui.run("cee", [
      { action: "focus", control: "cee.answer.search.input" },
      { action: "type", text: "后藤" },
    ]);
    expect(result.ok).toBe(true);
    expect(ui.state("cee").search).toMatchObject({ status: "error", error: "上游超时" });
    // 上游错误留在搜索状态里，下一次读屏能看到，不会被「已输入」反馈盖掉。
    expect((await ui.screen("cee")).panel).toMatchObject({
      search: { status: "error", error: "上游超时", results: [] },
    });
  });

  test("切到搜作品再切回搜角色，模式与结果一起换", async () => {
    const { ui, calls } = open("answering", {
      privateState: { canSetAnswer: true },
      handler: searchHandler([
        { id: 300, name: "Bocchi", nameCn: "孤独摇滚" },
        { id: 301, name: "Other", nameCn: "另一部" },
      ]),
    });
    await ui.screen("cee");
    ui.state("cee").drafts["cee.answer.search.input"] = "孤独";
    let feedback = await ui.run("cee", [
      { action: "click", control: "cee.answer.search.mode.subject" },
    ]);
    expect(feedback.ok).toBe(true);
    expect(ui.state("cee").search).toMatchObject({ kind: "subject", status: "ready" });
    expect(calls.map((call) => call.type)).toContain("cee.subject.search");

    feedback = await ui.run("cee", [
      { action: "click", control: "cee.answer.search.mode.character" },
    ]);
    expect(feedback.steps[0]?.feedback).toBe("已切换到搜角色");
    expect(ui.state("cee").search?.kind).toBe("character");
  });

  test("作品结果先展开角色表，再点角色才作为答案", async () => {
    const { ui, calls } = open("answering", {
      privateState: { canSetAnswer: true },
      handler: searchHandler(),
    });
    await ui.screen("cee");
    ui.state("cee").search = {
      prefix: "cee.answer.search",
      purpose: "cee_answer",
      kind: "subject",
      keyword: "孤独",
      status: "ready",
      results: [{ id: 300, name: "Bocchi", nameCn: "孤独摇滚" }],
    };
    let result = await ui.run("cee", [{ action: "click", control: "cee.answer.search.result.0" }]);
    expect(result.ok).toBe(true);
    expect(ui.state("cee").search).toMatchObject({ subject: { id: 300 } });
    expect(result.steps[0]?.feedback).toContain("共 1 位角色");
    expect(calls.map((call) => call.type)).toContain("cee.subject.characters");

    result = await ui.run("cee", [{ action: "click", control: "cee.answer.search.result.0" }]);
    expect(result.ok).toBe(true);
    expect(ui.state("cee").ceeAnswer).toMatchObject({ id: 7 });

    result = await ui.run("cee", [{ action: "click", control: "cee.answer.search.back" }]);
    expect(result.steps[0]?.feedback).toBe("已返回作品结果");
    expect(ui.state("cee").search?.subject).toBeUndefined();
  });

  test("确认答案带上三条提示，并清掉搜索与草稿", async () => {
    const { ui, calls } = open("answering", {
      privateState: { canSetAnswer: true },
      handler: searchHandler(),
    });
    await ui.screen("cee");
    ui.state("cee").ceeAnswer = { id: 7, name: "Hitori", nameCn: "后藤一里" };
    ui.state("cee").drafts["cee.answer.hint.0"] = "粉发";
    ui.state("cee").drafts["cee.answer.hint.1"] = "  ";
    ui.state("cee").drafts["cee.answer.hint.2"] = "吉他";
    const result = await ui.run("cee", [{ action: "click", control: "cee.answer.confirm" }]);
    expect(result.ok).toBe(true);
    expect(payloadOf(calls, "cee.game.setAnswer")).toEqual({
      characterId: 7,
      hints: ["粉发", "吉他"],
    });
    expect(ui.state("cee").ceeAnswer).toBeUndefined();
    expect(ui.state("cee").drafts["cee.answer.hint.0"]).toBeUndefined();
  });

  test("没选答案就确认、结果越界与非法编号都给出可读错误", async () => {
    const { ui } = open("answering", { privateState: { canSetAnswer: true } });
    await ui.screen("cee");
    let result = await ui.run("cee", [{ action: "click", control: "cee.answer.confirm" }]);
    expect(result.steps[0]?.feedback).toBe("控件「确认答案并开始」当前是禁用的");

    ui.state("cee").search = {
      prefix: "cee.answer.search",
      purpose: "cee_answer",
      kind: "character",
      keyword: "x",
      status: "ready",
      results: [{ id: 7, nameCn: "后藤一里" }],
    };
    result = await ui.run("cee", [{ action: "click", control: "cee.answer.search.result.9" }]);
    expect(result.steps[0]?.feedback).toContain("在当前页面不可见");

    ui.state("cee").search = {
      prefix: "cee.answer.search",
      purpose: "cee_answer",
      kind: "character",
      keyword: "x",
      status: "loading",
      results: [{ id: 7 }],
    };
    result = await ui.run("cee", [{ action: "click", control: "cee.answer.search.result.0" }]);
    expect(result.steps[0]?.feedback).toBe("搜索还没有完成");

    // 已选答案缺合法编号时不允许开局，而不是把 NaN 发给上游。
    ui.state("cee").ceeAnswer = { id: "abc", nameCn: "无编号" };
    result = await ui.run("cee", [{ action: "click", control: "cee.answer.confirm" }]);
    expect(result.steps[0]?.feedback).toBe("角色编号无效");
  });

  test("清除已选答案与点按已选条目", async () => {
    const { ui } = open("answering", { privateState: { canSetAnswer: true } });
    await ui.screen("cee");
    ui.state("cee").ceeAnswer = { id: 7, nameCn: "后藤一里" };
    let result = await ui.run("cee", [{ action: "click", control: "cee.answer.selected.clear" }]);
    expect(result.steps[0]?.feedback).toBe("已清除已选答案");
    expect(ui.state("cee").ceeAnswer).toBeUndefined();

    ui.state("cee").ceeAnswer = { id: 7, nameCn: "后藤一里" };
    result = await ui.run("cee", [{ action: "click", control: "cee.answer.selected" }]);
    expect(result.steps[0]?.feedback).toContain("确认后才会提交");
  });

  test("猜结果直接提交猜测并清空搜索", async () => {
    const { ui, calls } = open("guessing", {
      privateState: { canGuess: true },
      handler: searchHandler(),
    });
    await ui.screen("cee");
    ui.state("cee").search = {
      prefix: "cee.guess.search",
      purpose: "cee_guess",
      kind: "character",
      keyword: "后藤",
      status: "ready",
      results: [{ id: 7, name: "Hitori", nameCn: "后藤一里" }],
    };
    const result = await ui.run("cee", [{ action: "click", control: "cee.guess.search.result.0" }]);
    expect(result.ok).toBe(true);
    expect(payloadOf(calls, "cee.game.guess")).toEqual({ characterId: 7 });
    expect(ui.state("cee").search).toBeUndefined();
    expect(ui.state("cee").drafts["cee.guess.search.input"]).toBeUndefined();
  });

  test("猜测侧展开作品时缺编号会拒绝，放弃本局走自己的命令", async () => {
    const { ui, calls } = open("guessing", {
      privateState: { canGuess: true, canSurrender: true },
      handler: searchHandler(),
    });
    await ui.screen("cee");
    ui.state("cee").search = {
      prefix: "cee.guess.search",
      purpose: "cee_guess",
      kind: "subject",
      keyword: "x",
      status: "ready",
      results: [{ name: "无编号作品" }],
    };
    let result = await ui.run("cee", [{ action: "click", control: "cee.guess.search.result.0" }]);
    expect(result.steps[0]?.feedback).toBe("作品编号无效");

    result = await ui.run("cee", [{ action: "click", control: "cee.guess.surrender" }]);
    expect(result.ok).toBe(true);
    expect(calls.map((call) => call.type)).toContain("cee.game.surrender");
  });

  test("图片提示按当前档位记录，没有 dataUrl 时不冒充拿到图", async () => {
    const { ui } = open("guessing", {
      privateState: { canGuess: true, imageHintAvailable: true, imageHintLevel: 2 },
      handler: (type) =>
        type === "cee.game.imageHint" ? { dataUrl: "data:image/png;base64,AA" } : { ok: true },
    });
    await ui.screen("cee");
    let result = await ui.run("cee", [{ action: "click", control: "cee.hint.image" }]);
    expect(result.ok).toBe(true);
    expect(ui.state("cee").ceeImage).toEqual({ level: 2, dataUrl: "data:image/png;base64,AA" });

    const empty = open("guessing", {
      privateState: { canGuess: true, imageHintAvailable: true },
      handler: () => ({ ok: true }),
    });
    await empty.ui.screen("cee");
    result = await empty.ui.run("cee", [{ action: "click", control: "cee.hint.image" }]);
    expect(result.steps[0]?.feedback).toBe("已获取图片提示");
    expect(empty.ui.state("cee").ceeImage).toBeUndefined();
  });

  test("立即搜索按钮与回车都重新检索", async () => {
    const { ui, calls } = open("answering", {
      privateState: { canSetAnswer: true },
      handler: searchHandler(),
    });
    await ui.screen("cee");
    ui.state("cee").drafts["cee.answer.search.input"] = "后藤";
    ui.state("cee").search = {
      prefix: "cee.answer.search",
      purpose: "cee_answer",
      kind: "character",
      keyword: "后藤",
      status: "loading",
      results: [],
    };
    let result = await ui.run("cee", [{ action: "click", control: "cee.answer.search.refresh" }]);
    expect(result.steps[0]?.feedback).toBe("已重新搜索");
    expect(calls.map((call) => call.type)).toContain("cee.character.search");

    result = await ui.run("cee", [
      { action: "focus", control: "cee.answer.search.input" },
      { action: "press", key: "Enter" },
    ]);
    expect(result.ok).toBe(true);
    expect(result.steps.at(-1)?.feedback).toBe("已立即搜索");
  });

  test("聊天回车发送，空内容拒绝", async () => {
    const { ui, calls } = open("waiting");
    await ui.screen("cee");
    ui.state("cee").drafts["chat.input"] = "大家好";
    let result = await ui.run("cee", [
      { action: "focus", control: "chat.input" },
      { action: "press", key: "Enter" },
    ]);
    expect(result.ok).toBe(true);
    expect(payloadOf(calls, "cee.chat.send")).toEqual({ text: "大家好" });

    result = await ui.run("cee", [
      { action: "focus", control: "chat.input" },
      { action: "press", key: "Enter" },
    ]);
    expect(result.steps.at(-1)?.feedback).toBe("聊天内容不能为空");
  });

  test("组队取值只接受 1–8 或不组队", async () => {
    const { ui, calls } = open("waiting", { privateState: { playerId: "p2" } });
    await ui.screen("cee");
    let result = await ui.run("cee", [{ action: "set", control: "cee.team", value: "3" }]);
    expect(result.ok).toBe(true);
    expect(payloadOf(calls, "cee.player.team")).toEqual({ team: 3 });

    result = await ui.run("cee", [{ action: "set", control: "cee.team", value: "none" }]);
    expect(result.steps[0]?.feedback).toBe("已退出队伍");
    expect(lastPayloadOf(calls, "cee.player.team")).toEqual({ team: null });

    result = await ui.run("cee", [{ action: "set", control: "cee.team", value: "9" }]);
    expect(result.steps[0]?.feedback).toBe("队伍必须是 1–8 或不组队");

    result = await ui.run("cee", [{ action: "set", control: "cee.ready", value: "1" }]);
    expect(result.steps[0]?.feedback).toContain("不是可设置取值的控件");
  });

  test("非回车按键与不可操作控件都明确失败", async () => {
    const { ui } = open("waiting", { privateState: { canStart: true } });
    await ui.screen("cee");
    let result = await ui.run("cee", [
      { action: "focus", control: "cee.start" },
      { action: "press", key: "Tab" },
    ]);
    expect(result.steps.at(-1)?.feedback).toContain("没有绑定按键");

    result = await ui.run("cee", [{ action: "click", control: "cee.guess.surrender" }]);
    expect(result.steps[0]?.feedback).toContain("在当前页面不可见");
  });

  test("非搜索控件的输入不会触发自动检索", async () => {
    const { ui, calls } = open("answering", { privateState: { canSetAnswer: true } });
    await ui.screen("cee");
    ui.state("cee").drafts["chat.input"] = "你好";
    const result = await ui.run("cee", [
      { action: "focus", control: "chat.input" },
      { action: "type", text: "你好" },
    ]);
    expect(result.ok).toBe(true);
    expect(ui.state("cee").search).toBeUndefined();
    expect(typesOf(calls)).toEqual([]);
  });
});
