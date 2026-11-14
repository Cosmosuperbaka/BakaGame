import type { AgentGameClient, GameId } from "../GameClient";
import { ceeUiAdapter } from "./Cee";
import { fakerUiAdapter } from "./Faker";
import type { GameUiAdapter } from "./GameUi";
import { songUiAdapter } from "./Song";
import {
  createUiState,
  isRecord,
  sendChat,
  str,
  syncPhase,
  type UiContext,
  type UiState,
} from "./Support";
import type { UiControl, UiRunResult, UiScreen, UiStep, UiStepAction, UiStepReport } from "./Types";

const MAX_STEPS = 16;
const MAX_TYPE_LENGTH = 200;

const ADAPTERS: Record<GameId, GameUiAdapter> = {
  faker: fakerUiAdapter,
  song: songUiAdapter,
  cee: ceeUiAdapter,
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
    syncPhase(
      current,
      str(snapshot.phase) ?? str((snapshot.status as Record<string, unknown>)?.phase) ?? "waiting"
    );
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
    return { context, screen: ADAPTERS[game].build(context) };
  }

  async screen(game: GameId): Promise<UiScreen> {
    const { context, screen } = this.build(game);
    try {
      await ADAPTERS[game].prepare?.(context);
    } catch {
      /* 增强步骤（如音频就绪）不影响读屏 */
    }
    return screen;
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
      await ADAPTERS[game].autoSearch(context, controlId);
    } catch (error) {
      context.state.lastFeedback = error instanceof Error ? error.message : String(error);
    }
  }

  private async executeClick(
    game: GameId,
    context: UiContext,
    control: UiControl
  ): Promise<StepOutcome> {
    const adapter = ADAPTERS[game];
    if (control.id === "chat.send")
      return { feedback: await sendChat(context, adapter.chatCommand), mutate: true };
    // 是否改动服务端状态要在点击前判定：点击本身会清掉搜索态，事后再看就判错了。
    const mutate = adapter.mutatesOnClick(control.id, context);
    const feedback = await adapter.click(context, control);
    return { feedback, mutate };
  }

  private async executeSet(
    game: GameId,
    context: UiContext,
    control: UiControl,
    value: unknown
  ): Promise<StepOutcome> {
    const adapter = ADAPTERS[game];
    const feedback = await adapter.set(context, control, value);
    return { feedback, mutate: adapter.mutatesOnSet.has(control.id) };
  }

  private async executePress(
    game: GameId,
    context: UiContext,
    control: UiControl,
    key: string
  ): Promise<StepOutcome> {
    const adapter = ADAPTERS[game];
    if (control.id === "chat.input" && key === "Enter") {
      const feedback = await sendChat(context, adapter.chatCommand);
      return { feedback, mutate: true };
    }
    const feedback = await adapter.press(context, control, key);
    if (!feedback) throw new Error(`控件「${control.label}」没有绑定按键 ${key} 的动作`);
    return { feedback, mutate: adapter.mutatesOnPress.has(control.id) };
  }

  private async executeType(
    game: GameId,
    context: UiContext,
    control: UiControl,
    step: UiStep
  ): Promise<StepOutcome> {
    if (control.role !== "textbox") throw new Error(`控件「${control.label}」不是输入框，不能输入`);
    if (context.state.focus !== control.id)
      throw new Error(
        `请先用 focus 选中「${control.label}」再输入（当前焦点：${context.state.focus ?? "无"}）`
      );
    const incoming = step.text;
    if (typeof incoming !== "string") throw new Error("type 需要 text 参数");
    const current = context.state.drafts[control.id] ?? "";
    const next = step.replace === true ? incoming : current + incoming;
    if (next.length > (control.maxLength ?? MAX_TYPE_LENGTH))
      throw new Error(
        `输入超过「${control.label}」的长度上限 ${control.maxLength ?? MAX_TYPE_LENGTH}`
      );
    const start = step.replace === true ? "" : current;
    let typed = start;
    const chars = [...next.slice(start.length)];
    for (let index = 0; index < chars.length; index += 1) {
      typed += chars[index]!;
      context.state.drafts[control.id] = typed;
      await this.pause(humanDelay(28, 58));
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
      throw new Error(
        `控件「${control.label}」当前是禁用的${control.hint ? `：${control.hint}` : ""}`
      );
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
    context.state.focus = control.id;
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
      ADAPTERS[game].longActions.has(control.id) ? 30_000 : 1_800
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
