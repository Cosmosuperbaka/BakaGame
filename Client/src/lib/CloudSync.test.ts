import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudSettings } from "@/types";

import type { ApiClient } from "./Api";
import { readLocalPreferences, startCloudSync } from "./CloudSync";
import { getStoredSongMusicSession, saveSongMusicSession, clearStoredSongMusicSession } from "./SonGuessrMusicSession";
import { notifyPreferencesChanged, PREFERENCES_APPLIED, saveUsername } from "./Storage";

const netease = { cookie: "MUSIC_U=cloud", account: { platform: "netease" as const, nickname: "云端" } };

const fakeClient = (cloud: CloudSettings) => {
  const savePreferences = vi.fn<(input: { value: Record<string, unknown> }) => Promise<{ updatedAt: string }>>(async () => ({ updatedAt: "2026-10-13T00:00:00.000Z" }));
  const saveMusicSession = vi.fn<(input: unknown) => Promise<{ updatedAt: string }>>(async () => ({ updatedAt: "2026-10-13T00:00:00.000Z" }));
  const client = {
    settings: { get: vi.fn(async () => cloud), savePreferences, saveMusicSession },
  } as unknown as ApiClient;
  return { client, savePreferences, saveMusicSession };
};

const flush = async () => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("云同步", () => {
  it("只收同步范围内的键", () => {
    window.localStorage.setItem("bakagame:username", "阿狸");
    window.localStorage.setItem("songuessr_volume", "0.4");
    window.localStorage.setItem("bakagame:room-settings:cee", "{}");
    window.localStorage.setItem("bakagame:room-restore:cee", "ROOM");
    window.localStorage.setItem("bakagame:visitor", "abcdefghijklmnop");
    expect(readLocalPreferences()).toEqual({
      "bakagame:username": "阿狸",
      songuessr_volume: "0.4",
      "bakagame:room-settings:cee": "{}",
    });
  });

  it("登录时逐键合并：同键以云端为准，本地独有的键保留并回传", async () => {
    window.localStorage.setItem("songuessr_volume", "0.4");
    window.localStorage.setItem("bakagame:username", "本机");
    const applied = vi.fn();
    window.addEventListener(PREFERENCES_APPLIED, applied);
    const { client, savePreferences } = fakeClient({
      preferences: { value: { songuessr_volume: "0.9", "bakagame:room-create:faker": "{\"visibility\":\"public\"}" }, updatedAt: "x" },
      music: { netease: null, qq: null },
    });

    const stop = startCloudSync(client);
    await flush();
    expect(window.localStorage.getItem("songuessr_volume")).toBe("0.9");
    expect(window.localStorage.getItem("bakagame:room-create:faker")).toBe("{\"visibility\":\"public\"}");
    expect(applied).toHaveBeenCalledOnce();
    expect(savePreferences).toHaveBeenCalledWith({
      value: { songuessr_volume: "0.9", "bakagame:username": "本机", "bakagame:room-create:faker": "{\"visibility\":\"public\"}" },
    });
    stop();
    window.removeEventListener(PREFERENCES_APPLIED, applied);
  });

  it("云端与本地一致时不上传；之后的本地改动防抖合并成一次上传，停止后不再上传", async () => {
    window.localStorage.setItem("songuessr_volume", "0.5");
    const { client, savePreferences } = fakeClient({
      preferences: { value: { songuessr_volume: "0.5" }, updatedAt: "x" },
      music: { netease: null, qq: null },
    });
    const stop = startCloudSync(client);
    await flush();
    expect(savePreferences).not.toHaveBeenCalled();

    saveUsername("甲");
    saveUsername("乙");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(savePreferences).toHaveBeenCalledOnce();
    expect(savePreferences.mock.calls[0]?.[0].value).toMatchObject({ "bakagame:username": "乙" });

    stop();
    saveUsername("丙");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(savePreferences).toHaveBeenCalledOnce();
  });

  it("两边都没有偏好时不建空文档", async () => {
    const { client, savePreferences } = fakeClient({ preferences: null, music: { netease: null, qq: null } });
    const stop = startCloudSync(client);
    await flush();
    notifyPreferencesChanged();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(savePreferences).not.toHaveBeenCalled();
    stop();
  });

  it("音乐账号：云端有则写回本地且不回传，只有本地有则上传", async () => {
    saveSongMusicSession({ cookie: "qqmusic_key=local", account: { platform: "qq", nickname: "本机" } }, false, "qq");
    const { client, saveMusicSession } = fakeClient({ preferences: null, music: { netease, qq: null } });
    const stop = startCloudSync(client);
    await flush();

    expect(getStoredSongMusicSession("netease")).toMatchObject({ cookie: "MUSIC_U=cloud", persistent: true });
    expect(saveMusicSession).toHaveBeenCalledOnce();
    expect(saveMusicSession).toHaveBeenCalledWith({
      platform: "qq",
      session: { cookie: "qqmusic_key=local", account: { platform: "qq", nickname: "本机" } },
    });

    // 登录期间退出音乐账号：删除云端副本。
    clearStoredSongMusicSession("netease");
    await flush();
    expect(saveMusicSession).toHaveBeenLastCalledWith({ platform: "netease", session: null });
    stop();
  });

  it("读取云端失败时不改本地、不上传", async () => {
    window.localStorage.setItem("songuessr_volume", "0.3");
    const client = { settings: { get: vi.fn(async () => { throw new Error("offline"); }), savePreferences: vi.fn(), saveMusicSession: vi.fn() } } as unknown as ApiClient;
    const stop = startCloudSync(client);
    await flush();
    saveUsername("甲");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(window.localStorage.getItem("songuessr_volume")).toBe("0.3");
    expect((client.settings.savePreferences as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    stop();
  });
});
