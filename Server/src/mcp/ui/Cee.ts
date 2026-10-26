import {
  assemble,
  button,
  chatControls,
  control,
  isRecord,
  list,
  playerName,
  recordList,
  section,
  str,
  textbox,
  type UiContext,
  type UiSearchState,
} from "./Support";
import type { UiControl, UiScreen } from "./Types";

const PHASE_TITLES: Record<string, string> = {
  waiting: "等待开始",
  choosingSetter: "指定出题人",
  preparing: "正在准备题目",
  answering: "选择本局答案",
  guessing: "猜猜是哪位角色",
  settled: "答案揭晓",
};

const meOf = (context: UiContext) =>
  recordList(context.snapshot.players).find(
    (player) => player.id === (context.playerId ?? context.privateState.playerId)
  );

const isHost = (context: UiContext): boolean =>
  context.snapshot.hostPlayerId === (context.playerId ?? context.privateState.playerId);

const settingsOf = (context: UiContext): Record<string, unknown> =>
  isRecord(context.snapshot.settings) ? context.snapshot.settings : {};

const ceePlayers = (snapshot: Record<string, unknown>) =>
  recordList(snapshot.players).map((player) => ({
    id: player.id,
    name: player.name,
    online: player.online,
    ready: player.ready,
    team: player.team,
    membership: player.membership,
    score: player.score,
    status: player.status,
    attempts: player.attempts,
    marks: player.marks,
    isAgent: player.isAgent,
    mcpControlled: player.mcpControlled,
    ...(isRecord(player.account) && typeof player.account.image === "string"
      ? { avatar: player.account.image }
      : {}),
  }));

const characterView = (character: Record<string, unknown>): Record<string, unknown> => ({
  id: character.id,
  name: character.name,
  nameCn: character.nameCn,
  imageUrl: character.imageUrl,
});

const subjectView = (subject: Record<string, unknown>): Record<string, unknown> => ({
  id: subject.id,
  name: subject.name,
  nameCn: subject.nameCn,
  type: subject.type,
  year: subject.year,
  rating: subject.rating,
  heat: subject.heat,
  imageUrl: subject.imageUrl,
});

const canStart = (context: UiContext): boolean => context.privateState.canStart === true;

const teamControl = (context: UiContext): UiControl | undefined => {
  const me = meOf(context);
  if (!me || me.membership !== "active" || context.snapshot.phase !== "waiting") return undefined;
  return control("cee.team", "队伍", "select", "game", {
    value: typeof me.team === "number" ? String(me.team) : "none",
    options: [
      { value: "none", label: "不组队" },
      ...Array.from({ length: 8 }, (_, index) => ({
        value: String(index + 1),
        label: `${index + 1} 队`,
      })),
    ],
    hint: "同队共享猜测次数",
  });
};

const waitingControls = (context: UiContext): UiControl[] => {
  const me = meOf(context);
  const controls: UiControl[] = [];
  if (isHost(context)) {
    controls.push(
      button(
        "cee.start",
        settingsOf(context).answerMode === "manual" ? "开始并指定出题人" : "开始游戏",
        "game",
        {
          disabled: !canStart(context),
          hint: !canStart(context) ? "等待其他玩家准备，或暂无可选出题人" : undefined,
        }
      )
    );
  } else if (me?.membership === "active") {
    controls.push(button("cee.ready", me.ready === true ? "取消准备" : "准备"));
  }
  const team = teamControl(context);
  if (team) controls.push(team);
  const requests = recordList(context.snapshot.spectateRequests);
  if (isHost(context) && requests.length) {
    for (const request of requests) {
      const playerId = str(request.playerId);
      if (!playerId) continue;
      controls.push(
        button(`cee.spectate.approve.${playerId}`, `批准 ${String(request.name)} 旁观`),
        button(`cee.spectate.reject.${playerId}`, `拒绝 ${String(request.name)} 旁观`)
      );
    }
  }
  return controls;
};

