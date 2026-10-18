import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDefaultCEESettings } from "@bakagame/shared";
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
    it("round-trips each game's own shape", () => {
      const faker: FakerRoomSettingsMemory = {
        revealRoleOnDeath: false,
        roleConfig: { undercoverCount: 3, hasAngel: true, hasBlank: false },
      };
      saveRoomSettingsMemory("faker", faker);
      expect(readRoomSettingsMemory("faker")).toEqual(faker);

      const cee = { settings: createDefaultCEESettings(2020) };
      saveRoomSettingsMemory("cee", cee);
      expect(readRoomSettingsMemory("cee")).toEqual(cee);
    });

    it("merges question and game patches without dropping the other side", () => {
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

      expect(readRoomSettingsMemory("song")).toEqual({ question, game });
    });

    it("treats corrupt storage as no memory", () => {
      window.localStorage.setItem("bakagame:room-settings:song", "{oops");
      expect(readRoomSettingsMemory("song")).toBeNull();
    });
  });

  describe("pending restore", () => {
    it("consumes only the matching room and returns its memory", () => {
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

      expect(takePendingRestoreMemory("song", "OTHER")).toBeNull();
      expect(peekPendingRestore("song")).toBe("ROOM1");

      expect(takePendingRestoreMemory("song", "ROOM1")).toEqual({ game });
      expect(peekPendingRestore("song")).toBeNull();
    });

    it("returns null but still consumes the mark when there is no memory", () => {
      markPendingRestore("faker", "ROOM2");

      expect(takePendingRestoreMemory("faker", "ROOM2")).toBeNull();
      expect(peekPendingRestore("faker")).toBeNull();
    });

    it("has nothing to consume without a mark", () => {
      saveRoomSettingsMemory("cee", { settings: createDefaultCEESettings(2021) });
      expect(takePendingRestoreMemory("cee", "ROOM3")).toBeNull();
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
