import { LyricPlayer } from "@applemusic-like-lyrics/core";
import equal from "fast-deep-equal";
import type { SongLyricLine } from "@bakagame/shared";
import { formatClipTime } from "./SongClipEditing";
import { toAMLLLines } from "./lyrics/SongLyricLines";

interface SelectorRow {
  element: HTMLElement;
  line: SongLyricLine;
}

export class SongClipLyricScene {
  private readonly player = new LyricPlayer();
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
  /** 首次排版完成时触发一次；用于把初始选段滚进可见范围，不参与播放中的任何滚动。 */
  onReady?: () => void;

  constructor(host: HTMLElement) {
    this.host = host;
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
    this.range = range;
    this.anchorIndex = anchorIndex;
    this.applySelection();
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
    element.tabIndex = 0;
    element.setAttribute("role", "button");
    element.setAttribute("aria-label", `${time} ${line.text}`);
    this.rows.set(index, { element, line });
  }

  private applySelection() {
    const [startTime, endTime] = this.range;
    for (const [index, { element, line }] of this.rows) {
      const selected = line.time < endTime && line.endTime > startTime;
      if (selected) element.dataset.selected = "true";
      else delete element.dataset.selected;
      if (index === this.anchorIndex) element.dataset.anchor = "true";
      else delete element.dataset.anchor;
    }
  }

  private syncPlayback = () => {
    const playing = Boolean(
      this.playing && this.audio && !this.audio.paused && !this.audio.ended && this.lines.length
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
    for (const event of ["play", "pause", "ended", "timeupdate", "seeked"]) {
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
    this.onReady?.();
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
    document.fonts?.removeEventListener("loadingdone", this.measure);
    this.rows.clear();
    this.player.dispose();
  }
}
