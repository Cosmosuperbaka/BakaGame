import { ABSTAIN_TARGET_ID } from "../../shared/WhoIsFaker";
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
} from "./Support";
import type { UiControl, UiScreen } from "./Types";

const PHASE_TITLES: Record<string, string> = {
  waiting: "等待玩家加入",
  assigningQuestioner: "指定主持人",
  wordSubmission: "提交词语",
  description: "描述阶段",
  voting: "投票阶段",
  tieBreak: "平票 PK",
  night: "夜晚降临",
  blankGuess: "白板猜词",
  feedback: "阶段结果",
  gameOver: "游戏结束",
};

const fakerPlayers = (snapshot: Record<string, unknown>) =>
  recordList(snapshot.players).map((player) => ({
    id: player.id,
    name: player.name,
    score: player.score,
    membership: player.membership,
    online: player.online,
    isReady: player.isReady,
    isBot: player.isBot,
    isAgent: player.isAgent,
    mcpControlled: player.mcpControlled,
    isHost: player.isHost,
    roundStatus: player.roundStatus,
    ...(str(player.revealedRole) ? { revealedRole: player.revealedRole } : {}),
    ...(typeof player.eliminatedAt === "number" ? { eliminatedAt: player.eliminatedAt } : {}),
    ...(isRecord(player.account) && typeof player.account.image === "string"
      ? { avatar: player.account.image }
      : {}),
  }));

const selfPlayer = (context: UiContext) =>
  recordList(context.snapshot.players).find(
    (player) => player.id === (context.playerId ?? context.privateState.playerId)
  );

