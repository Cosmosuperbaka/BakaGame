import type { AgentFocusKind } from "../../shared/AgentActivity";
import type { AgentGameClient, GameId } from "../GameClient";
import {
  autoSearchCee,
  buildCeeScreen,
  clickCeeControl,
  pressCee,
  setCeeControl,
} from "./Cee";
import {
  autoSearchFaker,
  buildFakerScreen,
  clickFakerControl,
  pressFaker,
  sendChat,
  setFakerControl,
} from "./Faker";
import {
  autoSearchSong,
  buildSongScreen,
  clickSongControl,
  ensureSongAudioReady,
  pressSong,
  setSongControl,
} from "./Song";
import {
  createUiState,
  isRecord,
  str,
  syncPhase,
  type UiContext,
  type UiState,
} from "./Support";
import type {
  UiControl,
  UiRunResult,
  UiScreen,
  UiStep,
  UiStepAction,
  UiStepReport,
} from "./Types";

const MAX_STEPS = 16;
const MAX_TYPE_LENGTH = 200;

/** 出题/开局/换轮会跨多次上游请求，等待页面刷新时不能按普通命令的短超时判失败。 */
const LONG_ACTIONS = new Set([
  "song.start",
  "song.clip.confirm",
  "song.nextRound",
  "song.finish",
  "song.audio.retry",
  "cee.start",
  "cee.next",
  "cee.answer.confirm",
  "cee.hint.image",
  "faker.start",
  "faker.advance",
  "faker.words.submit",
]);

const KIND_BY_CONTROL: Array<[RegExp, AgentFocusKind]> = [
  [/^chat\./, "chat"],
  [/faker\.description/, "describe"],
  [/faker\.word/, "submit_words"],
  [/faker\.vote/, "vote"],
  [/faker\.night/, "action"],
  [/faker\.blank/, "action"],
  [/^song\.submit.*result|^song\.clip/, "submit_song"],
  [/^song\.(submit|guess)\.search/, "song_search"],
  [/^song\.guess/, "guess"],
  [/song\.audio/, "song_audio"],
  [/^cee\.answer/, "set_answer"],
  [/^cee\.guess/, "guess"],
  [/cee\.hint/, "image_hint"],
  [/search/, "action"],
];

const focusKind = (controlId: string): AgentFocusKind => {
  for (const [pattern, kind] of KIND_BY_CONTROL) if (pattern.test(controlId)) return kind;
  return "action";
};

