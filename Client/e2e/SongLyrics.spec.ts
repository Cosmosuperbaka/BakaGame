import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/Isolation";
import type { SongClipSelectorFixtureProps, SongLyricsFixtureProps } from "./fixtures/SongLyrics";
import type { SongLyricLine } from "@bakagame/shared";

declare global {
  interface Window {
    lyricsFixture: {
      render(props: SongLyricsFixtureProps): void;
      renderSelector(props: SongClipSelectorFixtureProps): void;
      time(ms: number, playing: boolean): void;
      updates(): number;
      picks(): number[];
    };
  }
}

const lines: SongLyricLine[] = Array.from({ length: 8 }, (_, index) => ({
  time: 35000 + index * 4000,
  endTime: 39000 + index * 4000,
  text: `夜空に浮かぶ星たち 静寂を切り裂いていく ${index + 1}`,
  translatedLyric: "浮现在夜空中的群星点点 将这无尽的寂静一点点撕裂开来",
}));

const selectorLines: SongLyricLine[] = lines.map((line, index) => {
  const translated = index % 3 !== 1;
  return {
    ...line,
    text: `${line.text}，即使为了选取显示更长的正文也不移动`,
    translatedLyric: translated ? line.translatedLyric : "",
    romanLyric: translated
      ? ""
      : "yo zo ra ni u ka bu ho shi ta chi shi ji ma wo ki ri sa i te i ku",
    words:
      index % 2 === 0
        ? [
            {
              startTime: line.time,
              endTime: line.time + 1800,
              word: "夜空に浮かぶ",
              romanWord: translated ? "" : "yo zo ra ni u ka bu",
            },
            {
              startTime: line.time + 1800,
              endTime: line.endTime,
              word: "星たち",
              romanWord: translated ? "" : "ho shi ta chi",
            },
          ]
        : undefined,
  };
});

async function render(page: Page, props: SongLyricsFixtureProps) {
  await page.evaluate((props) => window.lyricsFixture.render(props), props);
  await expect(page.locator(".baka-lyric-host")).toHaveAttribute("data-ready", "true");
}

async function renderSelector(page: Page, props: SongClipSelectorFixtureProps) {
  await page.evaluate((props) => window.lyricsFixture.renderSelector(props), props);
  await expect(page.locator(".baka-clip-lyric-host")).toHaveAttribute("data-ready", "true");
}

async function expectOverviewFits(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const host = document.querySelector<HTMLElement>(".baka-lyric-host")!;
        const groups = [...host.querySelectorAll<HTMLElement>("[class*=lyricLineWrapper]")];
        const box = host.getBoundingClientRect();
        const top = groups[0].getBoundingClientRect().top - box.top;
        const bottom = box.bottom - groups.at(-1)!.getBoundingClientRect().bottom;
        return Math.abs(top) < 1 && bottom >= -1 && bottom < 2;
      })
    )
    .toBe(true);
  const gap = await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>(".baka-lyric-host")!;
    const groups = [...host.querySelectorAll<HTMLElement>("[class*=lyricLineWrapper]")];
    return host.getBoundingClientRect().bottom - groups.at(-1)!.getBoundingClientRect().bottom;
  });
  expect(gap).toBeGreaterThanOrEqual(-1);
  expect(gap).toBeLessThan(2);
}

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
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
      lines.map((line) => ({
        ...line,
        translatedLyric: "",
        romanLyric: "yo zo ra ni u ka bu ho shi ta chi shi ji ma wo ki ri sa i te i ku",
      })),
      lines.map((line) => ({
        ...line,
        translatedLyric: "",
        words: [
          {
            startTime: line.time,
            endTime: line.time + 2000,
            word: "夜空に浮かぶ",
            romanWord: "yo zo ra ni u ka bu",
          },
          {
            startTime: line.time + 2000,
            endTime: line.endTime,
            word: "星たち",
            romanWord: "ho shi ta chi",
          },
        ],
      })),
      lines.flatMap((line) => [
        line,
        {
          ...line,
          time: line.time + 200,
          endTime: line.endTime - 200,
          text: "和声が遠くまで響き続ける",
          isBG: true,
        },
      ]),
      lines.map((line, index) => ({ ...line, isDuet: index % 2 === 1 })),
    ]) {
      await render(page, { lines: variant, audioPlaybackState: "completed" });
      await expectOverviewFits(page);
    }
    // 首次测量结束之后再改变字号，必须仍能响应，不得锁死旧高度。
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "24px";
    });
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
    const read = () => ({
      y: last.getBoundingClientRect().y,
      height: host.clientHeight,
      scale: new DOMMatrix(getComputedStyle(player).transform).a,
    });
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
  expect(
    result.frames.filter((frame) => frame.scale > 0.921 && frame.scale < 0.999).length
  ).toBeGreaterThan(3);
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
      if (host.dataset.ready)
        frames.push(host.querySelector("[class*=lyricLineWrapper]")!.getBoundingClientRect().y);
    }
    const original = host.querySelector("[class*=lyricLineWrapper]");
    window.lyricsFixture.render({ lines: structuredClone(lines), audioStatus: "ready" });
    return { frames, same: original === host.querySelector("[class*=lyricLineWrapper]") };
  }, lines);
  expect(result.same).toBe(true);
  expect(result.frames.length).toBeGreaterThan(5);
  expect(Math.max(...result.frames) - Math.min(...result.frames)).toBeLessThan(1);
  await render(page, {
    lines: [{ ...lines[0], words: [{ startTime: 35000, endTime: 39000, word: "変更前" }] }],
  });
  await render(page, {
    lines: [{ ...lines[0], words: [{ startTime: 35000, endTime: 39000, word: "変更後" }] }],
  });
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
  expect(
    await page.locator(".baka-lyric-player").evaluate((element) => element.getAnimations().length)
  ).toBe(0);
});