const choosingControls = (context: UiContext): UiControl[] => {
  if (!isHost(context)) return [];
  const allowed = new Set(list(context.privateState.setterCandidateIds));
  const controls = recordList(context.snapshot.players)
    .filter((player) => allowed.has(player.id))
    .map((player) =>
      button(`cee.setter.${String(player.id)}`, `指定 ${String(player.name)}`, "game", {
        data: { playerId: player.id, membership: player.membership, team: player.team },
      })
    );
  controls.push(button("cee.cancel", "返回等待"));
  return controls;
};

const searchModeControls = (
  context: UiContext,
  prefix: string,
  allowSubjects: boolean,
  current: "character" | "subject"
): UiControl[] => {
  const controls: UiControl[] = [
    button(`${prefix}.mode.character`, allowSubjects ? "搜角色" : "搜索角色", "game", {
      disabled: current === "character",
      hint: current === "character" ? "当前查询范围" : undefined,
    }),
  ];
  if (allowSubjects) {
    controls.push(
      button(`${prefix}.mode.subject`, "搜作品", "game", {
        disabled: current === "subject",
        hint: current === "subject" ? "当前查询范围" : undefined,
      })
    );
  }
  return controls;
};

const searchControls = (
  context: UiContext,
  prefix: string,
  purpose: UiSearchState["purpose"],
  allowSubjects: boolean
): UiControl[] => {
  const search = context.state.search;
  const current =
    search?.prefix === prefix ? (search.kind === "subject" ? "subject" : "character") : "character";
  const busy = search?.prefix === prefix ? search.status === "loading" : false;
  const controls: UiControl[] = [
    textbox(
      `${prefix}.input`,
      current === "subject" ? "搜索作品" : "搜索角色",
      context.state.drafts[`${prefix}.input`] ?? "",
      "game",
      {
        maxLength: 80,
        hint: "停止输入后自动检索；点角色提交，搜作品时先点作品再选角色",
      }
    ),
    ...searchModeControls(context, prefix, allowSubjects, current),
  ];
  if (busy) controls.push(button(`${prefix}.refresh`, "立即搜索", "game"));
  if (!search || search.prefix !== prefix) return controls;
  if (search.subject) controls.push(button(`${prefix}.back`, "返回作品", "game"));
  const banned = new Set(list(context.privateState.bannedCharacterIds));
  search.results.forEach((result, index) => {
    const isCast = Boolean(search.subject);
    const view =
      isCast || search.kind === "character" ? characterView(result) : subjectView(result);
    const disabled = (isCast || search.kind === "character") && banned.has(Number(view.id));
    controls.push(
      control(
        `${prefix}.result.${index}`,
        str(view.nameCn) || str(view.name) || `结果 ${index + 1}`,
        "listitem",
        "game",
        {
          disabled,
          hint: disabled ? "这位角色本局已被选过" : undefined,
          data: {
            ...view,
            kind: isCast || search.kind === "character" ? "character" : "subject",
            ...(purpose === "cee_answer" && isCast ? { pickedSubject: search.subject } : {}),
          },
        }
      )
    );
  });
  return controls;
};

const answerSelectedControl = (context: UiContext): UiControl[] => {
  const answer = context.state.ceeAnswer;
  if (!answer) return [];
  return [
    control("cee.answer.selected", "已选择答案", "listitem", "game", {
      data: characterView(answer),
    }),
    button("cee.answer.selected.clear", "清除已选答案"),
  ];
};

const answerControls = (context: UiContext): UiControl[] => {
  if (context.privateState.canSetAnswer !== true) return [];
  const controls = [
    ...searchControls(context, "cee.answer.search", "cee_answer", true),
    ...answerSelectedControl(context),
  ];
  for (let index = 0; index < 3; index += 1) {
    controls.push(
      textbox(
        `cee.answer.hint.${index}`,
        `文本提示 ${index + 1}`,
        context.state.drafts[`cee.answer.hint.${index}`] ?? "",
        "game",
        { maxLength: 30 }
      )
    );
  }
  controls.push(
    button("cee.answer.confirm", "确认答案并开始", "game", {
      disabled: !context.state.ceeAnswer,
    })
  );
  if (isHost(context) && context.snapshot.source === "native")
    controls.push(button("cee.cancel", "取消本局"));
  return controls;
};

