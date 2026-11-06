import { LyricPlayer } from "@applemusic-like-lyrics/core";
import equal from "fast-deep-equal";
import type { SongLyricLine } from "@bakagame/shared";
import { isLyricLineInClip } from "@bakagame/shared/values";
import { formatClipTime } from "./SongClipEditing";
import { isMediaClockRunning, MEDIA_CLOCK_EVENTS, toAMLLLines } from "./lyrics/SongLyricLines";

interface SelectorRow {
  element: HTMLElement;
  line: SongLyricLine;
}

/** 选段相对可视区的位置；有一部分在视野内时为 null。 */
export type SelectionPlacement = "above" | "below" | null;

/** 选区离可视区边缘多远才算看不见，避开上下的淡出边。 */
const PLACEMENT_MARGIN_PX = 12;

/**
 * 内核把滚轮与触摸处理器挂在播放器根节点上，并在里面 `preventDefault`。选取页的行要接管
 * 指针，事件冒泡到根节点就把外层列表的原生滚动拦掉了，所以在内核层关掉它自己的滚动。
 */
class SelectorLyricPlayer extends LyricPlayer {
  constructor() {
    super();
    this.scrollState.allowScroll = false;
  }
}

/** 玩家亲手动列表的入口：程序滚动不会触发这些事件。 */
const USER_SCROLL_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

const setFlag = (element: HTMLElement, name: string, on: boolean) => {
  if (on) element.dataset[name] = "true";
  else delete element.dataset[name];
};

const rangeMark = (index: number, first?: number, last?: number) => {
  if (index === first) return index === last ? "起止" : "起";
  return index === last ? "止" : "";
};

export class SongClipLyricScene {
  private readonly player = new SelectorLyricPlayer();
  private readonly element = this.player.getElement();
  private readonly observer: ResizeObserver;
  private readonly rows = new Map<number, SelectorRow>();
  private lines: SongLyricLine[] = [];
  private audio: HTMLAudioElement | null = null;
  private playing = false;
  private range: readonly [number, number] = [0, 0];
  private anchorIndex: number | null = null;
  private fontsReady = false;
  private ready = false;
  private disposed = false;
  private frame = 0;
  private lastFrame: number | null = null;
  private readonly host: HTMLElement;
  private readonly scroller: HTMLElement | null;
  /** 列表唯一的 Tab 停靠行；玩家没聚焦过时跟着选段走。 */
  private rovingIndex: number | null = null;
  private placement: SelectionPlacement = null;
  /** 排版落定前选段都要留在视野里；玩家动过列表或选段后就不再替他滚动。 */
  private anchored = true;
  private measuredHeight = 0;
  /** 选段滚出或滚回可视区时通知，用来显示「回到选段」。 */
  onPlacement?: (placement: SelectionPlacement) => void;

  constructor(host: HTMLElement) {
    this.host = host;
    this.scroller = host.parentElement;
    this.scroller?.addEventListener("scroll", this.syncPlacement, { passive: true });
    for (const event of USER_SCROLL_EVENTS) {
      this.scroller?.addEventListener(event, this.releaseAnchor, { passive: true });
    }
    this.element.classList.add("baka-lyric-player", "baka-clip-lyric-sheet");
    this.element.style.height = "auto";
    this.host.append(this.element);
    this.player.setOverscanPx(0x7fffffff);
    this.player.setEnableScale(false);
    this.player.setEnableBlur(false);
    this.player.pause();
    this.observer = new ResizeObserver(this.measure);
    this.observer.observe(host);
    this.observer.observe(this.element);
    document.fonts?.addEventListener("loadingdone", this.measure);
  }

