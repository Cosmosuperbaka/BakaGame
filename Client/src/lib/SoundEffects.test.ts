import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getSoundEnabled,
  initSoundEffects,
  playSound,
  setSoundEnabled,
  SOUND_STORAGE_KEY,
} from "@/lib/SoundEffects";

class FakeParam {
  setValueAtTime = vi.fn();
  linearRampToValueAtTime = vi.fn();
}

class FakeOscillator {
  type = "sine";
  frequency = new FakeParam();
  connect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

class FakeGain {
  gain = new FakeParam();
  connect = vi.fn();
}

class FakeBufferSource {
  buffer: AudioBuffer | null = null;
  connect = vi.fn();
  start = vi.fn();
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static initialState: AudioContextState = "running";
  static blockResume = false;

  state: AudioContextState;
  currentTime = 0;
  destination = {} as AudioDestinationNode;
  sampleRate = 48_000;
  oscillators: FakeOscillator[] = [];
  gains: FakeGain[] = [];
  sources: FakeBufferSource[] = [];
  resumeCalls = 0;
  suspendCalls = 0;
  closeCalls = 0;
  private listeners = new Set<() => void>();

  constructor() {
    this.state = FakeAudioContext.initialState;
    FakeAudioContext.instances.push(this);
  }

  addEventListener(type: string, listener: () => void) {
    if (type === "statechange") this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: () => void) {
    if (type === "statechange") this.listeners.delete(listener);
  }

  private fireStateChange() {
    for (const listener of this.listeners) listener();
  }

  createGain() {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }

  createOscillator() {
    const oscillator = new FakeOscillator();
    this.oscillators.push(oscillator);
    return oscillator;
  }

  createBuffer() {
    return {} as AudioBuffer;
  }

  createBufferSource() {
    const source = new FakeBufferSource();
    this.sources.push(source);
    return source;
  }

  resume = () => {
    this.resumeCalls += 1;
    if (FakeAudioContext.blockResume) return Promise.reject(new Error("blocked"));
    this.state = "running";
    this.fireStateChange();
    return Promise.resolve();
  };

  suspend = () => {
    this.suspendCalls += 1;
    this.state = "suspended";
    this.fireStateChange();
    return Promise.resolve();
  };

