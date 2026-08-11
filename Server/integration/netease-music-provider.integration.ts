import { expect, test } from "bun:test";

import { NeteaseMusicProvider } from "../src/infrastructure/netease-music-provider";

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

  const response = await fetch(song.audioUrl, {
    headers: { Range: "bytes=0-1023" },
  });
  expect(response.status).toBe(206);
  expect(response.headers.get("content-type")?.startsWith("audio/")).toBe(true);
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
  await response.body?.cancel();
});

test("真实网易云红心数接口返回精确 count 且 countDesc 仅用于展示", async () => {
  const cookie = Bun.env.NETEASE_COOKIE?.trim();
  if (!cookie) throw new Error("请先在 Server/.env 中配置 NETEASE_COOKIE 再运行真实接口测试");
  const provider = new NeteaseMusicProvider();
  const count = await provider.getSongPopularity("65766", cookie);
  expect(count).toBeGreaterThan(1_000);
});