  setSource(lines: SongLyricLine[], audio: HTMLAudioElement | null) {
    if (audio !== this.audio) {
      this.listenAudio(false);
      this.audio = audio;
      this.listenAudio(true);
    }
    if (equal(this.lines, lines)) return;
    this.cancelTick();
    this.rows.clear();
    this.rovingIndex = null;
    this.anchored = true;
    this.ready = false;
    this.fontsReady = false;
    delete this.host.dataset.ready;
    this.observer.disconnect();
    this.observer.observe(this.host);
    this.observer.observe(this.element);
    this.lines = structuredClone(lines);
    this.player.setLyricLines(toAMLLLines(this.lines), this.mediaTime());
    for (const group of this.player.currentLyricGroups) {
      group.show();
      this.observer.observe(group.element);
    }
    this.buildRows();
    this.applySelection();
    this.syncTime(true);
    void this.player.calcLayout(true, true);
    this.player.update(0);
    this.measure();
    const source = this.lines;
    void (document.fonts?.ready ?? Promise.resolve()).then(() => {
      if (this.disposed || this.lines !== source) return;
      this.fontsReady = true;
      this.measure();
    });
    this.syncPlayback();
  }

  setPlayback(playing: boolean) {
    this.playing = playing;
    this.syncPlayback();
  }

  setSelection(range: readonly [number, number], anchorIndex: number | null) {
    if (this.ready && (range[0] !== this.range[0] || range[1] !== this.range[1])) {
      this.releaseAnchor();
    }
    this.range = range;
    this.anchorIndex = anchorIndex;
    this.applySelection();
  }

  setRovingRow(index: number) {
    this.rovingIndex = index;
    this.applyRoving();
  }

  focusRow(move: "next" | "previous" | "first" | "last", from: number) {
    const order = [...this.rows.keys()];
    const position = order.indexOf(from);
    const target =
      move === "first"
        ? 0
        : move === "last"
          ? order.length - 1
          : position + (move === "next" ? 1 : -1);
    const index = order[target];
    if (index !== undefined) this.rows.get(index)?.element.focus();
  }

  /** 玩家按下「回到选段」或首次排版时调用；播放与改选段都不会主动滚动列表。 */
  revealSelection(smooth = true) {
    const scroller = this.scroller;
    const first = this.selectedRows()[0];
    if (!scroller || !first) return;
    const offset =
      first.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top -
      PLACEMENT_MARGIN_PX;
    const motionless = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    scroller.scrollTo({
      top: Math.max(0, scroller.scrollTop + offset),
      behavior: smooth && !motionless ? "smooth" : "auto",
    });
    if (smooth) first.focus({ preventScroll: true });
  }

  private releaseAnchor = () => {
    this.anchored = false;
  };

  private selectedRows() {
    return [...this.rows.values()]
      .map((row) => row.element)
      .filter((element) => element.dataset.selected);
  }

  private syncPlacement = () => {
    const placement = this.readPlacement();
    if (placement === this.placement) return;
    this.placement = placement;
    this.onPlacement?.(placement);
  };

  private readPlacement(): SelectionPlacement {
    const scroller = this.scroller;
    const rows = this.selectedRows();
    if (!this.ready || !scroller || scroller.clientHeight === 0 || rows.length === 0) return null;
    const view = scroller.getBoundingClientRect();
    if (rows[0]!.getBoundingClientRect().top > view.bottom - PLACEMENT_MARGIN_PX) return "below";
    if (rows.at(-1)!.getBoundingClientRect().bottom < view.top + PLACEMENT_MARGIN_PX)
      return "above";
    return null;
  }

  private applyRoving() {
    const fallback = [...this.rows].find(([, row]) => row.element.dataset.selected)?.[0];
    const current = this.rovingIndex ?? fallback ?? this.rows.keys().next().value;
    for (const [index, { element }] of this.rows) element.tabIndex = index === current ? 0 : -1;
  }

  private mediaTime() {
    return Math.max(0, (this.audio?.currentTime ?? 0) * 1_000);
  }

  private buildRows() {
    let sourceIndex = 0;
    // 内核保持行序，但连续和声的第二行会成为下一组主行，不能按原始 isBG 跳行。
    for (const group of this.player.currentLyricGroups) {
      this.registerRow(sourceIndex++, group.mainLine.getElement());
      if (group.bgLine) this.registerRow(sourceIndex++, group.bgLine.getElement());
    }
  }