/** 描述输入框与服务端同一口径：CJK/全角字符算 2 单位，上限 20。 */
const charUnits = (char: string): number => {
  const code = char.codePointAt(0) ?? 0;
  return (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff01 && code <= 0xff60) ||
    (code >= 0x1b000 && code <= 0x1b0ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
    ? 2
    : 1;
};

export const clampSpeech = (value: string): string => {
  let units = 0;
  let result = "";
  for (const char of value) {
    const width = charUnits(char);
    if (units + width > 20) break;
    units += width;
    result += char;
  }
  return result;
};

const statusOf = (context: UiContext): Record<string, unknown> =>
  isRecord(context.snapshot.status) ? context.snapshot.status : {};

const phaseOf = (context: UiContext): string => str(statusOf(context).phase) ?? "waiting";

const meOf = (context: UiContext) => selfPlayer(context);

const isAlive = (context: UiContext): boolean => meOf(context)?.roundStatus === "alive";

const isQuestioner = (context: UiContext): boolean =>
  context.privateState.isQuestioner === true;

const canVote = (context: UiContext): boolean => {
  const status = statusOf(context);
  const me = meOf(context);
  const voted = context.privateState.myCurrentVoteTargetId;
  if (!me || me.roundStatus !== "alive" || isQuestioner(context) || voted) return false;
  if (status.phase !== "tieBreak") return true;
  const candidates = list(status.tieBreakCandidateIds);
  return !candidates.includes(me.id);
};

const voteTargets = (context: UiContext) => {
  const status = statusOf(context);
  const me = meOf(context);
  const alive = recordList(context.snapshot.players).filter(
    (player) => player.roundStatus === "alive" && player.id !== me?.id
  );
  if (status.phase !== "tieBreak") return alive;
  const candidates = list(status.tieBreakCandidateIds);
  return candidates.length
    ? alive.filter((player) => candidates.includes(player.id) && player.id !== me?.id)
    : alive;
};

const canSpeak = (context: UiContext): boolean => {
  const status = statusOf(context);
  const me = meOf(context);
  if (!me || me.roundStatus !== "alive" || isQuestioner(context)) return false;
  const submitted = new Set(
    list(status.submittedSpeechPlayerIds).filter((id): id is string => typeof id === "string")
  );
  if (submitted.has(String(me.id))) return false;
  const order = list(status.speechOrder).filter((id): id is string => typeof id === "string");
  const mode = str(status.speechMode) ?? "normal";
  return mode === "normal" || order.includes(String(me.id));
};

const wordsPanel = (context: UiContext) => {
  const privateState = context.privateState;
  return {
    ...(str(privateState.role) ? { role: privateState.role } : {}),
    ...(str(privateState.side) ? { side: privateState.side } : {}),
    ...(str(privateState.word) ? { word: privateState.word } : {}),
    ...(Array.isArray(privateState.angelWordOptions)
      ? { angelWordOptions: privateState.angelWordOptions }
      : {}),
    ...(str(privateState.blankHint) ? { blankHint: privateState.blankHint } : {}),
    ...(isRecord(privateState.globalWords) ? { globalWords: privateState.globalWords } : {}),
    ...(Array.isArray(privateState.questionerView)
      ? { questionerView: privateState.questionerView }
      : {}),
    ...(isRecord(privateState.privilegedActionPreview)
      ? { privilegedActionPreview: privateState.privilegedActionPreview }
      : {}),
  };
};

const descriptionsPanel = (context: UiContext) => recordList(context.snapshot.descriptions);

const waitingControls = (context: UiContext): UiControl[] => {
  const me = meOf(context);
  const status = statusOf(context);
  const active = recordList(context.snapshot.players).filter(
    (player) => player.membership === "active"
  );
  const nonHost = active.filter((player) => !player.isHost);
  const allReady =
    (context.snapshot.testMode === true && nonHost.length === 0) ||
    (nonHost.length > 0 && nonHost.every((player) => player.isReady === true));
  const controls: UiControl[] = [];
  if (me?.isHost === true) {
    controls.push(
      button("faker.start", "开始游戏", "game", {
        disabled: !allReady || status.started === true,
        hint: allReady ? undefined : "等待其他玩家准备",
      })
    );
  } else if (me?.membership === "active") {
    controls.push(button("faker.ready", me.isReady === true ? "取消准备" : "准备"));
  }
  return controls;
};

const assignControls = (context: UiContext): UiControl[] => {
  if (!isQuestioner(context) && meOf(context)?.isHost !== true) return [];
  return recordList(context.snapshot.players)
    .filter((player) => player.membership === "active" || player.membership === "spectator")
    .map((player) =>
      button(`faker.questioner.${String(player.id)}`, String(player.name), "game", {
        hint: player.membership === "spectator" ? "推荐：旁观者主持，全员参战" : undefined,
        data: { playerId: player.id, membership: player.membership },
      })
    );
};

const wordControls = (context: UiContext): UiControl[] => {
  if (!isQuestioner(context)) return [];
  const drafts = context.state.drafts;
  const hasBlank = isRecord(context.snapshot.settings)
    ? isRecord(context.snapshot.settings.roleConfig) &&
      context.snapshot.settings.roleConfig.hasBlank === true
    : false;
  const controls = [
    textbox("faker.word.civilian", "平民词", drafts["faker.word.civilian"] ?? "", "game", {
      maxLength: 50,
    }),
    textbox("faker.word.undercover", "卧底词", drafts["faker.word.undercover"] ?? "", "game", {
      maxLength: 50,
    }),
  ];
  if (hasBlank) {
    controls.push(
      textbox("faker.word.blankHint", "白板提示", drafts["faker.word.blankHint"] ?? "", "game", {
        maxLength: 50,
      })
    );
  }
  controls.push(
    button("faker.words.submit", "确认提交", "game", {
      disabled:
        !(drafts["faker.word.civilian"] ?? "").trim() ||
        !(drafts["faker.word.undercover"] ?? "").trim() ||
        (hasBlank && !(drafts["faker.word.blankHint"] ?? "").trim()),
    })
  );
  return controls;
};

const advanceControl = (context: UiContext, label: string): UiControl[] =>
  isQuestioner(context) || (context.snapshot.testMode === true && phaseOf(context) === "feedback")
    ? [button("faker.advance", label)]
    : [];

const descriptionControls = (context: UiContext): UiControl[] => {
  const controls: UiControl[] = [];
  if (canSpeak(context)) {
    controls.push(
      textbox(
        "faker.description.input",
        "描述内容",
        context.state.drafts["faker.description.input"] ?? "",
        "game",
        { maxLength: 20, hint: "上限 10 个汉字或 20 个英文字符；按 Enter 或点发送" }
      ),
      button("faker.description.send", "发送", "game", {
        disabled: !(context.state.drafts["faker.description.input"] ?? "").trim(),
      })
    );
  }
  const mode = str(statusOf(context).speechMode) ?? "normal";
  controls.push(
    ...advanceControl(
      context,
      mode === "normal" ? "进入投票阶段" : mode === "tieBreak" ? "进入 PK 投票" : "继续"
    )
  );
  return controls;
};

const voteControls = (context: UiContext): UiControl[] => {
  const controls: UiControl[] = [];
  if (canVote(context)) {
    for (const target of voteTargets(context)) {
      controls.push(
        button(`faker.vote.${String(target.id)}`, `投给 ${String(target.name)}`, "game", {
          data: { playerId: target.id },
        })
      );
    }
    controls.push(button("faker.vote.abstain", "弃票", "game"));
  } else if (context.privateState.myCurrentVoteTargetId) {
    const target = context.privateState.myCurrentVoteTargetId;
    controls.push(
      button("faker.cancelVote", "撤销投票", "game", {
        hint:
          target === ABSTAIN_TARGET_ID
            ? "当前已弃票"
            : `当前投给 ${playerName(context.snapshot, target)}`,
      })
    );
  }
  controls.push(...advanceControl(context, "结算投票"));
  return controls;
};

const nightControls = (context: UiContext): UiControl[] => {
  const controls: UiControl[] = [];
  const role = str(context.privateState.role);
  const acted = context.privateState.nightActionSubmitted === true;
  const canAct =
    isAlive(context) &&
    !isQuestioner(context) &&
    (role === "civilian" || role === "undercover");
  if (canAct && !acted) {
    for (const target of recordList(context.snapshot.players)) {
      if (
        target.roundStatus !== "alive" ||
        target.id === (context.playerId ?? context.privateState.playerId)
      )
        continue;
      controls.push(
        button(`faker.night.${String(target.id)}`, `对 ${String(target.name)} 出手`, "game", {
          data: { playerId: target.id },
        })
      );
    }
    controls.push(button("faker.night.skip", "不行动", "game"));
  } else if (canAct && acted) {
    controls.push(button("faker.cancelNight", "撤销夜晚行动", "game"));
  }
  if (isQuestioner(context)) controls.push(button("faker.advance", "天亮了"));
  return controls;
};

const blankGuessControls = (context: UiContext): UiControl[] => {
  const controls: UiControl[] = [];
  const status = statusOf(context);
  const pendingReview = status.blankGuessPendingReview === true;
  const myId = context.playerId ?? context.privateState.playerId;
  const guesserId = status.blankGuessPlayerId;
  const isGuesser = myId !== undefined && myId === guesserId;
  if (isGuesser) {
    if (pendingReview) return controls;
    controls.push(
      textbox("faker.blank.a", "词语 A", context.state.drafts["faker.blank.a"] ?? "", "game", {
        maxLength: 20,
      }),
      textbox("faker.blank.b", "词语 B", context.state.drafts["faker.blank.b"] ?? "", "game", {
        maxLength: 20,
      }),
      button("faker.blank.submit", "提交猜测", "game", {
        disabled:
          !(context.state.drafts["faker.blank.a"] ?? "").trim() ||
          !(context.state.drafts["faker.blank.b"] ?? "").trim(),
      })
    );
    return controls;
  }
  if (pendingReview && (isQuestioner(context) || context.privateState.globalWords)) {
    controls.push(
      button("faker.blank.approve", "算作正确"),
      button("faker.blank.reject", "判定错误")
    );
  }
  return controls;
};

const phaseControls = (context: UiContext): UiControl[] => {
  const phase = phaseOf(context);
  switch (phase) {
    case "waiting":
      return waitingControls(context);
    case "assigningQuestioner":
      return assignControls(context);
    case "wordSubmission":
      return wordControls(context);
    case "description":
      return descriptionControls(context);
    case "voting":
      return voteControls(context);
    case "tieBreak":
      return statusOf(context).tieBreakStage === "description"
        ? descriptionControls(context)
        : voteControls(context);
    case "night":
      return nightControls(context);
    case "blankGuess":
      return blankGuessControls(context);
    case "feedback":
      return advanceControl(context, "继续");
    case "gameOver":
      return meOf(context)?.isHost === true
        ? [button("faker.advance", "返回等待房间")]
        : [];
    default:
      return [];
  }
};

const blankGuessEntry = (context: UiContext): UiControl[] => {
  const phase = phaseOf(context);
  if (
    context.privateState.canSubmitBlankGuess !== true ||
    context.privateState.blankGuessUsed === true ||
    phase === "blankGuess" ||
    phase === "feedback" ||
    phase === "gameOver"
  )
    return [];
  return [button("faker.blank.enter", "白板猜词", "game")];
};

export function buildFakerScreen(context: UiContext): UiScreen {
  const phase = phaseOf(context);
  const status = statusOf(context);
  const noticeParts = [
    phase === "waiting" && context.snapshot.testMode === true
      ? "测试房可以单人直接开始"
      : undefined,
    phase === "feedback" && isRecord(status.feedback)
      ? `结果已出，${isQuestioner(context) ? "由主持人继续" : "等待主持人继续"}`
      : undefined,
    phase === "gameOver" ? "本局已结束，房主可以返回等待房间" : undefined,
  ].filter((entry): entry is string => Boolean(entry));

  const sections = [
    section("faker.actions", "可操作控件", [
      ...phaseControls(context),
      ...blankGuessEntry(context),
    ]),
    section("faker.chat", "聊天", chatControls(context.state)),
  ];

  return assemble(
    context,
    {
      phase,
      title: PHASE_TITLES[phase] ?? "谁是卧底",
      notice: noticeParts.join("；") || undefined,
      you: {
        playerId: context.playerId ?? context.privateState.playerId,
        name: meOf(context)?.name,
        isHost: meOf(context)?.isHost === true,
        membership: meOf(context)?.membership,
        roundStatus: meOf(context)?.roundStatus,
        isQuestioner: isQuestioner(context),
        canSubmitBlankGuess: context.privateState.canSubmitBlankGuess === true,
        blankGuessUsed: context.privateState.blankGuessUsed === true,
        nightActionSubmitted: context.privateState.nightActionSubmitted === true,
        myCurrentVoteTargetId: context.privateState.myCurrentVoteTargetId,
        myCurrentNightTargetId: context.privateState.myCurrentNightTargetId,
        ...wordsPanel(context),
      },
      panel: {
        day: status.day,
        speechMode: status.speechMode,
        speechOrder: status.speechOrder,
        submittedSpeechPlayerIds: status.submittedSpeechPlayerIds,
        questionerPlayerId: status.questionerPlayerId,
        tieBreakCandidateIds: status.tieBreakCandidateIds,
        blankGuessPlayerId: status.blankGuessPlayerId,
        blankGuessDraft: status.blankGuessDraft,
        blankGuessPendingReview: status.blankGuessPendingReview === true,
        phaseTimer: status.phaseTimer,
        descriptions: descriptionsPanel(context),
        feedback: status.feedback,
        summary: context.snapshot.summary,
        settings: context.snapshot.settings,
      },
      sections,
    },
    fakerPlayers(context.snapshot)
  );
}

export async function autoSearchFaker(): Promise<void> {
  // 谁是卧底没有检索控件。
}

const needDraft = (context: UiContext, id: string, label: string): string => {
  const value = (context.state.drafts[id] ?? "").trim();
  if (!value) throw new Error(`「${label}」还没有输入内容`);
  return value;
};

const send = (context: UiContext, type: string, payload: Record<string, unknown> = {}) =>
  context.client.sendInRoom("faker", type, payload);

const submitFakerWords = async (context: UiContext): Promise<string> => {
  const hasBlank =
    isRecord(context.snapshot.settings) &&
    isRecord(context.snapshot.settings.roleConfig) &&
    context.snapshot.settings.roleConfig.hasBlank === true;
  const words = [
    needDraft(context, "faker.word.civilian", "平民词"),
    needDraft(context, "faker.word.undercover", "卧底词"),
  ];
  await send(context, "game.submitWords", {
    words,
    ...(hasBlank ? { blankHint: needDraft(context, "faker.word.blankHint", "白板提示") } : {}),
  });
  for (const key of ["faker.word.civilian", "faker.word.undercover", "faker.word.blankHint"])
    delete context.state.drafts[key];
  return "词语已提交";
};

const clickFakerBlank = async (context: UiContext, id: string): Promise<string | undefined> => {
  switch (id) {
    case "faker.blank.enter":
      await send(context, "game.enterBlankGuess");
      return "已发起白板猜词";
    case "faker.blank.submit":
      await send(context, "game.submitBlankGuess", {
        words: [
          needDraft(context, "faker.blank.a", "词语 A"),
          needDraft(context, "faker.blank.b", "词语 B"),
        ],
      });
      delete context.state.drafts["faker.blank.a"];
      delete context.state.drafts["faker.blank.b"];
      return "白板猜词已提交";
    case "faker.blank.approve":
    case "faker.blank.reject":
      await send(context, "game.reviewBlankGuess", { approve: id === "faker.blank.approve" });
      return id === "faker.blank.approve" ? "已裁定猜中" : "已裁定未猜中";
    default:
      return undefined;
  }
};

const clickFakerVoteNight = async (
  context: UiContext,
  id: string
): Promise<string | undefined> => {
  if (id.startsWith("faker.vote.")) {
    const target = id.slice("faker.vote.".length);
    await send(context, "game.submitVote", {
      targetId: target === "abstain" ? ABSTAIN_TARGET_ID : target,
    });
    return target === "abstain" ? "已弃票" : `已投给 ${playerName(context.snapshot, target)}`;
  }
  if (id === "faker.cancelVote") {
    await send(context, "game.cancelVote");
    return "已撤销投票";
  }
  if (id.startsWith("faker.night.")) {
    const target = id.slice("faker.night.".length);
    if (target === "skip") {
      await send(context, "game.submitNightAction", { targetId: null });
      return "本夜不行动";
    }
    await send(context, "game.submitNightAction", { targetId: target });
    return `已对 ${playerName(context.snapshot, target)} 出手`;
  }
  if (id === "faker.cancelNight") {
    await send(context, "game.cancelNightAction");
    return "已撤销夜晚行动";
  }
  return undefined;
};

const clickFakerBasic = async (context: UiContext, id: string): Promise<string | undefined> => {
  const me = meOf(context);
  if (id === "faker.ready") {
    await send(context, "player.setReady", { ready: me?.isReady !== true });
    return me?.isReady === true ? "已取消准备" : "已准备";
  }
  if (id === "faker.start" || id === "faker.advance") {
    await send(context, "game.advancePhase");
    return "已推进阶段";
  }
  if (id.startsWith("faker.questioner.")) {
    const playerId = id.slice("faker.questioner.".length);
    await send(context, "game.assignQuestioner", { playerId });
    return `已指定 ${playerName(context.snapshot, playerId)} 为主持人`;
  }
  if (id === "faker.words.submit") return submitFakerWords(context);
  if (id === "faker.description.send") {
    const value = clampSpeech(needDraft(context, "faker.description.input", "描述内容"));
    if (!value) throw new Error("描述内容不能为空");
    await send(context, "game.submitDescription", { text: value });
    delete context.state.drafts["faker.description.input"];
    return "描述已发送";
  }
  return undefined;
};

export async function clickFakerControl(
  context: UiContext,
  controlValue: UiControl
): Promise<string> {
  const id = controlValue.id;
  if (id.startsWith("faker.blank.")) {
    const blank = await clickFakerBlank(context, id);
    if (blank) return blank;
  }
  const vote = await clickFakerVoteNight(context, id);
  if (vote) return vote;
  const basic = await clickFakerBasic(context, id);
  if (basic) return basic;
  throw new Error(`控件「${controlValue.label}」当前不可操作`);
}

export async function pressFaker(
  context: UiContext,
  controlValue: UiControl,
  key: string
): Promise<string | undefined> {
  if (key !== "Enter") return undefined;
  if (controlValue.id === "faker.description.input") {
    await clickFakerControl(
      context,
      control("faker.description.send", "发送", "button", "game")
    );
    return "描述已发送";
  }
  return undefined;
}

export async function setFakerControl(
  _context: UiContext,
  controlValue: UiControl
): Promise<string> {
  throw new Error(`控件「${controlValue.label}」不是可设置取值的控件`);
}

/** 聊天模块共用的发送逻辑；三个游戏仅命令名不同，由各自模块调用。 */
export async function sendChat(
  context: UiContext,
  command: string,
  state = context.state
): Promise<string> {
  const value = (state.drafts["chat.input"] ?? "").trim();
  if (!value) throw new Error("聊天内容不能为空");
  await context.client.sendInRoom(context.game, command, { text: value });
  delete state.drafts["chat.input"];
  return "聊天消息已发送";
}
