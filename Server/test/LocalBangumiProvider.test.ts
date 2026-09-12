import { describe, expect, test } from "bun:test";
import { LocalBangumiProvider } from "../src/infrastructure/LocalBangumiProvider";
import { resolve } from "node:path";

describe("LocalBangumiProvider", () => {
  test("searches and loads local records", async () => {
    const provider = new LocalBangumiProvider(resolve(import.meta.dir, "../data/bangumi-song.sqlite"), resolve(import.meta.dir, "../data/bangumi-character.sqlite"));
    const rows = await provider.searchSubjects("", 5);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].id).toMatch(/^\d+$/);
    const detail = await provider.getSubject(rows[0].id);
    expect(detail.musicTracks).toBeArray();
    provider.close();
  });
});
