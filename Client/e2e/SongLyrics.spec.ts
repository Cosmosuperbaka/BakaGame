import { expect, test, type Page } from "@playwright/test";
import type { SongLyricPlayerProps } from "../src/components/songuessr/lyrics/SongLyricPlayer";
import type { SongLyricLine } from "../src/types";

declare global {
  interface Window {
    lyricsFixture: {
      render(props: Partial<SongLyricPlayerProps>): void;
      time(ms: number, playing: boolean): void;
    };
  }
}

const lines: SongLyricLine[] = Array.from({ length: 8 }, (_, index) => ({
  time: 35000 + index * 4000,
  endTime: 39000 + index * 4000,
  text: `夜空に浮かぶ星たち 静寂を切り裂いていく ${index + 1}`,
  translatedLyric: "浮现在夜空中的群星点点 将这无尽的寂静一点点撕裂开来",
}));

async function render(page: Page, props: Partial<SongLyricPlayerProps>) {
  await page.evaluate((props) => window.lyricsFixture.render(props), props);
  await expect(page.locator(".baka-lyric-host")).toHaveAttribute("data-ready", "true");
}

async function expectOverviewFits(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const host = document.querySelector<HTMLElement>(".baka-lyric-host")!;
    const groups = [...host.querySelectorAll<HTMLElement>("[class*=lyricLineWrapper]")];
    const box = host.getBoundingClientRect();
    const top = groups[0].getBoundingClientRect().top - box.top;
    const bottom = box.bottom - groups.at(-1)!.getBoundingClientRect().bottom;
    return Math.abs(top) < 1 && bottom >= -1 && bottom < 2;
  })).toBe(true);
  const gap = await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>(".baka-lyric-host")!;
    const groups = [...host.querySelectorAll<HTMLElement>("[class*=lyricLineWrapper]")];
    return host.getBoundingClientRect().bottom - groups.at(-1)!.getBoundingClientRect().bottom;
  });
  expect(gap).toBeGreaterThanOrEqual(-1);
  expect(gap).toBeLessThan(2);
}

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => { throw error; });
  page.on("console", (message) => {
    if (message.type() === "error") throw new Error(message.text());
  });
  await page.goto("/e2e/fixtures/SongLyrics.html");
  await page.waitForFunction(() => Boolean(window.lyricsFixture));
});

for (const width of [390, 820, 1280]) {
  test(`${width}px 翻译、注音、和声与长句的总览完整贴合`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    for (const variant of [
      [{ time: 35000, endTime: 39000, text: "短句" }],
      lines,
      lines.map((line) => ({ ...line, translatedLyric: "", romanLyric: "yo zo ra ni u ka bu ho shi ta chi shi ji ma wo ki ri sa i te i ku" })),
      lines.map((line) => ({ ...line, translatedLyric: "", words: [
        { startTime: line.time, endTime: line.time + 2000, word: "夜空に浮かぶ", romanWord: "yo zo ra ni u ka bu" },
        { startTime: line.time + 2000, endTime: line.endTime, word: "星たち", romanWord: "ho shi ta chi" },
      ] })),
      lines.flatMap((line) => [line, { ...line, time: line.time + 200, endTime: line.endTime - 200, text: "和声が遠くまで響き続ける", isBG: true }]),
      lines.map((line, index) => ({ ...line, isDuet: index % 2 === 1 })),
    ]) {
      await render(page, { lines: variant, audioPlaybackState: "completed" });
      await expectOverviewFits(page);
    }
    // 首次测量结束之后再改变字号，必须仍能响应，不得锁死旧高度。
    await page.evaluate(() => { document.documentElement.style.fontSize = "24px"; });
    await expectOverviewFits(page);
  });
}

