import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudSettings } from "@bakagame/shared";

import type { ApiClient } from "./Api";
import { readLocalPreferences, startCloudSync } from "./CloudSync";
import { notifyPreferencesChanged, onPreferencesApplied } from "./PreferenceBus";
import { getStoredSongMusicSession, saveSongMusicSession } from "./SonGuessrMusicSession";
import { saveUsername } from "./Storage";

const flush = async () => {
  for (let index = 0; index < 30; index += 1) await Promise.resolve();
};

/** 带共享云端文档的假服务端：测试里直接改 `state.preferences` 就相当于「另一台设备写了云端」。 */
const sharedCloud = (initial: Record<string, string> = {}) => {
  const state = {
    preferences: { ...initial },
    music: { netease: null, qq: null } as CloudSettings["music"],
  };
  const saves: Array<Record<string, unknown>> = [];
  const musicSaves: unknown[] = [];
  const control: { holdSave: Promise<void> | null; inSave: number; maxInSave: number } = {
    holdSave: null,
    inSave: 0,
    maxInSave: 0,
  };
  const client = {
    settings: {
      get: vi.fn(async () => ({
        preferences: { value: { ...state.preferences }, updatedAt: "x" },
        music: state.music,
      })),
      savePreferences: vi.fn(async (input: { value: Record<string, unknown> }) => {
        control.inSave += 1;
        control.maxInSave = Math.max(control.maxInSave, control.inSave);
        saves.push(input.value);
        if (control.holdSave) await control.holdSave;
        state.preferences = input.value as Record<string, string>;
        control.inSave -= 1;
        return { updatedAt: "x" };
      }),
      saveMusicSession: vi.fn(async (input: unknown) => {
        musicSaves.push(input);
        return { updatedAt: "x" };
      }),
    },
  } as unknown as ApiClient;
  return { state, saves, musicSaves, control, client };
};

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("云同步：只上传本机改过的键", () => {
  it("两台设备各改不同键，互不覆盖，云端较新的键同时写回本机", async () => {
    window.localStorage.setItem("songuessr_volume", "0.5");
    window.localStorage.setItem("bakagame:username", "旧名");
    const cloud = sharedCloud({ songuessr_volume: "0.5", "bakagame:username": "旧名" });
    const applied = vi.fn();
    const stopApplied = onPreferencesApplied(applied);
    const stop = startCloudSync("user-1", cloud.client);
    await flush();
    expect(cloud.saves).toEqual([]);

    // 另一台设备把音量改成了 0.9 并同步；本机页面没刷新，仍是陈旧的 0.5。
    cloud.state.preferences.songuessr_volume = "0.9";
    saveUsername("新名");
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();

    expect(cloud.saves).toHaveLength(1);
    expect(cloud.state.preferences).toEqual({
      songuessr_volume: "0.9",
      "bakagame:username": "新名",
    });
    expect(window.localStorage.getItem("songuessr_volume")).toBe("0.9");
    expect(applied).toHaveBeenCalled();
    stopApplied();
    stop();
  });

  it("同一个键两边都改过，后写者为准：本机晚写就是本机的值", async () => {
    window.localStorage.setItem("bakagame:username", "旧名");
    const cloud = sharedCloud({ "bakagame:username": "旧名" });
    const stop = startCloudSync("user-1", cloud.client);
    await flush();

    cloud.state.preferences["bakagame:username"] = "别的设备";
    saveUsername("本机晚写");
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(cloud.state.preferences["bakagame:username"]).toBe("本机晚写");
    stop();
  });

  it("本机没改的键不会被陈旧值回写，云端晚写的键保持云端值", async () => {
    window.localStorage.setItem("bakagame:username", "旧名");
    window.localStorage.setItem("songuessr_volume", "0.5");
    const cloud = sharedCloud({ "bakagame:username": "旧名", songuessr_volume: "0.5" });
    const stop = startCloudSync("user-1", cloud.client);
    await flush();

    cloud.state.preferences["bakagame:username"] = "别的设备晚写";
    window.localStorage.setItem("songuessr_volume", "0.2");
    notifyPreferencesChanged();
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(cloud.state.preferences).toEqual({
      "bakagame:username": "别的设备晚写",
      songuessr_volume: "0.2",
    });
    stop();
  });

  it("上传在途时的并发推送只发一次：同时只有一份在途，结束后只补推新改动", async () => {
    window.localStorage.setItem("bakagame:username", "旧名");
    const cloud = sharedCloud({ "bakagame:username": "旧名" });
    const stop = startCloudSync("user-1", cloud.client);
    await flush();

    let release: () => void = () => {};
    cloud.control.holdSave = new Promise<void>((resolve) => {
      release = resolve;
    });
    saveUsername("第一次");
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(cloud.saves).toHaveLength(1);

    // 上传还没返回，又来一处改动与两次推送请求。
    window.localStorage.setItem("songuessr_volume", "0.7");
    notifyPreferencesChanged();
    await vi.advanceTimersByTimeAsync(2_000);
    notifyPreferencesChanged();
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(cloud.saves).toHaveLength(1);
    expect(cloud.control.maxInSave).toBe(1);

    cloud.control.holdSave = null;
    release();
    await flush();
    expect(cloud.saves).toHaveLength(2);
    expect(cloud.control.maxInSave).toBe(1);
    expect(cloud.state.preferences).toEqual({
      "bakagame:username": "第一次",
      songuessr_volume: "0.7",
    });
    stop();
  });
});

