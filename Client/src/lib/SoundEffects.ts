import { useSyncExternalStore } from "react";

/** 可播放的音效。新增时在 `RECIPES` 里补一条合成配方即可，不引入音频文件。 */
export type SoundName = "roundStart";

/** 与音效开关共用；刷新后保持上一次选择。 */
export const SOUND_STORAGE_KEY = "bakagame:sound";

type Tone = {
  frequency: number;
  /** 相对整段音效起点的延迟（秒） */
  offset: number;
  duration: number;
  type: OscillatorType;
  gain: number;
};

/**
 * 短促、柔和的提示音：振荡器现场合成，没有音频资源，
 * 不受 `<audio>` 的 `crossOrigin` 与解码链影响（猜歌灰化链也不碰它）。
 */
const RECIPES: Record<SoundName, readonly Tone[]> = {
  roundStart: [
    { frequency: 659.25, offset: 0, duration: 0.16, type: "triangle", gain: 0.16 },
    { frequency: 987.77, offset: 0.09, duration: 0.3, type: "sine", gain: 0.13 },
  ],
};

const MASTER_GAIN = 0.5;

const listeners = new Set<() => void>();
let enabled = true;
let context: AudioContext | null = null;
let unlocked = false;
let activeTeardown: (() => void) | null = null;

function readStoredEnabled(): boolean {
  try {
    return window.localStorage.getItem(SOUND_STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

function emit(): void {
  for (const listener of listeners) listener();
}

export function getSoundEnabled(): boolean {
  return enabled;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSoundEnabled(): boolean {
  return useSyncExternalStore(subscribe, getSoundEnabled, () => true);
}

/**
 * 只在用户交互里创建 AudioContext：浏览器会在其它时机把上下文挂起，
 * 之后再播放就是无声失败。创建后通常直接是 running，个别浏览器仍需 resume。
 */
function unlock(): void {
  if (unlocked) return;
  unlocked = true;
  try {
    const Ctor = window.AudioContext;
    if (!Ctor) return;
    context = new Ctor();
    if (context.state === "suspended") void context.resume().catch(() => {});
    if (!enabled) void context.suspend().catch(() => {});
  } catch {
    // 不支持 Web Audio 或被策略拦截：音效静默缺席，不影响其它功能。
    context = null;
  }
}

/** 播放一个音效。未解锁、已关闭或不支持 Web Audio 时静默返回。 */
export function playSound(name: SoundName): void {
  if (!enabled || !unlocked || !context) return;
  const ctx = context;
  try {
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    const master = ctx.createGain();
    master.gain.setValueAtTime(MASTER_GAIN, ctx.currentTime);
    master.connect(ctx.destination);
    for (const tone of RECIPES[name]) {
      const start = ctx.currentTime + tone.offset;
      const end = start + tone.duration;
      const oscillator = ctx.createOscillator();
      const envelope = ctx.createGain();
      oscillator.type = tone.type;
      oscillator.frequency.setValueAtTime(tone.frequency, start);
      envelope.gain.setValueAtTime(0.0001, start);
      envelope.gain.linearRampToValueAtTime(tone.gain, start + 0.015);
      envelope.gain.exponentialRampToValueAtTime(0.0001, end);
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
    unlock();
    if (context?.state === "suspended") void context.resume().catch(() => {});
  } else if (context) {
    void context.suspend().catch(() => {});
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

  const events = ["pointerdown", "keydown", "touchend"] as const;
  const detach = () => {
    for (const event of events) window.removeEventListener(event, onFirstInteraction);
  };
  const onFirstInteraction = () => {
    unlock();
    detach();
  };
  for (const event of events) window.addEventListener(event, onFirstInteraction, { passive: true });
  const teardown = () => {
    detach();
    unlocked = false;
    const current = context;
    context = null;
    if (current) void current.close().catch(() => {});
    if (activeTeardown === teardown) activeTeardown = null;
  };
  activeTeardown = teardown;
  return teardown;
}