const hintControls = (context: UiContext): UiControl[] => {
  const controls: UiControl[] = [];
  if (context.privateState.imageHintAvailable === true) {
    controls.push(
      button("cee.hint.image", "查看图片提示", "game", {
        hint: `当前第 ${
          typeof context.privateState.imageHintLevel === "number"
            ? context.privateState.imageHintLevel
            : 0
        } 级`,
      })
    );
  }
  return controls;
};

const guessControls = (context: UiContext): UiControl[] => {
  const controls = hintControls(context);
  if (context.privateState.canGuess === true) {
    controls.push(
      ...searchControls(
        context,
        "cee.guess.search",
        "cee_guess",
        settingsOf(context).subjectSearch === true
      )
    );
  }
  if (context.privateState.canSurrender === true) {
    controls.push(button("cee.guess.surrender", "放弃本局"));
  }
  return controls;
};

const preparingControls = (context: UiContext): UiControl[] =>
  isHost(context) && context.snapshot.source === "native" ? [button("cee.cancel", "取消本局")] : [];

const settledControls = (context: UiContext): UiControl[] => {
  if (!isHost(context)) return [];
  if (context.snapshot.source === "native") {
    return [
      button("cee.next", "返回等待房间"),
      button("cee.start", "再来一轮", "game", {
        disabled: !canStart(context),
      }),
    ];
  }
  return [
    button(
      "cee.next",
      settingsOf(context).answerMode === "manual" ? "指定下一局出题人" : "开始下一局"
    ),
  ];
};

const phaseControls = (context: UiContext): UiControl[] => {
  switch (str(context.snapshot.phase)) {
    case "waiting":
      return waitingControls(context);
    case "choosingSetter":
      return choosingControls(context);
    case "preparing":
      return preparingControls(context);
    case "answering":
      return answerControls(context);
    case "guessing":
      return guessControls(context);
    case "settled":
      return settledControls(context);
    default:
      return [];
  }
};

const searchPanel = (context: UiContext): Record<string, unknown> | undefined => {
  const search = context.state.search;
  if (!search) return undefined;
  const isCast = Boolean(search.subject);
  return {
    prefix: search.prefix,
    keyword: search.keyword,
    kind: isCast ? "character" : search.kind,
    status: search.status,
    error: search.error,
    subject: search.subject ? subjectView(search.subject) : undefined,
    results: search.results.map((result) =>
      isCast || search.kind === "character" ? characterView(result) : subjectView(result)
    ),
  };
};

export function buildCeeScreen(context: UiContext): UiScreen {
  const phase = str(context.snapshot.phase) ?? "waiting";
  const me = meOf(context);
  const sections = [
    section("cee.actions", "可操作控件", phaseControls(context)),
    section("cee.chat", "聊天", chatControls(context.state)),
  ];
  return assemble(
    context,
    {
      phase,
      title: PHASE_TITLES[phase] ?? "猜角色",
      notice:
        phase === "answering" && context.privateState.canSetAnswer !== true
          ? `等待 ${playerName(context.snapshot, context.snapshot.setterPlayerId)} 出题`
          : phase === "settled" && !isHost(context)
            ? "等待房主开始下一局"
            : undefined,
      you: {
        playerId: context.playerId ?? context.privateState.playerId,
        name: me?.name,
        isHost: isHost(context),
        membership: me?.membership,
        canGuess: context.privateState.canGuess === true,
        canSurrender: context.privateState.canSurrender === true,
        canSetAnswer: context.privateState.canSetAnswer === true,
        canStart: canStart(context),
        team: me?.team,
        attempts: me?.attempts,
        deadlineAt: context.privateState.deadlineAt,
        imageHintLevel: context.privateState.imageHintLevel,
      },
      panel: {
        settings: context.snapshot.settings,
        roundNumber: context.snapshot.roundNumber,
        syncRound: context.snapshot.syncRound,
        setterPlayerId: context.snapshot.setterPlayerId,
        phaseDeadlineAt: context.snapshot.phaseDeadlineAt,
        hints: context.privateState.hints,
        answer: context.privateState.answer,
        imageHint: context.state.ceeImage,
        imageHintAvailable: context.privateState.imageHintAvailable === true,
        imageHintLevel: context.privateState.imageHintLevel,
        guesses: recordList(context.privateState.guesses),
        selectedAnswer: context.state.ceeAnswer,
        search: searchPanel(context),
        roundSummary: context.snapshot.roundSummary,
        spectateRequests: context.snapshot.spectateRequests,
      },
      sections,
    },
    ceePlayers(context.snapshot)
  );
}