test("和声活动切换不改变外壳高度，也不接管页面滚动", async ({ page }) => {
  const source = lines.flatMap((line) => [
    line,
    {
      ...line,
      time: line.time + 200,
      endTime: line.endTime - 200,
      text: "伴唱",
      isBG: true,
    },
  ]);
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
    return {
      heights,
      pointerEvents: background.map((element) => getComputedStyle(element).pointerEvents),
    };
  });
  expect(new Set(result.heights).size).toBe(1);
  expect(result.pointerEvents.length).toBeGreaterThan(0);
  expect(result.pointerEvents.every((value) => value === "none")).toBe(true);
});

test("暂停保留弹簧收敛但降低更新频率，重播恢复逐帧", async ({ page }) => {
  await render(page, { lines, audioPlaybackState: "playing" });
  await page.evaluate(() => window.lyricsFixture.time(38900, true));
  const countUpdates = () =>
    page.evaluate(async () => {
      const before = window.lyricsFixture.updates();
      await new Promise((resolve) => setTimeout(resolve, 700));
      return window.lyricsFixture.updates() - before;
    });
  const playing = await countUpdates();
  // 正常跨入下一句后立即暂停：必须继续推进尚未落定的原生布局，不能一刀停 update。
  const motion = await page.evaluate(async () => {
    const last = document
      .querySelector<HTMLElement>(".baka-lyric-host")!
      .querySelectorAll<HTMLElement>("[class*=lyricLineWrapper]")
      .item(1);
    const y = () => last.getBoundingClientRect().y;
    window.lyricsFixture.time(39050, true);
    await new Promise(requestAnimationFrame);
    window.lyricsFixture.time(39050, false);
    window.lyricsFixture.render({ audioPlaybackState: "paused" });
    const start = y();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const middle = y();
    await new Promise((resolve) => setTimeout(resolve, 1400));
    const end = y();
    await new Promise((resolve) => setTimeout(resolve, 250));
    return { start, middle, end, stable: y() };
  });
  const paused = await countUpdates();
  console.log(JSON.stringify({ playing, paused, motion }));
  expect(Math.abs(motion.middle - motion.start)).toBeGreaterThan(1);
  expect(Math.abs(motion.stable - motion.end)).toBeLessThan(1);
  expect(playing).toBeGreaterThan(10);
  expect(paused).toBeGreaterThan(0);
  expect(paused).toBeLessThan(playing * 0.8);
  await page.evaluate(() => {
    window.lyricsFixture.render({ audioPlaybackState: "playing" });
    window.lyricsFixture.time(35500, true);
  });
  const replay = await countUpdates();
  expect(replay).toBeGreaterThan(paused * 1.25);
  await render(page, { audioPlaybackState: "completed" });
  await expectOverviewFits(page);
  await page.setViewportSize({ width: 390, height: 900 });
  await expectOverviewFits(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expectOverviewFits(page);
  await test.info().attach("update-counts", {
    body: JSON.stringify({ playing, paused, replay, sampleMs: 700, motion }),
    contentType: "application/json",
  });
});

test("截取选择器只推进逐字遮罩，不移动行盒、重建节点或改变滚动位置", async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 900 });
  await renderSelector(page, {
    lines: selectorLines,
    range: [35000, 59000],
    anchorIndex: 0,
  });
  const result = await page.evaluate(async (source) => {
    const settle = async () => {
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    };
    const host = document.querySelector<HTMLElement>(".baka-clip-lyric-host")!;
    const scroller = host.parentElement!;
    const rows = [...host.querySelectorAll<HTMLElement>("[data-line-index]")];
    scroller.scrollTop = Math.min(96, scroller.scrollHeight - scroller.clientHeight);
    window.lyricsFixture.renderSelector({ lines: structuredClone(source) });
    const read = () => ({
      rects: rows.map((row) => {
        const { x, y, width, height } = row.getBoundingClientRect();
        return { x, y, width, height };
      }),
      sameNodes: rows.every(
        (row, index) => row === host.querySelectorAll("[data-line-index]")[index]
      ),
      scrollTop: scroller.scrollTop,
      scrollable: scroller.scrollHeight > scroller.clientHeight,
      overflow: [host, scroller].some((element) => element.scrollWidth > element.clientWidth + 1),
    });
    const readMask = () => {
      const elements = [rows[0]!, ...rows[0]!.querySelectorAll<HTMLElement>("*")];
      const animations = elements.flatMap((element) =>
        element
          .getAnimations()
          .filter((animation) => animation.id.startsWith("fade-word"))
          .map((animation) => ({ element, animation }))
      );
      return {
        count: animations.length,
        times: animations.map(({ animation }) => Number(animation.currentTime)),
        states: animations.map(({ animation }) => animation.playState),
        positions: animations.map(({ element }) => getComputedStyle(element).maskPosition),
      };
    };

    window.lyricsFixture.time(35500, false);
    await settle();
    const before = read();
    const maskBefore = readMask();
    window.lyricsFixture.time(37500, false);
    await settle();
    const maskAfter = readMask();
    const afterSeek = read();
    window.lyricsFixture.time(41000, true);
    await settle();
    window.lyricsFixture.time(59000, true);
    await settle();
    const afterPlaying = read();
    window.lyricsFixture.time(35500, false);
    await settle();
    const afterPause = read();
    const plainMasks = rows
      .filter((row) => row.dataset.wordTimed === "false")
      .flatMap((row) => [row, ...row.querySelectorAll<HTMLElement>("*")])
      .flatMap((element) => {
        const style = getComputedStyle(element);
        return [style.maskImage, style.webkitMaskImage];
      });
    return { before, afterSeek, afterPlaying, afterPause, maskBefore, maskAfter, plainMasks };
  }, selectorLines);

  expect(result.before.scrollable).toBe(true);
  expect(result.before.scrollTop).toBeGreaterThan(0);
  expect(result.maskBefore.count).toBeGreaterThan(0);
  expect(result.maskBefore.states).toEqual(result.maskBefore.states.map(() => "paused"));
  expect(result.maskAfter.states).toEqual(result.maskAfter.states.map(() => "paused"));
  expect(new Set(result.maskBefore.times).size).toBe(1);
  expect(new Set(result.maskAfter.times).size).toBe(1);
  expect(result.maskAfter.times[0]! - result.maskBefore.times[0]!).toBe(2000);
  expect(result.maskAfter.positions).not.toEqual(result.maskBefore.positions);
  expect(result.plainMasks.length).toBeGreaterThan(0);
  expect(result.plainMasks.every((value) => value === "none")).toBe(true);
  for (const snapshot of [result.afterSeek, result.afterPlaying, result.afterPause]) {
    expect(snapshot.sameNodes).toBe(true);
    expect(snapshot.scrollTop).toBe(result.before.scrollTop);
    expect(snapshot.overflow).toBe(false);
    snapshot.rects.forEach((rect, index) => {
      const before = result.before.rects[index]!;
      expect(rect.x).toBeCloseTo(before.x, 5);
      expect(rect.y).toBeCloseTo(before.y, 5);
      expect(rect.width).toBeCloseTo(before.width, 5);
      expect(rect.height).toBeCloseTo(before.height, 5);
    });
  }
  await render(page, { lines, audioPlaybackState: "idle" });
  await expect(page.locator(".baka-clip-lyric-host")).toHaveCount(0);
});

