import { useSyncExternalStore } from "react";

/** 可播放的音效。新增时在 `RECIPES` 里补一条合成配方即可，不引入音频文件。 */
export type SoundName = "roundStart" | "actionRequired" | "chatMessage";

/** 与音效开关共用；刷新后保持上一次选择。 */
export const SOUND_STORAGE_KEY = "bakagame:sound";
/** 提示音音量（0–1 的字符串）；默认满音量，保持既有提示音响度。 */
export const SOUND_VOLUME_STORAGE_KEY = "bakagame:sound-volume";

const DEFAULT_VOLUME = 1;

type Tone = {
  frequency: number;
  /** 相对整段音效起点的延迟（秒） */
  offset: number;
  duration: number;
  type: OscillatorType;
  gain: number;
  /** 起音时长，避免方波边缘产生爆音 */
  attack?: number;
  /** 起音结束后保持满增益的时长 */
  hold?: number;
};

type Recipe = {
  /** 整段音效的输出增益：不同用途的提示音需要不同响度 */
  master: number;
  tones: readonly Tone[];
};

/**
 * 短促、柔和的提示音：振荡器现场合成，没有音频资源，
 * 不受 `<audio>` 的 `crossOrigin` 与解码链影响（猜歌灰化链也不碰它）。
 *
 * 包络在起音后保留一小段满增益，再用线性收尾。旧版直接指数衰减到 0.0001，
 * 听感上几十毫秒就没了；标称时长不能当可闻时长用。
 */
const RECIPES: Record<SoundName, Recipe> = {
  roundStart: {
    master: 0.5,
    tones: [
      {
        frequency: 659.25,
        offset: 0,
        duration: 0.22,
        type: "triangle",
        gain: 0.5,
        attack: 0.012,
        hold: 0.06,
      },
      {
        frequency: 987.77,
        offset: 0.09,
        duration: 0.38,
        type: "sine",
        gain: 0.36,
        attack: 0.012,
        hold: 0.1,
      },
    ],
  },
  /** 轮到本人操作：A5–C#6–E6 上行三音，和开局的 E5–B5 两音区分开。 */
  actionRequired: {
    master: 0.7,
    tones: [
      {
        frequency: 880,
        offset: 0,
        duration: 0.14,
        type: "triangle",
        gain: 0.42,
        attack: 0.01,
        hold: 0.04,
      },
      {
        frequency: 1108.73,
        offset: 0.08,
        duration: 0.14,
        type: "triangle",
        gain: 0.42,
        attack: 0.01,
        hold: 0.04,
      },
      {
        frequency: 1318.51,
        offset: 0.16,
        duration: 0.26,
        type: "sine",
        gain: 0.4,
        attack: 0.01,
        hold: 0.08,
      },
    ],
  },
  /** 收到他人聊天：单声短促的 C6，不和行动提示抢注意力。 */
  chatMessage: {
    master: 0.55,
    tones: [
      {
        frequency: 1046.5,
        offset: 0,
        duration: 0.16,
        type: "sine",
        gain: 0.5,
        attack: 0.008,
        hold: 0.04,
      },
      {
        frequency: 523.25,
        offset: 0,
        duration: 0.1,
        type: "triangle",
        gain: 0.14,
        attack: 0.008,
        hold: 0.02,
      },
    ],
  },
};

const GESTURE_EVENTS = ["pointerdown", "keydown", "touchend"] as const;

const listeners = new Set<() => void>();
let enabled = true;
let volume = DEFAULT_VOLUME;
let context: AudioContext | null = null;
let gestureArmed = false;
let primed = false;
let activeTeardown: (() => void) | null = null;
let stateListener: (() => void) | null = null;