const send = (context: UiContext, type: string, payload: Record<string, unknown> = {}) =>
  context.client.sendInRoom("cee", type, payload, { timeoutMs: 120_000 });

const defaultModeFor = (context: UiContext, prefix: string): "character" | "subject" => {
  const search = context.state.search;
  return search?.prefix === prefix && search.kind === "subject" ? "subject" : "character";
};

const runSearch = async (
  context: UiContext,
  prefix: string,
  purpose: UiSearchState["purpose"]
): Promise<UiSearchState> => {
  const keyword = (context.state.drafts[`${prefix}.input`] ?? "").trim();
  const kind = defaultModeFor(context, prefix);
  const search: UiSearchState = {
    prefix,
    purpose,
    kind,
    keyword,
    status: "loading",
    results: [],
  };
  context.state.search = search;
  context.state.ceeCast = undefined;
  if (!keyword) {
    search.status = "ready";
    return search;
  }
  try {
    const ack = await send(
      context,
      kind === "subject" ? "cee.subject.search" : "cee.character.search",
      {
        keyword,
      }
    );
    search.results = isRecord(ack) ? recordList(ack.results) : [];
    search.status = "ready";
  } catch (error) {
    search.status = "error";
    search.error = error instanceof Error ? error.message : String(error);
    throw error;
  }
  return search;
};

export async function autoSearchCee(context: UiContext, controlId: string): Promise<void> {
  const prefix = controlId.endsWith(".input") ? controlId.slice(0, -".input".length) : "";
  if (prefix !== "cee.answer.search" && prefix !== "cee.guess.search") return;
  const purpose = prefix === "cee.answer.search" ? "cee_answer" : "cee_guess";
  await new Promise((resolve) => setTimeout(resolve, 420));
  const search = await runSearch(context, prefix, purpose);
  context.state.lastFeedback =
    search.error ?? (search.keyword ? `找到 ${search.results.length} 条结果` : undefined);
}

const needSearch = (context: UiContext, prefix: string): UiSearchState => {
  const search = context.state.search;
  if (!search || search.prefix !== prefix)
    throw new Error("搜索结果已变化，请重新输入并等待检索完成");
  return search;
};

const resultAt = (search: UiSearchState, index: string): Record<string, unknown> => {
  const value = Number.parseInt(index, 10);
  const result = Number.isInteger(value) ? search.results[value] : undefined;
  if (!result) throw new Error(`结果 ${index} 不存在`);
  return result;
};

const openCast = async (
  context: UiContext,
  search: UiSearchState,
  subject: Record<string, unknown>
) => {
  const subjectId = Number(subject.id);
  if (!Number.isInteger(subjectId)) throw new Error("作品编号无效");
  const ack = await send(context, "cee.subject.characters", { subjectId });
  search.subject = subject;
  search.results = isRecord(ack) ? recordList(ack.results) : [];
  search.status = "ready";
  context.state.ceeCast = { subject, characters: search.results };
  return `已打开《${str(subject.nameCn) || str(subject.name) || subjectId}》，共 ${search.results.length} 位角色`;
};