for (const width of [390, 820, 1280]) {
  test(`${width}px 截取选择器的长句、副行与和声不重叠且始终静止`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: width === 820 ? "reduce" : "no-preference" });
    const harmony = selectorLines.flatMap((line) => [
      { ...line, isBG: false },
      {
        ...line,
        time: line.time + 200,
        endTime: line.endTime - 200,
        text: "和声が遠くまで響き続ける",
        translatedLyric: "",
        romanLyric: "",
        isBG: true,
      },
    ]);
    const consecutiveHarmony = harmony.flatMap((line) => [
      line,
      ...(line.isBG
        ? [
            {
              ...line,
              time: line.time + 200,
              endTime: line.endTime - 200,
              text: "第二和声も同じ行順で選べる",
            },
          ]
        : []),
    ]);
    for (const variant of [
      selectorLines,
      selectorLines.map((line) => ({ ...line, words: undefined })),
      harmony,
      consecutiveHarmony,
    ]) {
      await renderSelector(page, { lines: variant, range: [35000, 67000], anchorIndex: null });
      const result = await page.evaluate(async () => {
        const host = document.querySelector<HTMLElement>(".baka-clip-lyric-host")!;
        const rows = [...host.querySelectorAll<HTMLElement>("[data-line-index]")];
        const read = () =>
          rows.map((row) => {
            const { x, y, width, height } = row.getBoundingClientRect();
            return { x, y, width, height };
          });
        window.lyricsFixture.time(45000, false);
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        const before = read();
        window.lyricsFixture.time(61000, true);
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        const after = read();
        const separated = rows.every((row, index) => {
          if (index === 0) return true;
          return (
            row.getBoundingClientRect().top >= rows[index - 1]!.getBoundingClientRect().bottom - 1
          );
        });
        const sublinesFit = rows.every((row) => {
          const visible = [
            row.querySelector<HTMLElement>("[class*=lyricMainLine]"),
            ...row.querySelectorAll<HTMLElement>("[class*=lyricSubLine]"),
          ].filter((element): element is HTMLElement => Boolean(element?.textContent));
          const textBoxes = visible.map((element) => {
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            const rects: DOMRect[] = [];
            while (walker.nextNode()) {
              if (!walker.currentNode.textContent?.trim()) continue;
              const range = document.createRange();
              range.selectNodeContents(walker.currentNode);
              rects.push(...range.getClientRects());
            }
            return {
              top: Math.min(...rects.map((rect) => rect.top)),
              bottom: Math.max(...rects.map((rect) => rect.bottom)),
            };
          });
          return textBoxes.every(
            (box, index) => index === 0 || box.top >= textBoxes[index - 1]!.bottom - 1
          );
        });
        return {
          before,
          after,
          separated,
          sublinesFit,
          labels: rows.map(
            (row) => [Number(row.dataset.lineIndex), row.getAttribute("aria-label")] as const
          ),
          overflow: [host, host.parentElement!].some(
            (element) => element.scrollWidth > element.clientWidth + 1
          ),
        };
      });
      expect(result.separated).toBe(true);
      expect(result.sublinesFit).toBe(true);
      expect(result.labels.map(([index]) => index)).toEqual(variant.map((_, index) => index));
      for (const [index, label] of result.labels) {
        expect(label?.endsWith(variant[index]!.text)).toBe(true);
      }
      expect(result.overflow).toBe(false);
      expect(result.after).toEqual(result.before);
    }
  });
}

test("截取选择器的点击、回车与空格提交原始索引并同步选中状态", async ({ page }) => {
  await renderSelector(page, {
    lines: selectorLines,
    range: [35000, 43000],
    anchorIndex: 0,
  });
  await page.getByRole("button", { name: `0:39.0 ${selectorLines[1]!.text}` }).click();
  const enter = page.getByRole("button", { name: `0:43.0 ${selectorLines[2]!.text}` });
  await enter.focus();
  await page.keyboard.press("Enter");
  const space = page.getByRole("button", { name: `0:47.0 ${selectorLines[3]!.text}` });
  await space.focus();
  await page.keyboard.press("Space");
  expect(await page.evaluate(() => window.lyricsFixture.picks())).toEqual([1, 2, 3]);

  await renderSelector(page, { range: [51000, 59000], anchorIndex: 2 });
  await expect(page.locator('[data-line-index="2"]')).toHaveAttribute("data-anchor", "true");
  for (const index of [4, 5])
    await expect(page.locator(`[data-line-index="${index}"]`)).toHaveAttribute(
      "data-selected",
      "true"
    );
  for (const index of [3, 6])
    await expect(page.locator(`[data-line-index="${index}"]`)).not.toHaveAttribute("data-selected");
});
