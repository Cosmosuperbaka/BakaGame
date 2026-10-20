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
  exponentialRampToValueAtTime = vi.fn();
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

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];

  currentTime = 0;
  state: AudioContextState = "running";
  destination = {};
  oscillators: FakeOscillator[] = [];
  resume = vi.fn(() => Promise.resolve());
  suspend = vi.fn(() => Promise.resolve());
  close = vi.fn(() => Promise.resolve());

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createGain() {
    return new FakeGain();
  }

  createOscillator() {
    const oscillator = new FakeOscillator();
    this.oscillators.push(oscillator);
    return oscillator;
  }
}

const installAudio = () => {
  vi.stubGlobal("AudioContext", FakeAudioContext as unknown as typeof AudioContext);
};

let stop: (() => void) | null = null;

beforeEach(() => {
  FakeAudioContext.instances = [];
});

afterEach(() => {
  stop?.();
  stop = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("sound effects", () => {
  it("creates the AudioContext only after the first user interaction", () => {
    installAudio();
    stop = initSoundEffects();

    playSound("roundStart");
    expect(FakeAudioContext.instances).toHaveLength(0);

    window.dispatchEvent(new Event("pointerdown"));
    expect(FakeAudioContext.instances).toHaveLength(1);

    playSound("roundStart");
    expect(FakeAudioContext.instances[0]!.oscillators).toHaveLength(2);
    // 每个音都排了起止时间，合成后自动释放。
    const [first] = FakeAudioContext.instances[0]!.oscillators;
    expect(first!.start).toHaveBeenCalledOnce();
    expect(first!.stop).toHaveBeenCalledOnce();
  });

  it("persists the global toggle and silences playback while off", () => {
    installAudio();
    stop = initSoundEffects();
    window.dispatchEvent(new KeyboardEvent("keydown"));
    expect(getSoundEnabled()).toBe(true);

    setSoundEnabled(false);
    expect(window.localStorage.getItem(SOUND_STORAGE_KEY)).toBe("0");
    expect(getSoundEnabled()).toBe(false);
    expect(FakeAudioContext.instances[0]!.suspend).toHaveBeenCalled();

    const before = FakeAudioContext.instances[0]!.oscillators.length;
    playSound("roundStart");
    expect(FakeAudioContext.instances[0]!.oscillators).toHaveLength(before);

    setSoundEnabled(true);
    expect(window.localStorage.getItem(SOUND_STORAGE_KEY)).toBe("1");
    playSound("roundStart");
    expect(FakeAudioContext.instances[0]!.oscillators).toHaveLength(before + 2);
  });

  it("restores a stored off preference", () => {
    installAudio();
    window.localStorage.setItem(SOUND_STORAGE_KEY, "0");
    stop = initSoundEffects();
    expect(getSoundEnabled()).toBe(false);
  });

  it("stays silent when Web Audio is unavailable", () => {
    vi.stubGlobal("AudioContext", undefined);
    stop = initSoundEffects();
    expect(() => {
      window.dispatchEvent(new Event("pointerdown"));
      playSound("roundStart");
    }).not.toThrow();
  });
});