const clickGuessResult = async (
  context: UiContext,
  search: UiSearchState,
  index: string
): Promise<string> => {
  const result = resultAt(search, index);
  if (search.kind === "subject" && !search.subject) {
    return openCast(context, search, result);
  }
  const characterId = Number(result.id);
  if (!Number.isInteger(characterId)) throw new Error("角色编号无效");
  await send(context, "cee.game.guess", { characterId });
  context.state.search = undefined;
  context.state.ceeCast = undefined;
  delete context.state.drafts["cee.guess.search.input"];
  return `已猜「${str(result.nameCn) || str(result.name) || characterId}」`;
};

const clickAnswerResult = async (
  context: UiContext,
  search: UiSearchState,
  index: string
): Promise<string> => {
  const result = resultAt(search, index);
  if (search.kind === "subject" && !search.subject) {
    return openCast(context, search, result);
  }
  context.state.ceeAnswer = result;
  return `已选择答案「${str(result.nameCn) || str(result.name) || String(result.id)}」`;
};

const clickSearchResult = async (
  context: UiContext,
  prefix: string,
  index: string
): Promise<string> => {
  const search = needSearch(context, prefix);
  if (search.status !== "ready") throw new Error("搜索还没有完成");
  if (search.purpose === "cee_guess") return clickGuessResult(context, search, index);
  return clickAnswerResult(context, search, index);
};

const clickMode = async (
  context: UiContext,
  prefix: string,
  kind: "character" | "subject"
): Promise<string> => {
  const purpose = prefix === "cee.answer.search" ? "cee_answer" : "cee_guess";
  const search = context.state.search;
  if (search?.prefix === prefix) search.kind = kind;
  else {
    context.state.search = {
      prefix,
      purpose,
      kind,
      keyword: (context.state.drafts[`${prefix}.input`] ?? "").trim(),
      status: "idle",
      results: [],
    };
  }
  await runSearch(context, prefix, purpose);
  return kind === "subject" ? "已切换到搜作品" : "已切换到搜角色";
};

const clickCeeBasic = async (context: UiContext, id: string): Promise<string | undefined> => {
  switch (id) {
    case "cee.ready": {
      const me = meOf(context);
      await send(context, "cee.player.ready", { ready: me?.ready !== true });
      return me?.ready === true ? "已取消准备" : "已准备";
    }
    case "cee.start":
      await send(context, "cee.game.start");
      return "已开始游戏";
    case "cee.next":
      await send(context, "cee.game.next");
      return "已推进到下一阶段";
    case "cee.cancel":
      await send(context, "cee.game.cancel");
      return "已取消本局";
    case "cee.guess.surrender":
      await send(context, "cee.game.surrender");
      return "已放弃本局";
    default:
      return undefined;
  }
};

const clickCeeAnswer = async (context: UiContext, id: string): Promise<string> => {
  if (id === "cee.answer.selected.clear") {
    context.state.ceeAnswer = undefined;
    return "已清除已选答案";
  }
  const answer = context.state.ceeAnswer;
  if (!answer) throw new Error("还没有选择答案");
  const characterId = Number(answer.id);
  if (!Number.isInteger(characterId)) throw new Error("角色编号无效");
  const hints = [0, 1, 2]
    .map((index) => (context.state.drafts[`cee.answer.hint.${index}`] ?? "").trim())
    .filter(Boolean);
  await send(context, "cee.game.setAnswer", { characterId, hints });
  context.state.ceeAnswer = undefined;
  context.state.ceeHints = ["", "", ""];
  for (let index = 0; index < 3; index += 1)
    delete context.state.drafts[`cee.answer.hint.${index}`];
  context.state.search = undefined;
  return "答案已提交，本局开始";
};