const CHAT_COMMAND: Record<GameId, string> = {
  faker: "chat.send",
  song: "song.chat.send",
  cee: "cee.chat.send",
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const humanDelay = (minimum: number, maximum: number): number =>
  Math.round(minimum + Math.random() * Math.max(0, maximum - minimum));

interface SeatUiOptions {
  pacing?: boolean;
}

interface StepOutcome {
  feedback: string;
  /** 是否改动了服务端状态，执行后要等页面刷新。 */
  mutate: boolean;
}

export class SeatUi {
  private readonly states = new Map<GameId, UiState>();
  private readonly pacing: boolean;

  constructor(
    private readonly client: AgentGameClient,
    options: SeatUiOptions = {}
  ) {
    this.pacing = options.pacing !== false;
  }

  state(game: GameId): UiState {
    let state = this.states.get(game);
    if (!state) {
      state = createUiState();
      this.states.set(game, state);
    }
    return state;
  }

  private context(game: GameId): UiContext {
    const snapshot = this.client.currentSnapshot(game);
    if (!snapshot) throw new Error("尚未收到房间画面；先进入房间，或调用 requestSync 后重试");
    const privateState = this.client.currentPrivateState(game) ?? {};
    const state = this.state(game);
    const roomId = str(snapshot.roomId);
    if (state.roomId !== roomId) {
      const fresh = createUiState();
      fresh.roomId = roomId;
      this.states.set(game, fresh);
    }
    const current = this.state(game);
    syncPhase(current, str(snapshot.phase) ?? str((snapshot.status as Record<string, unknown>)?.phase) ?? "waiting");
    return {
      game,
      client: this.client,
      playerId: str(privateState.playerId) ?? this.client.currentPlayerId(game),
      snapshot,
      privateState,
      state: current,
      now: Date.now(),
    };
  }

  private build(game: GameId): { context: UiContext; screen: UiScreen } {
    const context = this.context(game);
    const screen =
      game === "faker"
        ? buildFakerScreen(context)
        : game === "song"
          ? buildSongScreen(context)
          : buildCeeScreen(context);
    return { context, screen };
  }

  /** 读取屏幕；`announce` 时把“正在查看”焦点推给接管座位的人类页面。 */
  async screen(game: GameId, options: { announce?: boolean } = {}): Promise<UiScreen> {
    const { context, screen } = this.build(game);
    if (game === "song") {
      try {
        await ensureSongAudioReady(context);
      } catch {
        /* 音频就绪是增强信号，不影响读屏 */
      }
    }
    if (options.announce) {
      await this.publish(game, context.state, {
        action: "focus",
        kind: "state",
        part: "game",
        label: `查看${screen.title}`,
      });
    }
    return screen;
  }

  private async publish(
    game: GameId,
    state: UiState,
    input: {
      action: string;
      kind: AgentFocusKind;
      controlId?: string;
      part?: UiControl["part"];
      label?: string;
      typed?: string;
    }
  ): Promise<void> {
    if (this.client.currentRoom(game) === undefined) return;
    await this.client.publishAgentFocus(
      {
        agentName: this.client.name.slice(0, 32),
        tool: "ui_run",
        action: input.action,
        kind: input.kind,
        ...(input.controlId ? { controlId: input.controlId } : {}),
        ...(input.part ? { part: input.part } : {}),
        ...(input.label ? { label: input.label.slice(0, 48) } : {}),
        ...(input.typed !== undefined ? { input: input.typed.slice(0, MAX_TYPE_LENGTH) } : {}),
      },
      game
    );
  }

  private findControl(screen: UiScreen, id: string): UiControl {
    const found = screen.controls.find((entry) => entry.id === id);
    if (!found) throw new Error(`控件 ${id} 在当前页面不可见；先调用 get_screen 查看可用控件`);
    return found;
  }

  private pause(ms: number): Promise<void> {
    return this.pacing ? sleep(ms) : Promise.resolve();
  }

  private async settle(
    context: UiContext,
    before: number,
    mutate: boolean,
    timeoutMs = 1_800
  ): Promise<void> {
    await this.pause(humanDelay(120, 220));
    if (!mutate) return;
    await this.client.waitForStateChange(context.game, before, timeoutMs);
    await this.pause(humanDelay(160, 300));
  }

  private async autoSearch(game: GameId, context: UiContext, controlId: string): Promise<void> {
    try {
      if (game === "song") await autoSearchSong(context, controlId);
      else if (game === "cee") await autoSearchCee(context, controlId);
      else await autoSearchFaker();
    } catch (error) {
      context.state.lastFeedback = error instanceof Error ? error.message : String(error);
    }
  }

  private async genericChat(
    game: GameId,
    context: UiContext,
    control: UiControl
  ): Promise<string | undefined> {
    if (control.id === "chat.send")
      return sendChat(context, CHAT_COMMAND[game]);
    return undefined;
  }

  private async executeClick(
    game: GameId,
    context: UiContext,
    control: UiControl
  ): Promise<StepOutcome> {
    const generic = await this.genericChat(game, context, control);
    if (generic) return { feedback: generic, mutate: true };
    if (game === "faker") {
      const feedback = await clickFakerControl(context, control);
      return { feedback, mutate: mutatesFaker(control.id) };
    }
    if (game === "song") {
      const mutate = mutatesSong(control.id, context.state);
      const feedback = await clickSongControl(context, control);
      return { feedback, mutate };
    }
    const mutate = mutatesCee(control.id, context.state);
    const feedback = await clickCeeControl(context, control);
    return { feedback, mutate };
  }

  private async executeSet(
    game: GameId,
    context: UiContext,
    control: UiControl,
    value: unknown
  ): Promise<StepOutcome> {
    if (game === "song") {
      const feedback = await setSongControl(context, control, value);
      return { feedback, mutate: control.id === "song.team" };
    }
    if (game === "cee") {
      const feedback = await setCeeControl(context, control, value);
      return { feedback, mutate: control.id === "cee.team" };
    }
    const feedback = await setFakerControl(context, control);
    return { feedback, mutate: false };
  }

  private async executePress(
    game: GameId,
    context: UiContext,
    control: UiControl,
    key: string
  ): Promise<StepOutcome> {
    if (control.id === "chat.input" && key === "Enter") {
      const feedback = await sendChat(context, CHAT_COMMAND[game]);
      return { feedback, mutate: true };
    }
    const feedback =
      game === "faker"
        ? await pressFaker(context, control, key)
        : game === "song"
          ? await pressSong(context, control, key)
          : await pressCee(context, control, key);
    if (!feedback) throw new Error(`控件「${control.label}」没有绑定按键 ${key} 的动作`);
    return { feedback, mutate: control.id === "faker.description.input" };
  }

  private async executeType(
    game: GameId,
    context: UiContext,
    control: UiControl,
    step: UiStep
  ): Promise<StepOutcome> {
    if (control.role !== "textbox") throw new Error(`控件「${control.label}」不是输入框，不能输入`);
    if (context.state.focus !== control.id)
      throw new Error(`请先用 focus 选中「${control.label}」再输入（当前焦点：${context.state.focus ?? "无"}）`);
    const incoming = step.text;
    if (typeof incoming !== "string") throw new Error("type 需要 text 参数");
    const current = context.state.drafts[control.id] ?? "";
    const next = step.replace === true ? incoming : current + incoming;
    if (next.length > (control.maxLength ?? MAX_TYPE_LENGTH))
      throw new Error(`输入超过「${control.label}」的长度上限 ${control.maxLength ?? MAX_TYPE_LENGTH}`);
    const start = step.replace === true ? "" : current;
    let typed = start;
    const chars = [...next.slice(start.length)];
    for (let index = 0; index < chars.length; index += 1) {
      typed += chars[index]!;
      context.state.drafts[control.id] = typed;
      await this.pause(humanDelay(28, 58));
      if (index % 2 === 0 || index === chars.length - 1)
        await this.publish(game, context.state, {
          action: "type",
          kind: focusKind(control.id),
          controlId: control.id,
          part: control.part,
          label: control.label,
          typed,
        });
    }
    await this.pause(humanDelay(360, 620));
    await this.autoSearch(game, context, control.id);
    const feedback = `已在「${control.label}」输入 ${chars.length} 个字符`;
    return { feedback, mutate: false };
  }

  private async executeFocus(
    game: GameId,
    context: UiContext,
    control: UiControl
  ): Promise<StepOutcome> {
    context.state.focus = control.id;
    await this.publish(game, context.state, {
      action: "focus",
      kind: focusKind(control.id),
      controlId: control.id,
      part: control.part,
      label: control.label,
      ...(control.role === "textbox" ? { typed: context.state.drafts[control.id] ?? "" } : {}),
    });
    await this.pause(humanDelay(120, 220));
    return { feedback: `已选中「${control.label}」`, mutate: false };
  }

  private resolveStepControl(
    context: UiContext,
    screen: UiScreen,
    step: UiStep,
    action: UiStepAction
  ): UiControl {
    const needsFocus = action === "type" || action === "press";
    const targetId = needsFocus
      ? typeof step.control === "string"
        ? step.control
        : context.state.focus
      : step.control;
    if (typeof targetId !== "string" || !targetId) {
      if (needsFocus) throw new Error(`先 focus 到一个控件，再执行 ${action}`);
      throw new Error(`${action} 需要 control 参数`);
    }
    const control = this.findControl(screen, targetId);
    if (control.disabled)
      throw new Error(`控件「${control.label}」当前是禁用的${control.hint ? `：${control.hint}` : ""}`);
    return control;
  }

  private async performStep(
    game: GameId,
    context: UiContext,
    control: UiControl,
    step: UiStep,
    action: UiStepAction
  ): Promise<StepOutcome> {
    if (action === "focus") return this.executeFocus(game, context, control);
    if (action === "type") return this.executeType(game, context, control, step);
    const focusControl = {
      action,
      kind: focusKind(control.id),
      controlId: control.id,
      part: control.part,
      label:
        action === "press"
          ? `${control.label} · ${typeof step.key === "string" ? step.key : "Enter"}`
          : control.label,
    };
    context.state.focus = control.id;
    await this.publish(game, context.state, focusControl);
    await this.pause(humanDelay(90, 180));
    if (action === "press")
      return this.executePress(
        game,
        context,
        control,
        typeof step.key === "string" ? step.key : "Enter"
      );
    if (action === "set") return this.executeSet(game, context, control, step.value);
    return this.executeClick(game, context, control);
  }

  private async step(game: GameId, step: UiStep, index: number): Promise<UiStepReport> {
    if (!isRecord(step) || typeof step.action !== "string")
      throw new Error("每个步骤都需要 action");
    const action = step.action as UiStepAction;
    if (!["focus", "type", "press", "click", "set"].includes(action))
      throw new Error(`不支持的步骤：${String(step.action)}`);
    const startedAt = Date.now();
    const { context, screen } = this.build(game);
    const control = this.resolveStepControl(context, screen, step, action);

    const before = this.client.stateVersion(game);
    const outcome = await this.performStep(game, context, control, step, action);
    context.state.lastFeedback = outcome.feedback;
    await this.settle(
      context,
      before,
      outcome.mutate,
      LONG_ACTIONS.has(control.id) ? 30_000 : 1_800
    );
    return {
      index,
      action,
      control: control.id,
      label: control.label,
      ok: true,
      durationMs: Date.now() - startedAt,
      feedback: outcome.feedback,
    };
  }

  async run(game: GameId, steps: readonly UiStep[]): Promise<UiRunResult> {
    if (!Array.isArray(steps) || steps.length === 0) throw new Error("steps 至少包含一个步骤");
    if (steps.length > MAX_STEPS) throw new Error(`一次最多串行 ${MAX_STEPS} 个步骤`);
    const reports: UiStepReport[] = [];
    let ok = true;
    for (let index = 0; index < steps.length; index += 1) {
      const startedAt = Date.now();
      try {
        reports.push(await this.step(game, steps[index]!, index));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const state = this.state(game);
        state.lastFeedback = message;
        reports.push({
          index,
          action: (isRecord(steps[index]) && typeof steps[index].action === "string"
            ? steps[index].action
            : "focus") as UiStepAction,
          ...(isRecord(steps[index]) && typeof steps[index].control === "string"
            ? { control: steps[index].control }
            : {}),
          ok: false,
          durationMs: Date.now() - startedAt,
          feedback: message,
        });
        ok = false;
        break;
      }
    }
    return { ok, steps: reports, screen: await this.screen(game) };
  }
}

const mutatesFaker = (id: string): boolean =>
  id === "faker.ready" ||
  id === "faker.start" ||
  id === "faker.advance" ||
  id.startsWith("faker.questioner.") ||
  id === "faker.words.submit" ||
  id === "faker.description.send" ||
  id === "faker.cancelVote" ||
  id === "faker.cancelNight" ||
  id.startsWith("faker.vote.") ||
  id.startsWith("faker.night.") ||
  id === "faker.blank.enter" ||
  id === "faker.blank.submit" ||
  id === "faker.blank.approve" ||
  id === "faker.blank.reject";

const mutatesSong = (id: string, state: UiState): boolean => {
  if (
    id === "song.ready" ||
    id === "song.start" ||
    id === "song.finish" ||
    id === "song.nextRound" ||
    id === "song.guess.giveup" ||
    id === "song.clip.confirm" ||
    id === "song.audio.retry" ||
    id.startsWith("song.submitter.")
  )
    return true;
  if (id === "song.guess.search.result" || id.startsWith("song.guess.search.result.")) return true;
  if (id.startsWith("song.submit.search.result."))
    return state.search?.kind === "anime" && Boolean(state.search.subject);
  if (id === "chat.send") return true;
  return false;
};

const mutatesCee = (id: string, state: UiState): boolean => {
  if (
    id === "cee.ready" ||
    id === "cee.start" ||
    id === "cee.next" ||
    id === "cee.answer.confirm" ||
    id === "cee.hint.image" ||
    id === "cee.cancel" ||
    id === "cee.guess.surrender" ||
    id.startsWith("cee.setter.") ||
    id.startsWith("cee.spectate.")
  )
    return true;
  if (id.startsWith("cee.guess.search.result."))
    return !(state.search?.kind === "subject" && !state.search.subject);
  if (id === "chat.send") return true;
  return false;
};