  private registerRow(index: number, element: HTMLElement) {
    const line = this.lines[index];
    if (!line) return;
    const time = formatClipTime(line.time);
    element.classList.add("baka-clip-lyric-line");
    element.dataset.lineIndex = String(index);
    element.dataset.wordTimed = line.words?.length ? "true" : "false";
    element.dataset.time = time;
    element.tabIndex = -1;
    element.setAttribute("role", "button");
    element.setAttribute("aria-label", `${time} ${line.text}`);
    this.rows.set(index, { element, line });
  }

  private applySelection() {
    const [startTime, endTime] = this.range;
    const inClip = [...this.rows.keys()].filter((index) =>
      isLyricLineInClip(this.rows.get(index)!.line, startTime, endTime)
    );
    const first = inClip[0];
    const last = inClip.at(-1);
    for (const [index, { element }] of this.rows) {
      const selected = inClip.includes(index);
      element.setAttribute("aria-pressed", String(selected));
      setFlag(element, "selected", selected);
      setFlag(element, "anchor", index === this.anchorIndex);
      setFlag(element, "first", index === first);
      setFlag(element, "last", index === last);
      const mark = index === this.anchorIndex ? "已点" : rangeMark(index, first, last);
      if (mark) element.dataset.mark = mark;
      else delete element.dataset.mark;
    }
    this.applyRoving();
    this.syncPlacement();
  }

  private syncPlayback = () => {
    const playing = Boolean(
      this.playing && this.audio && isMediaClockRunning(this.audio) && this.lines.length
    );
    const changed = playing !== this.player.getIsPlaying();
    if (changed) {
      if (playing) this.player.resume();
      else this.player.pause();
    }
    this.syncTime(changed || !playing);
    this.player.update(0);
    if (playing) this.scheduleFrame();
    else this.cancelTick();
  };

  private syncTime(seek: boolean) {
    const time = this.mediaTime();
    this.player.setCurrentTime(time, seek);
    for (const { element, line } of this.rows.values()) {
      if (time >= line.time && time < line.endTime) element.dataset.active = "true";
      else delete element.dataset.active;
    }
  }

  private listenAudio(add: boolean) {
    for (const event of MEDIA_CLOCK_EVENTS) {
      if (add) this.audio?.addEventListener(event, this.syncPlayback);
      else this.audio?.removeEventListener(event, this.syncPlayback);
    }
  }

  private measure = () => {
    if (this.disposed || !this.lines.length || this.host.clientWidth === 0) return;
    const groups = this.player.currentLyricGroups;
    const height = groups.reduce((total, group) => total + group.element.clientHeight, 0);
    if (height === 0) return;
    this.element.style.height = `${height}px`;
    // 字体与折行落定、窗口变窄都会改行高；选段不能因此被挤出视野。
    if (this.ready && this.anchored && height !== this.measuredHeight) this.revealSelection(false);
    this.measuredHeight = height;
    const measured =
      this.player.size[1] === height &&
      groups.every(
        (group) => this.player.lyricGroupSize.get(group)?.[1] === group.element.clientHeight
      );
    if (this.ready || !this.fontsReady || !measured) return;
    void this.player.calcLayout(true, true);
    this.syncTime(true);
    this.player.update(0);
    this.ready = true;
    this.host.dataset.ready = "true";
    this.revealSelection(false);
    this.syncPlacement();
  };

  private scheduleFrame() {
    if (this.disposed || this.frame || !this.lines.length) return;
    this.frame = requestAnimationFrame(this.tick);
  }

  private cancelTick() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.lastFrame = null;
  }

  private tick = (time: number) => {
    this.frame = 0;
    if (this.disposed) return;
    this.syncTime(false);
    this.player.update(this.lastFrame === null ? 0 : time - this.lastFrame);
    this.lastFrame = time;
    this.scheduleFrame();
  };

  dispose() {
    this.disposed = true;
    this.cancelTick();
    this.listenAudio(false);
    this.observer.disconnect();
    this.scroller?.removeEventListener("scroll", this.syncPlacement);
    for (const event of USER_SCROLL_EVENTS) {
      this.scroller?.removeEventListener(event, this.releaseAnchor);
    }
    document.fonts?.removeEventListener("loadingdone", this.measure);
    this.rows.clear();
    this.player.dispose();
  }
}