function readStoredEnabled(): boolean {
  try {
    return window.localStorage.getItem(SOUND_STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_VOLUME;
  return Math.min(1, Math.max(0, value));
}

function readStoredVolume(): number {
  try {
    const stored = window.localStorage.getItem(SOUND_VOLUME_STORAGE_KEY);
    if (stored === null) return DEFAULT_VOLUME;
    return clampVolume(Number(stored));
  } catch {
    return DEFAULT_VOLUME;
  }
}

function emit(): void {
  for (const listener of listeners) listener();
}

export function getSoundEnabled(): boolean {
  return enabled;
}

export function getSoundVolume(): number {
  return volume;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSoundEnabled(): boolean {
  return useSyncExternalStore(subscribe, getSoundEnabled, () => true);
}

export function useSoundVolume(): number {
  return useSyncExternalStore(subscribe, getSoundVolume, () => DEFAULT_VOLUME);
}

function onFirstInteraction(): void {
  unlock();
}

function armGestureUnlock(): void {
  if (gestureArmed || typeof window === "undefined") return;
  gestureArmed = true;
  for (const event of GESTURE_EVENTS) {
    window.addEventListener(event, onFirstInteraction, { passive: true });
  }
}

function detachGestureUnlock(): void {
  if (!gestureArmed) return;
  gestureArmed = false;
  for (const event of GESTURE_EVENTS) window.removeEventListener(event, onFirstInteraction);
}

/** 在用户手势里播一帧静音，兼容仍要求实际播放过才解锁的 Safari。 */
function primeContext(ctx: AudioContext): void {
  if (primed) return;
  primed = true;
  try {
    const source = ctx.createBufferSource();
    source.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    source.connect(ctx.destination);
    source.start(0);
  } catch {
    // 静音帧只是唤醒手段，失败不影响后续播放。
  }
}

function attachContextState(ctx: AudioContext): void {
  stateListener = () => {
    if (context !== ctx) return;
    if (ctx.state === "running") {
      detachGestureUnlock();
      return;
    }
    if (ctx.state === "closed") {
      context = null;
      primed = false;
    }
    if (enabled) armGestureUnlock();
  };
  ctx.addEventListener("statechange", stateListener);
}

function ensureContext(): AudioContext | null {
  if (context?.state === "closed") {
    context = null;
    primed = false;
  }
  if (context) return context;
  try {
    const Ctor = window.AudioContext;
    if (!Ctor) return null;
    const created = new Ctor();
    context = created;
    primed = false;
    attachContextState(created);
    primeContext(created);
    return created;
  } catch {
    context = null;
    return null;
  }
}

function resumeContext(): void {
  const ctx = context;
  if (!ctx || !enabled) return;
  if (ctx.state === "running") {
    detachGestureUnlock();
    return;
  }
  void ctx.resume().then(
    () => {
      if (context !== ctx) return;
      if (ctx.state === "running") detachGestureUnlock();
      else if (enabled) armGestureUnlock();
    },
    () => {
      if (context !== ctx) return;
      if (enabled) armGestureUnlock();
    }
  );
}

/**
 * 只在用户交互里创建 AudioContext。创建或 resume 失败时不拆手势监听：
 * 下一次点击还能重试，不会永久静音。
 */
function unlock(): void {
  if (!enabled) return;
  if (ensureContext()) resumeContext();
}

/** 播放一个音效。未解锁、已关闭、不支持或上下文不在运行态时静默返回。 */
export function playSound(name: SoundName): void {
  if (!enabled || volume === 0) return;
  const ctx = context;
  if (!ctx || ctx.state !== "running") {
    // 挂起时排程只会在恢复后补播一条过期提示音；交给下一次用户手势重新解锁。
    armGestureUnlock();
    return;
  }
  try {
    const recipe = RECIPES[name];
    const master = ctx.createGain();
    master.gain.setValueAtTime(recipe.master * volume, ctx.currentTime);
    master.connect(ctx.destination);
    for (const tone of recipe.tones) {
      const start = ctx.currentTime + tone.offset;
      const end = start + tone.duration;
      const attackEnd = start + Math.min(tone.attack ?? 0.012, tone.duration / 2);
      const holdEnd = Math.min(end, attackEnd + (tone.hold ?? 0.06));
      const oscillator = ctx.createOscillator();
      const envelope = ctx.createGain();
      oscillator.type = tone.type;
      oscillator.frequency.setValueAtTime(tone.frequency, start);
      envelope.gain.setValueAtTime(0.0001, start);
      envelope.gain.linearRampToValueAtTime(tone.gain, attackEnd);
      if (holdEnd > attackEnd) envelope.gain.setValueAtTime(tone.gain, holdEnd);
      envelope.gain.linearRampToValueAtTime(0.0001, end);
      oscillator.connect(envelope);
      envelope.connect(master);
      oscillator.start(start);
      oscillator.stop(end + 0.02);
    }
  } catch {
    // 上下文在播放途中被关闭等边缘情况：本次静默，不打断游戏流程。
  }
}

export function setSoundEnabled(next: boolean): void {
  enabled = next;
  try {
    window.localStorage.setItem(SOUND_STORAGE_KEY, next ? "1" : "0");
  } catch {
    // 隐私模式写不进去：本次会话仍然生效。
  }
  // 开关本身是用户交互，可在此时补建上下文。
  if (next) {
    armGestureUnlock();
    unlock();
  } else {
    detachGestureUnlock();
    if (context) void context.suspend().catch(() => {});
  }
  emit();
}

export function setSoundVolume(next: number): void {
  volume = clampVolume(next);
  try {
    window.localStorage.setItem(SOUND_VOLUME_STORAGE_KEY, String(volume));
  } catch {
    // 隐私模式写不进去：本次会话仍然生效。
  }
  emit();
}

/**
 * 挂上「首次交互」监听。必须早于 React 渲染调用，且这里不创建 AudioContext。
 * 返回停止函数；重复调用会先拆掉上一份监听。
 */
export function initSoundEffects(): () => void {
  if (typeof window === "undefined") return () => {};
  activeTeardown?.();
  enabled = readStoredEnabled();
  volume = readStoredVolume();
  if (enabled) armGestureUnlock();

  const onVisibilityChange = () => {
    if (document.visibilityState !== "visible" || !enabled) return;
    if (!context) return;
    if (context.state === "running") {
      detachGestureUnlock();
      return;
    }
    resumeContext();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);

  const teardown = () => {
    detachGestureUnlock();
    document.removeEventListener("visibilitychange", onVisibilityChange);
    const current = context;
    context = null;
    primed = false;
    if (current) {
      if (stateListener) current.removeEventListener("statechange", stateListener);
      void current.close().catch(() => {});
    }
    stateListener = null;
    if (activeTeardown === teardown) activeTeardown = null;
  };
  activeTeardown = teardown;
  return teardown;
}
