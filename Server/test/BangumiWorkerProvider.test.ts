import { describe, expect, test } from "bun:test";
import { BangumiWorkerProvider } from "../src/infrastructure/BangumiWorkerProvider";
import { resolve } from "node:path";

describe("BangumiWorkerProvider", () => {
  test("runs sqlite query outside the main provider", async () => {
    const provider = new BangumiWorkerProvider(resolve(import.meta.dir, "../data/bangumi-song.sqlite"), resolve(import.meta.dir, "../data/bangumi-character.sqlite"));
    const rows = await provider.searchSubjects("", 3);
    expect(rows.length).toBeGreaterThan(0);
    await provider.close();
  });
});
