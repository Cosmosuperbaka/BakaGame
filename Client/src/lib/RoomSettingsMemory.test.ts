import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDefaultCEESettings } from "@bakagame/shared/values";
import {
  markPendingRestore,
  peekPendingRestore,
  readRoomCreateDefaults,
  readRoomSettingsMemory,
  saveRoomCreateDefaults,
  saveRoomSettingsMemory,
  takePendingRestoreMemory,
  updateRoomSettingsMemory,
  type FakerRoomSettingsMemory,
  type SongRoomGameMemory,
  type SongRoomQuestionMemory,
} from "./RoomSettingsMemory";

describe("room settings memory", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  describe("create defaults", () => {
    it("round-trips the options and never stores a password", () => {
      saveRoomCreateDefaults("cee", {
        visibility: "private",
        allowSpectators: false,
        source: "original",
      });

      expect(readRoomCreateDefaults("cee")).toEqual({
        visibility: "private",
        allowSpectators: false,
        source: "original",
      });
      const raw = window.localStorage.getItem("bakagame:room-create:cee");
      expect(raw).not.toBeNull();
      expect(raw).not.toContain("password");
    });

    it("keeps each game's memory separate", () => {
      saveRoomCreateDefaults("faker", { visibility: "public", allowSpectators: true });

      expect(readRoomCreateDefaults("song")).toBeNull();
      expect(readRoomCreateDefaults("faker")).toEqual({
        visibility: "public",
        allowSpectators: true,
      });
      expect(readRoomCreateDefaults("faker")?.source).toBeUndefined();
    });

    it("falls back to null on corrupt or malformed data", () => {
      window.localStorage.setItem("bakagame:room-create:faker", "{oops");
      expect(readRoomCreateDefaults("faker")).toBeNull();

      window.localStorage.setItem(
        "bakagame:room-create:faker",
        JSON.stringify({ visibility: "weird", allowSpectators: true })
      );
      expect(readRoomCreateDefaults("faker")).toBeNull();

      window.localStorage.setItem(
        "bakagame:room-create:faker",
        JSON.stringify({ visibility: "private", allowSpectators: "yes" })
      );
      expect(readRoomCreateDefaults("faker")).toBeNull();
    });
  });

  describe("settings memory", () => {
    it("round-trips each game's own shape", async () => {
      const faker: FakerRoomSettingsMemory = {
        revealRoleOnDeath: false,
        spectatorsSeeAnswers: true,
        roleConfig: { undercoverCount: 3, hasAngel: true, hasBlank: false },
      };
      saveRoomSettingsMemory("faker", faker);
      expect(await readRoomSettingsMemory("faker")).toEqual(faker);

      const cee = { settings: createDefaultCEESettings(2020) };
      saveRoomSettingsMemory("cee", cee);
      expect(await readRoomSettingsMemory("cee")).toEqual(cee);
    });

    it("merges question and game patches without dropping the other side", async () => {
      const question: SongRoomQuestionMemory = {
        questionType: "anime",
        questionMode: "automatic",
        autoRotateSubmitter: true,
        autoFilters: {
          playlist: { id: "123", name: "测试歌单", songCount: 20 },
          artists: [{ id: "456", name: "测试歌手" }],
          minPopularity: 1000,
        },
        animeAutoFilters: { startYear: 2010, endYear: 2020, ranking: "year", subjectLimit: 100 },
      };
      const game: SongRoomGameMemory = {
        lyricsLineCount: 3,
        showLyrics: true,
        maxGuessesPerRound: 5,
        guessDurationSeconds: 30,
        showGuessTimer: true,
        bloodMode: false,
      };

      updateRoomSettingsMemory("song", (current) => ({ ...current, question }));
      updateRoomSettingsMemory("song", (current) => ({ ...current, game }));
      await vi.waitFor(() =>
        expect(window.localStorage.getItem("bakagame:room-settings:song")).toContain(
          "lyricsLineCount"
        )
      );

      expect(await readRoomSettingsMemory("song")).toEqual({ question, game });
    });

    it("treats corrupt storage as no memory", async () => {
      window.localStorage.setItem("bakagame:room-settings:song", "{oops");
      expect(await readRoomSettingsMemory("song")).toBeNull();
    });

    describe("读出时做形状校验", () => {
      const key = (game: string) => `bakagame:room-settings:${game}`;
      const put = (game: string, value: unknown) =>
        window.localStorage.setItem(key(game), JSON.stringify(value));
      const roleConfig = { undercoverCount: 1, hasAngel: false, hasBlank: false };
      const validQuestion = {
        questionType: "anime",
        questionMode: "automatic",
        autoRotateSubmitter: true,
        autoFilters: {},
        animeAutoFilters: { startYear: 2010, endYear: 2020, ranking: "year", subjectLimit: 100 },
      };

      it.each([
        ["faker", []],
        ["faker", { revealRoleOnDeath: "yes", roleConfig }],
        ["faker", { revealRoleOnDeath: true }],
        ["faker", { revealRoleOnDeath: true, roleConfig: null }],
        ["faker", { revealRoleOnDeath: true, roleConfig: { ...roleConfig, undercoverCount: -1 } }],
        // 记忆里绝不该出现口令：旧版本或云端带进来的口令字段整份丢弃。
        ["faker", { revealRoleOnDeath: true, roleConfig, password: "123456" }],
        ["song", { game: { lyricsLineCount: "3" } }],
        ["song", { question: { ...validQuestion, questionType: "weird" } }],
        ["song", { question: { questionType: "anime" } }],
        ["song", { unknown: {} }],
        ["cee", { settings: null }],
        ["cee", { settings: { startYear: "2020" } }],
        ["cee", []],
      ])("%s 的畸形记忆按无记忆处理并删掉该键：%j", async (game, value) => {
        put(game, value);
        expect(await readRoomSettingsMemory(game as "faker" | "song" | "cee")).toBeNull();
        expect(window.localStorage.getItem(key(game))).toBeNull();
      });

      it("损坏的 JSON 同样删掉该键", async () => {
        window.localStorage.setItem(key("song"), "{oops");
        expect(await readRoomSettingsMemory("song")).toBeNull();
        expect(window.localStorage.getItem(key("song"))).toBeNull();
      });

      it("旧记录没有的可选字段仍然通过校验", async () => {
        put("faker", { revealRoleOnDeath: true, roleConfig });
        expect(await readRoomSettingsMemory("faker")).toEqual({
          revealRoleOnDeath: true,
          roleConfig,
        });
        put("song", { question: validQuestion });
        expect(await readRoomSettingsMemory("song")).toEqual({ question: validQuestion });
      });

      it("读取畸形记忆时 update 不会把畸形字段合并写回", async () => {
        put("song", { game: { lyricsLineCount: "3" }, question: validQuestion });
        updateRoomSettingsMemory("song", (current) => ({ ...current }));
        await vi.waitFor(() =>
          expect(window.localStorage.getItem("bakagame:room-settings:song")).toBe("{}")
        );
        expect(await readRoomSettingsMemory("song")).toEqual({});
      });
    });
  });

  describe("pending restore", () => {
    it("consumes only the matching room and returns its memory", async () => {
      const game: SongRoomGameMemory = {
        lyricsLineCount: 2,
        showLyrics: true,
        maxGuessesPerRound: 3,
        guessDurationSeconds: 20,
        showGuessTimer: false,
        bloodMode: true,
      };
      saveRoomSettingsMemory("song", { game });
      markPendingRestore("song", "ROOM1");

      expect(await takePendingRestoreMemory("song", "OTHER")).toBeNull();
      expect(peekPendingRestore("song")).toBe("ROOM1");

      expect(await takePendingRestoreMemory("song", "ROOM1")).toEqual({ game });
      expect(peekPendingRestore("song")).toBeNull();
    });

    it("returns null but still consumes the mark when there is no memory", async () => {
      markPendingRestore("faker", "ROOM2");

      expect(await takePendingRestoreMemory("faker", "ROOM2")).toBeNull();
      expect(peekPendingRestore("faker")).toBeNull();
    });

    it("has nothing to consume without a mark", async () => {
      saveRoomSettingsMemory("cee", { settings: createDefaultCEESettings(2021) });
      expect(await takePendingRestoreMemory("cee", "ROOM3")).toBeNull();
    });
  });

  it("swallows storage failures instead of throwing", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    expect(() =>
      saveRoomCreateDefaults("faker", { visibility: "public", allowSpectators: true })
    ).not.toThrow();
    expect(() => markPendingRestore("faker", "ROOM4")).not.toThrow();
    spy.mockRestore();
  });
});
