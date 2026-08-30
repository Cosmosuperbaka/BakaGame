import { expect, test } from "bun:test";

import { NeteaseMusicProvider } from "../src/infrastructure/NeteaseMusicProvider";

test("真实网易云接口可以返回 HTTPS 音频、时间轴歌词并支持分段读取", async () => {
  const cookie = Bun.env.NETEASE_COOKIE?.trim();
  if (!cookie) throw new Error("请先在 Server/.env 中配置 NETEASE_COOKIE 再运行真实接口测试");
  const provider = new NeteaseMusicProvider();
  await provider.getLoginStatus(cookie);

  const results = await provider.search("富士山下 陈奕迅", 10, cookie);
  expect(results.some((song) => song.id === "65766")).toBe(true);
  const song = await provider.getSong("65766", cookie);

  expect(song.id).toBe("65766");
  expect(song.title).toBe("富士山下");
  expect(song.artist).toContain("陈奕迅");
  expect(song.audioUrl.startsWith("https://")).toBe(true);
  expect(song.lyrics.length).toBeGreaterThan(20);
  expect(song.lyrics.some((line) => /Production Coordination|Engineered by|Recorded at/i.test(line.text)))
    .toBe(false);
  expect(song.lyrics.every((line) => line.endTime > line.time)).toBe(true);
});
