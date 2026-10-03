import { LyricPlayer } from "@applemusic-like-lyrics/core";
import equal from "fast-deep-equal";
import type { SongLyricLine } from "@/types";
import { lyricOverview } from "@/lib/Motion";
import { toAMLLLines } from "./SongLyricLines";

type Playback = "idle" | "playing" | "paused" | "completed";
type AudioStatus = "loading" | "ready" | "error";

/** 原生生命周期：https://amll.dev/guides/component/sequence */
export class SongLyricScene {
  private readonly player = new LyricPlayer();
  private readonly element = this.player.getElement();
  private readonly observer: ResizeObserver;
  private readonly reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  private lines: SongLyricLine[] = [];
  private audio: HTMLAudioElement | null = null;
  private playback: Playback = "idle";
  private audioStatus: AudioStatus = "ready";
  private overview = false;
  private ready = false;
  private fontsReady = false;
  private disposed = false;
  private frame = 0;
  private pausedTimer: number | null = null;
  private lastFrame: number | null = null;
  private animations: Animation[] = [];
  private readonly host: HTMLElement;

  constructor(host: HTMLElement) {
    this.host = host;
    this.element.classList.add("baka-lyric-player");
    this.element.style.height = "0px";
    this.host.append(this.element);
    // 题目是有限歌词片段：全量挂载，不能让视口裁剪决定哪些行可测量。
    this.player.setOverscanPx(0x7fffffff);
    this.player.setEnableScale(false);
    this.player.pause();
    this.observer = new ResizeObserver(this.measure);
    this.observer.observe(host);
    this.observer.observe(this.element);
    document.fonts?.addEventListener("loadingdone", this.measure);
    this.reducedMotion.addEventListener("change", this.onMotionChange);
  }

  setSource(lines: SongLyricLine[], audio: HTMLAudioElement | null) {
    if (audio !== this.audio) {
      this.listenAudio(false);
      this.audio = audio;
      this.listenAudio(true);
    }
    if (equal(this.lines, lines)) return;
    this.cancelTick();
    this.cancelAnimations();
    this.ready = false;
    this.fontsReady = false;
    delete this.host.dataset.ready;
    this.observer.disconnect();
    this.observer.observe(this.host);
    this.observer.observe(this.element);
    this.lines = structuredClone(lines);
    this.player.setLyricLines(toAMLLLines(lines), this.initialTime());
    for (const group of this.player.currentLyricGroups) {
      group.show();
      this.observer.observe(group.element);
    }
    this.measure();
    this.scheduleFrame();
    // 先挂载并触发布局，才会请求本段文字对应的字体分片。
    const source = this.lines;
    void (document.fonts?.ready ?? Promise.resolve()).then(() => {
      if (this.disposed || this.lines !== source) return;
      this.fontsReady = true;
      this.measure();
    });
  }

  setPlayback(playback: Playback, status: AudioStatus) {
    this.playback = playback;
    this.audioStatus = status;
    this.syncAudio();
    const overview = playback === "completed";
    if (overview !== this.overview) this.setOverview(overview);
    else if (!this.ready) this.align(true);
  }

  private initialTime() {
    const firstTime = this.lines[0]?.time ?? 0;
    const audioTime = Math.floor((this.audio?.currentTime ?? 0) * 1000);
    return this.audio && this.playback !== "idle"
      && audioTime >= Math.max(0, firstTime - 3000) && this.audioStatus === "ready"
      ? audioTime : firstTime;
  }

  private syncAudio = () => {
    const playing = this.playback === "playing" && this.audioStatus === "ready"
      && this.audio !== null && !this.audio.paused && !this.audio.ended;
    if (playing !== this.player.getIsPlaying()) {
      if (playing) this.player.resume();
      else this.player.pause();
      // 媒体恢复时取消低频等待，下一显示帧立即接回逐帧同步。
      this.cancelTick();
      this.scheduleFrame();
    }
    // pause/ended 只停表，绝不能先倒回首句、下一次提交才进入总览。
    if (playing && !this.overview) this.player.setCurrentTime(this.initialTime());
  };