  close = () => {
    this.closeCalls += 1;
    this.state = "closed";
    this.fireStateChange();
    return Promise.resolve();
  };
}

const stubAudio = () => {
  vi.stubGlobal("AudioContext", FakeAudioContext as unknown as typeof AudioContext);
};

const press = () => window.dispatchEvent(new Event("pointerdown"));

let stop: (() => void) | null = null;

beforeEach(() => {
  FakeAudioContext.instances = [];
  FakeAudioContext.initialState = "running";
  FakeAudioContext.blockResume = false;
  window.localStorage.clear();
});

afterEach(() => {
  stop?.();
  stop = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("sound effects", () => {
  it("waits for the first gesture and schedules the round-start recipe", () => {
    stubAudio();
    stop = initSoundEffects();

    playSound("roundStart");
    expect(FakeAudioContext.instances).toHaveLength(0);

    press();
    const ctx = FakeAudioContext.instances[0]!;
    expect(ctx.state).toBe("running");
    expect(ctx.sources).toHaveLength(1);

    playSound("roundStart");
    expect(ctx.oscillators).toHaveLength(2);
    expect(ctx.gains[0]!.gain.setValueAtTime).toHaveBeenCalledWith(0.5, 0);

    const [first, second] = ctx.oscillators;
    expect(first!.type).toBe("triangle");
    expect(first!.frequency.setValueAtTime).toHaveBeenCalledWith(659.25, 0);
    expect(first!.start).toHaveBeenCalledWith(0);
    expect(first!.stop).toHaveBeenCalledWith(0.24);
    expect(ctx.gains[1]!.gain.setValueAtTime).toHaveBeenNthCalledWith(1, 0.0001, 0);
    expect(ctx.gains[1]!.gain.linearRampToValueAtTime).toHaveBeenNthCalledWith(1, 0.5, 0.012);
    expect(ctx.gains[1]!.gain.setValueAtTime).toHaveBeenNthCalledWith(2, 0.5, 0.072);
    expect(ctx.gains[1]!.gain.linearRampToValueAtTime).toHaveBeenNthCalledWith(2, 0.0001, 0.22);

    expect(second!.type).toBe("sine");
    expect(second!.frequency.setValueAtTime).toHaveBeenCalledWith(987.77, 0.09);
    expect(second!.start).toHaveBeenCalledWith(0.09);
    expect(second!.stop).toHaveBeenCalledWith(0.49);
  });

  it("keeps retrying after a blocked resume instead of going permanently silent", () => {
    FakeAudioContext.initialState = "suspended";
    FakeAudioContext.blockResume = true;
    stubAudio();
    stop = initSoundEffects();

    press();
    const ctx = FakeAudioContext.instances[0]!;
    expect(ctx.state).toBe("suspended");
    expect(ctx.resumeCalls).toBeGreaterThan(0);

    playSound("roundStart");
    expect(ctx.oscillators).toHaveLength(0);

    FakeAudioContext.blockResume = false;
    press();
    expect(ctx.state).toBe("running");
    playSound("roundStart");
    expect(ctx.oscillators).toHaveLength(2);
  });

  it("drops sounds while suspended and resumes on visibility change", async () => {
    stubAudio();
    stop = initSoundEffects();
    press();
    const ctx = FakeAudioContext.instances[0]!;

    playSound("actionRequired");
    expect(ctx.oscillators).toHaveLength(3);

    await ctx.suspend();
    playSound("actionRequired");
    expect(ctx.oscillators).toHaveLength(3);

    document.dispatchEvent(new Event("visibilitychange"));
    expect(ctx.state).toBe("running");
    playSound("actionRequired");
    expect(ctx.oscillators).toHaveLength(6);
  });

  it("persists the global toggle and silences playback while off", () => {
    stubAudio();
    stop = initSoundEffects();
    press();
    const ctx = FakeAudioContext.instances[0]!;

    setSoundEnabled(false);
    expect(window.localStorage.getItem(SOUND_STORAGE_KEY)).toBe("0");
    expect(ctx.suspendCalls).toBeGreaterThan(0);
    playSound("chatMessage");
    expect(ctx.oscillators).toHaveLength(0);

    setSoundEnabled(true);
    expect(window.localStorage.getItem(SOUND_STORAGE_KEY)).toBe("1");
    expect(ctx.resumeCalls).toBeGreaterThan(0);
    playSound("chatMessage");
    expect(ctx.oscillators).toHaveLength(2);
  });

  it("restores a stored off preference without creating a context", () => {
    stubAudio();
    window.localStorage.setItem(SOUND_STORAGE_KEY, "0");
    stop = initSoundEffects();

    expect(getSoundEnabled()).toBe(false);
    press();
    playSound("roundStart");
    expect(FakeAudioContext.instances).toHaveLength(0);
  });

  it("stays silent when Web Audio is unavailable", () => {
    vi.stubGlobal("AudioContext", undefined);
    stop = initSoundEffects();
    expect(() => {
      press();
      playSound("roundStart");
    }).not.toThrow();
  });

  it("uses distinct levels and notes for action and chat sounds", () => {
    stubAudio();
    stop = initSoundEffects();
    press();
    const ctx = FakeAudioContext.instances[0]!;

    playSound("actionRequired");
    expect(ctx.oscillators).toHaveLength(3);
    expect(ctx.gains[0]!.gain.setValueAtTime).toHaveBeenCalledWith(0.7, 0);
    expect(ctx.oscillators[0]!.frequency.setValueAtTime).toHaveBeenCalledWith(880, 0);
    expect(ctx.oscillators[1]!.frequency.setValueAtTime).toHaveBeenCalledWith(1108.73, 0.08);
    expect(ctx.oscillators[2]!.frequency.setValueAtTime).toHaveBeenCalledWith(1318.51, 0.16);

    playSound("chatMessage");
    expect(ctx.oscillators).toHaveLength(5);
    expect(ctx.gains[4]!.gain.setValueAtTime).toHaveBeenCalledWith(0.55, 0);
    expect(ctx.oscillators[3]!.frequency.setValueAtTime).toHaveBeenCalledWith(1046.5, 0);
    expect(ctx.oscillators[4]!.frequency.setValueAtTime).toHaveBeenCalledWith(523.25, 0);
  });
});