describe("云同步：本机缓存绑定账号", () => {
  const signedInAs = async (userId: string, cloud: ReturnType<typeof sharedCloud>) => {
    const stop = startCloudSync(userId, cloud.client);
    await flush();
    return stop;
  };

  it("甲登出、乙登入后，乙的云端不出现甲的任何键", async () => {
    const cloudA = sharedCloud({});
    const stopA = await signedInAs("甲", cloudA);
    saveUsername("甲的昵称");
    window.localStorage.setItem("songuessr_volume", "0.8");
    saveSongMusicSession(
      { cookie: "MUSIC_U=甲的凭据", account: { platform: "netease", nickname: "甲" } },
      true,
      "netease"
    );
    notifyPreferencesChanged();
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(cloudA.state.preferences["bakagame:username"]).toBe("甲的昵称");
    stopA();

    // 甲退出登录（本机缓存原样留下），乙登录，乙的云端什么都没有。
    const cloudB = sharedCloud({});
    const stopB = await signedInAs("乙", cloudB);
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();

    expect(cloudB.saves).toEqual([]);
    expect(cloudB.musicSaves).toEqual([]);
    expect(readLocalPreferences()).toEqual({});
    expect(getStoredSongMusicSession("netease")).toBeNull();

    // 乙自己之后的改动正常上传，且不带甲的任何键。
    saveUsername("乙的昵称");
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(cloudB.state.preferences).toEqual({ "bakagame:username": "乙的昵称" });
    expect(cloudB.musicSaves).toEqual([]);
    stopB();
  });

  it("只在本次会话里登录的音乐账号（会话存储）同样不带进新账号", async () => {
    const cloudA = sharedCloud({});
    const stopA = await signedInAs("甲", cloudA);
    saveSongMusicSession(
      { cookie: "qqmusic_key=甲", account: { platform: "qq", nickname: "甲" } },
      false,
      "qq"
    );
    stopA();

    const cloudB = sharedCloud({});
    const stopB = await signedInAs("乙", cloudB);
    expect(cloudB.musicSaves).toEqual([]);
    expect(getStoredSongMusicSession("qq")).toBeNull();
    stopB();
  });

  it("读取云端失败时也先清掉上一个账号的数据，不留着等下一次上传", async () => {
    window.localStorage.setItem("bakagame:cloud-sync-user", "甲");
    window.localStorage.setItem("bakagame:username", "甲的昵称");
    const client = {
      settings: {
        get: vi.fn(async () => {
          throw new Error("offline");
        }),
        savePreferences: vi.fn(),
        saveMusicSession: vi.fn(),
      },
    } as unknown as ApiClient;
    const stop = startCloudSync("乙", client);
    await flush();
    expect(window.localStorage.getItem("bakagame:username")).toBeNull();
    stop();
  });

  it("同一个账号重新登录不清本机数据；没有归属记录的本机数据带入首次登录的账号", async () => {
    window.localStorage.setItem("bakagame:username", "游客昵称");
    const cloud = sharedCloud({});
    const stop = await signedInAs("甲", cloud);
    expect(cloud.state.preferences).toEqual({ "bakagame:username": "游客昵称" });
    stop();

    window.localStorage.setItem("songuessr_volume", "0.3");
    const again = await signedInAs("甲", cloud);
    expect(window.localStorage.getItem("songuessr_volume")).toBe("0.3");
    expect(cloud.state.preferences.songuessr_volume).toBe("0.3");
    again();
  });
});