const clickCeeSearch = async (context: UiContext, id: string): Promise<string | undefined> => {
  for (const prefix of ["cee.answer.search", "cee.guess.search"]) {
    if (id === `${prefix}.refresh`) {
      await runSearch(context, prefix, prefix === "cee.answer.search" ? "cee_answer" : "cee_guess");
      return "已重新搜索";
    }
    if (id === `${prefix}.back`) {
      const search = needSearch(context, prefix);
      search.subject = undefined;
      context.state.ceeCast = undefined;
      const ack = await send(context, "cee.subject.search", { keyword: search.keyword });
      search.results = isRecord(ack) ? recordList(ack.results) : [];
      search.status = "ready";
      return "已返回作品结果";
    }
    if (id === `${prefix}.mode.character` || id === `${prefix}.mode.subject`) {
      return clickMode(context, prefix, id.endsWith(".subject") ? "subject" : "character");
    }
    if (id.startsWith(`${prefix}.result.`)) {
      return clickSearchResult(context, prefix, id.slice(`${prefix}.result.`.length));
    }
  }
  return undefined;
};

const clickCeeSpectate = async (context: UiContext, id: string): Promise<string | undefined> => {
  const approve = id.startsWith("cee.spectate.approve.");
  const reject = id.startsWith("cee.spectate.reject.");
  if (!approve && !reject) return undefined;
  const playerId = id.slice((approve ? "cee.spectate.approve." : "cee.spectate.reject.").length);
  await send(context, "cee.player.approveSpectate", { playerId, approved: approve });
  return approve ? "已批准旁观" : "已拒绝旁观";
};

const clickCeeImage = async (context: UiContext): Promise<string> => {
  const ack = await send(context, "cee.game.imageHint");
  const dataUrl = isRecord(ack) ? str(ack.dataUrl) : undefined;
  if (dataUrl)
    context.state.ceeImage = {
      level:
        typeof context.privateState.imageHintLevel === "number"
          ? context.privateState.imageHintLevel
          : 0,
      dataUrl,
    };
  return "已获取图片提示";
};

export async function clickCeeControl(
  context: UiContext,
  controlValue: UiControl
): Promise<string> {
  const id = controlValue.id;
  if (id.startsWith("cee.setter.")) {
    const playerId = id.slice("cee.setter.".length);
    await send(context, "cee.game.chooseSetter", { playerId });
    return `已指定 ${playerName(context.snapshot, playerId)} 出题`;
  }
  if (id === "cee.answer.selected.clear" || id === "cee.answer.confirm")
    return clickCeeAnswer(context, id);
  if (id === "cee.answer.selected") return "这是当前已选答案，确认后才会提交";
  if (id === "cee.hint.image") return clickCeeImage(context);
  const spectate = await clickCeeSpectate(context, id);
  if (spectate) return spectate;
  const basic = await clickCeeBasic(context, id);
  if (basic) return basic;
  const search = await clickCeeSearch(context, id);
  if (search) return search;
  throw new Error(`控件「${controlValue.label}」当前不可操作`);
}

export async function setCeeControl(
  context: UiContext,
  controlValue: UiControl,
  value: unknown
): Promise<string> {
  if (controlValue.id === "cee.team") {
    if (value !== "none" && !/^[1-8]$/.test(String(value)))
      throw new Error("队伍必须是 1–8 或不组队");
    await send(context, "cee.player.team", {
      team: value === "none" ? null : Number(value),
    });
    return value === "none" ? "已退出队伍" : `已加入 ${String(value)} 队`;
  }
  throw new Error(`控件「${controlValue.label}」不是可设置取值的控件`);
}

export async function pressCee(
  context: UiContext,
  controlValue: UiControl,
  key: string
): Promise<string | undefined> {
  if (key !== "Enter") return undefined;
  if (controlValue.id.endsWith(".search.input")) {
    const prefix = controlValue.id.slice(0, -".input".length);
    const purpose = prefix === "cee.answer.search" ? "cee_answer" : "cee_guess";
    await runSearch(context, prefix, purpose);
    return "已立即搜索";
  }
  if (controlValue.id === "chat.input") {
    const value = (context.state.drafts["chat.input"] ?? "").trim();
    if (!value) throw new Error("聊天内容不能为空");
    await context.client.sendInRoom("cee", "cee.chat.send", { text: value });
    delete context.state.drafts["chat.input"];
    return "聊天消息已发送";
  }
  return undefined;
}