  private listenAudio(add: boolean) {
    for (const event of ["play", "pause", "ended", "timeupdate", "seeked"]) {
      if (add) this.audio?.addEventListener(event, this.syncAudio);
      else this.audio?.removeEventListener(event, this.syncAudio);
    }
  }

  private align(force: boolean) {
    this.player.setAlignAnchor(this.overview ? "top" : "center");
    this.player.setAlignPosition(this.overview ? 0 : lyricOverview.scale / 2);
    this.player.setCurrentTime(this.overview ? (this.lines[0]?.time ?? 0) : this.initialTime(), true);
    void this.player.calcLayout(true, force);
    this.player.update(0);
  }

  private setOverview(overview: boolean) {
    const elements = [this.element, ...this.player.currentLyricGroups.map((group) => group.element)];
    // 从屏幕上当前真正显示的位置取起点，快速重播也能接住尚未结束的过渡。
    const from = elements.map((element) => getComputedStyle(element).transform);
    this.cancelAnimations();
    this.overview = overview;
    this.element.classList.toggle("baka-overview-mode", overview);
    this.element.style.transform = overview ? `scale(${lyricOverview.scale})` : "none";
    this.player.setEnableBlur(!overview);
    this.align(true);
    if (!this.ready || this.reducedMotion.matches) return;
    this.animations = elements.map((element, index) => element.animate(
      [{ transform: from[index] }, { transform: getComputedStyle(element).transform }],
      lyricOverview.timing,
    ));
    // 不持有填充态：结束后归还原生布局，避免覆盖后续歌词滚动。
    for (const animation of this.animations) animation.onfinish = () => animation.cancel();
  }

  private cancelAnimations() {
    for (const animation of this.animations) animation.cancel();
    this.animations = [];
  }

  private onMotionChange = () => {
    if (this.reducedMotion.matches) {
      this.cancelAnimations();
      this.align(true);
    }
  };

  private measure = () => {
    if (this.disposed || !this.lines.length || this.host.clientWidth === 0) return;
    const groups = this.player.currentLyricGroups;
    // 与内核 ResizeObserver 使用同一 clientHeight（包含翻译、注音、和声及折行）。
    // CSS 保证背景行始终占位且关闭 content-visibility 占位尺寸。
    const height = groups.reduce((total, group) => total + group.element.clientHeight, 0);
    if (height === 0) return;
    this.element.style.height = `${height}px`;
    this.host.style.height = `${Math.ceil(height * lyricOverview.scale)}px`;
    // 必须等内核读到相同的盒模型，再将首帧交给用户；不按固定帧数猜测就绪。
    const measured = this.player.size[1] === height && groups.every((group) =>
      this.player.lyricGroupSize.get(group)?.[1] === group.element.clientHeight);
    if (!this.ready && this.fontsReady && measured) {
      this.align(true);
      this.ready = true;
      this.host.dataset.ready = "true";
    }
  };

  private scheduleFrame() {
    if (this.disposed || !this.lines.length || this.frame || this.pausedTimer !== null) return;
    if (this.player.getIsPlaying()) {
      this.frame = requestAnimationFrame(this.tick);
    } else {
      // pause 仍有布局弹簧，不能停 update 或猜一个“已收敛”时长。
      // 非播放状态最多 30 次/秒；仍交给 RAF 绘制，隐藏页面不会靠定时器持续更新。
      this.pausedTimer = window.setTimeout(() => {
        this.pausedTimer = null;
        this.frame = requestAnimationFrame(this.tick);
      }, 1000 / 30);
    }
  }

  private cancelTick() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    if (this.pausedTimer !== null) window.clearTimeout(this.pausedTimer);
    this.pausedTimer = null;
    this.lastFrame = null;
  }

  private tick = (time: number) => {
    this.frame = 0;
    if (this.disposed) return;
    this.syncAudio();
    this.player.update(this.lastFrame === null ? 0 : time - this.lastFrame);
    this.lastFrame = time;
    this.scheduleFrame();
  };

  dispose() {
    this.disposed = true;
    this.cancelTick();
    this.cancelAnimations();
    this.listenAudio(false);
    this.observer.disconnect();
    document.fonts?.removeEventListener("loadingdone", this.measure);
    this.reducedMotion.removeEventListener("change", this.onMotionChange);
    this.player.dispose();
  }
}