test("结束、缩小下移与快速重播均保持原节点和连续位置", async ({ page }) => {
  await render(page, { lines, audioPlaybackState: "playing" });
  await page.evaluate(() => window.lyricsFixture.time(62500, true));
  // 等原生滚动落位，再采集完成前后及动画中间帧。
  await page.waitForTimeout(800);
  const result = await page.evaluate(async () => {
    const host = document.querySelector<HTMLElement>(".baka-lyric-host")!;
    const player = host.firstElementChild!;
    const groups = [...host.querySelectorAll<HTMLElement>("[class*=lyricLineWrapper]")];
    const last = groups.at(-1)!;
    const read = () => ({ y: last.getBoundingClientRect().y, height: host.clientHeight,
      scale: new DOMMatrix(getComputedStyle(player).transform).a });
    const before = read();
    window.lyricsFixture.time(62500, false);
    const paused = read();
    window.lyricsFixture.render({ audioPlaybackState: "completed" });
    const start = read();
    const frames = [];
    const deadline = performance.now() + 550;
    while (performance.now() < deadline) {
      await new Promise(requestAnimationFrame);
      frames.push(read());
    }
    const stable = groups.every((group) => group.isConnected);
    // 过渡未结束就重播，应从当前屏幕位置反向接续。
    window.lyricsFixture.time(34000, true);
    window.lyricsFixture.render({ audioPlaybackState: "playing" });
    await new Promise(requestAnimationFrame);
    const replayBefore = read();
    window.lyricsFixture.render({ audioPlaybackState: "completed" });
    const replayAfter = read();
    return { before, paused, start, frames, stable, replayBefore, replayAfter };
  });
  expect(result.stable).toBe(true);
  expect(result.paused.y).toBeCloseTo(result.before.y, 1);
  expect(result.start.y).toBeCloseTo(result.before.y, 1);
  expect(result.frames.at(-1)!.y).toBeGreaterThan(result.start.y + 50);
  expect(result.frames.filter((frame) => frame.scale > 0.921 && frame.scale < 0.999).length).toBeGreaterThan(3);
  expect(new Set(result.frames.map((frame) => frame.height)).size).toBe(1);
  expect(result.replayAfter.y).toBeCloseTo(result.replayBefore.y, 1);
  await expectOverviewFits(page);
});

test("首次可见布局稳定，快照复制不重建，逐字更新必须生效", async ({ page }) => {
  const result = await page.evaluate(async (lines) => {
    const frames: number[] = [];
    window.lyricsFixture.render({ lines, audioPlaybackState: "idle", audioStatus: "loading" });
    const host = document.querySelector<HTMLElement>(".baka-lyric-host")!;
    const deadline = performance.now() + 900;
    while (performance.now() < deadline) {
      await new Promise(requestAnimationFrame);
      if (host.dataset.ready) frames.push(host.querySelector("[class*=lyricLineWrapper]")!.getBoundingClientRect().y);
    }
    const original = host.querySelector("[class*=lyricLineWrapper]");
    window.lyricsFixture.render({ lines: structuredClone(lines), audioStatus: "ready" });
    return { frames, same: original === host.querySelector("[class*=lyricLineWrapper]") };
  }, lines);
  expect(result.same).toBe(true);
  expect(result.frames.length).toBeGreaterThan(5);
  expect(Math.max(...result.frames) - Math.min(...result.frames)).toBeLessThan(1);
  await render(page, { lines: [{ ...lines[0], words: [{ startTime: 35000, endTime: 39000, word: "変更前" }] }] });
  await render(page, { lines: [{ ...lines[0], words: [{ startTime: 35000, endTime: 39000, word: "変更後" }] }] });
  await expect(page.locator(".baka-lyric-player")).toContainText("変更後");
  await expect(page.locator(".baka-lyric-player")).not.toContainText("変更前");
});

test("减弱动效直接落位且纯音乐后能载入歌词", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => window.lyricsFixture.render({ lines: [] }));
  await expect(page.getByText("当前歌曲为纯音乐或无歌词")).toBeVisible();
  await render(page, { lines, audioPlaybackState: "playing" });
  await render(page, { audioPlaybackState: "completed" });
  await expectOverviewFits(page);
  expect(await page.locator(".baka-lyric-player").evaluate((element) => element.getAnimations().length)).toBe(0);
});

test("和声活动切换不改变外壳高度，也不接管页面滚动", async ({ page }) => {
  const source = lines.flatMap((line) => [line, {
    ...line, time: line.time + 200, endTime: line.endTime - 200, text: "伴唱", isBG: true,
  }]);
  await render(page, { lines: source, audioPlaybackState: "playing" });
  const result = await page.evaluate(async () => {
    const host = document.querySelector<HTMLElement>(".baka-lyric-host")!;
    const heights = [host.clientHeight];
    for (const time of [35500, 39500, 55500, 62000]) {
      window.lyricsFixture.time(time, true);
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      heights.push(host.clientHeight);
    }
    const background = [...host.querySelectorAll<HTMLElement>("[class*=bgWrapper]")];
    return { heights, pointerEvents: background.map((element) => getComputedStyle(element).pointerEvents) };
  });
  expect(new Set(result.heights).size).toBe(1);
  expect(result.pointerEvents.length).toBeGreaterThan(0);
  expect(result.pointerEvents.every((value) => value === "none")).toBe(true);
});
