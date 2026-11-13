import { LyricPlayer } from "@applemusic-like-lyrics/core";
import equal from "fast-deep-equal";
import type { SongLyricLine } from "@bakagame/shared";
import { lyricOverview } from "@/lib/motion/CssTokens";
import { SongLyricSceneBase } from "./SongLyricSceneBase";
import { isMediaClockRunning, toAMLLLines } from "./SongLyricLines";

type Playback = "idle" | "playing" | "paused" | "completed";
type AudioStatus = "loading" | "ready" | "error";

/** 原生生命周期：https://amll.dev/guides/component/sequence */
export class SongLyricScene extends SongLyricSceneBase {
  private readonly reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  private clipStartTime: number | undefined;
  private playback: Playback = "idle";
  private audioStatus: AudioStatus = "ready";
  private overview = false;
  private pausedTimer: number | null = null;
  private animations: Animation[] = [];
  private switchTimer: number | null = null;
  /** 受视口约束的可见窗口：播放时裁掉超长片段，总览时在这里滚动。 */
  private readonly viewport: HTMLElement | null;
  private alignPosition: number = lyricOverview.scale / 2;
  private overflowing = false;

  constructor(host: HTMLElement) {
    super(new LyricPlayer(), host);
    this.viewport = host.parentElement;
    this.element.classList.add("baka-lyric-player");
    this.element.style.height = "0px";
    this.host.append(this.element);
    // 题目是有限歌词片段：全量挂载，不能让视口裁剪决定哪些行可测量。
    this.player.setOverscanPx(0x7fffffff);
    this.player.setEnableScale(false);
    this.player.pause();
    this.watchLayout();
    if (this.viewport) this.observer.observe(this.viewport);
    this.viewport?.addEventListener("scroll", this.syncEdges, { passive: true });
    this.reducedMotion.addEventListener("change", this.onMotionChange);
  }

  setSource(lines: SongLyricLine[], audio: HTMLAudioElement | null, clipStartTime?: number) {
    this.clipStartTime = clipStartTime;
    this.setAudio(audio);
    if (equal(this.lines, lines)) return;
    this.cancelTick();
    this.cancelAnimations();
    this.ready = false;
    this.fontsReady = false;
    delete this.host.dataset.ready;
    this.rebindObserver([this.viewport]);
    this.lines = structuredClone(lines);
    this.player.setLyricLines(toAMLLLines(lines), this.initialTime());
    for (const group of this.player.currentLyricGroups) {
      group.show();
      this.observer.observe(group.element);
    }
    this.measure();
    this.scheduleFrame();
    this.whenFontsReady();
  }

  setPlayback(playback: Playback, status: AudioStatus) {
    this.playback = playback;
    this.audioStatus = status;
    this.syncMedia();
    const overview = playback === "completed";
    if (overview !== this.overview) this.setOverview(overview);
    else if (!this.ready) this.align(true);
  }

  private initialTime() {
    const firstTime = this.lines[0]?.time ?? 0;
    const audioTime = Math.floor((this.audio?.currentTime ?? 0) * 1000);
    // 「音频时间异常」要按片段起点判：手动片段可以从前奏或间奏起播，离首句多远都是正常的；
    // 拿首句当基准会把时间轴锁在首句，遮罩在前奏里就把首句演完。
    const earliest = Math.min(firstTime, this.clipStartTime ?? firstTime);
    return this.audio &&
      this.playback !== "idle" &&
      audioTime >= Math.max(0, earliest - 3000) &&
      this.audioStatus === "ready"
      ? audioTime
      : firstTime;
  }

  protected syncMedia(): void {
    const playing =
      this.playback === "playing" &&
      this.audioStatus === "ready" &&
      this.audio !== null &&
      isMediaClockRunning(this.audio);
    const changed = playing !== this.player.getIsPlaying();
    if (changed) {
      if (playing) this.player.resume();
      else this.player.pause();
      // 媒体恢复时取消低频等待，下一显示帧立即接回逐帧同步。
      this.cancelTick();
      this.scheduleFrame();
    }
    // pause/ended 只停表，绝不能先倒回首句、下一次提交才进入总览。
    // 媒体重新走起来时按 seek 提交：重新启用热行，把停摆期间的遮罩对齐到真实媒体时间。
    if (playing && !this.overview) this.player.setCurrentTime(this.initialTime(), changed);
  }

  private align(force: boolean) {
    this.player.setAlignAnchor(this.overview ? "top" : "center");
    this.player.setAlignPosition(this.overview ? 0 : this.alignPosition);
    this.player.setCurrentTime(
      this.overview ? (this.lines[0]?.time ?? 0) : this.initialTime(),
      true
    );
    void this.player.calcLayout(true, force);
    this.player.update(0);
  }

  private setOverview(overview: boolean) {
    const elements = [
      this.element,
      ...this.player.currentLyricGroups.map((group) => group.element),
    ];
    // 从屏幕上当前真正显示的位置取起点，快速重播也能接住尚未结束的过渡。
    const from = elements.map((element) => getComputedStyle(element).transform);
    // 总览被滚动过时，回到播放要把滚动量并进起点，文字才不会跳一下。
    const scrolled = this.viewport?.scrollTop ?? 0;
    if (scrolled > 0) from[0] = `translateY(${-scrolled}px) ${from[0] === "none" ? "" : from[0]}`;
    this.cancelAnimations();
    // 先挂上过渡再切总览：明暗、模糊与逐字遮罩随缩放一起补间（index.css 的 baka-overview-switching），结束后摘掉，不拖慢播放中的逐帧高亮。
    if (this.ready && !this.reducedMotion.matches) {
      this.element.classList.add("baka-overview-switching");
      this.switchTimer = window.setTimeout(
        () => this.endSwitching(),
        lyricOverview.timing.duration
      );
    }
    this.overview = overview;
    this.element.classList.toggle("baka-overview-mode", overview);
    this.element.style.transform = overview ? `scale(${lyricOverview.scale})` : "none";
    this.player.setEnableBlur(!overview);
    this.syncScrollable();
    this.align(true);
    if (!this.ready || this.reducedMotion.matches) return;
    this.animations = elements.map((element, index) =>
      element.animate(
        [{ transform: from[index] }, { transform: getComputedStyle(element).transform }],
        lyricOverview.timing
      )
    );
    // 不持有填充态：结束后归还原生布局，避免覆盖后续歌词滚动。
    for (const animation of this.animations) animation.onfinish = () => animation.cancel();
  }

  private cancelAnimations() {
    for (const animation of this.animations) animation.cancel();
    this.animations = [];
    this.endSwitching();
  }

  private endSwitching() {
    if (this.switchTimer !== null) window.clearTimeout(this.switchTimer);
    this.switchTimer = null;
    this.element.classList.remove("baka-overview-switching");
    this.syncScrollable();
  }

  /**
   * 片段比可见窗口长时，播放的对齐点改到窗口中心，总览改为在窗口内滚动。
   * 上限只写在样式里：这里读实际窗口高度，视口变化由 ResizeObserver 带回。
   */
  private fitViewport(natural: number, shown: number) {
    const viewport = this.viewport;
    if (!viewport) return;
    const inset = this.host.offsetTop;
    this.overflowing = shown > viewport.clientHeight - inset * 2 + 1;
    if (this.overflowing) viewport.dataset.overflowing = "true";
    else delete viewport.dataset.overflowing;
    const alignPosition = this.overflowing
      ? (viewport.clientHeight / 2 - inset) / natural
      : lyricOverview.scale / 2;
    if (alignPosition !== this.alignPosition) {
      this.alignPosition = alignPosition;
      if (!this.overview) this.player.setAlignPosition(alignPosition);
    }
    this.syncScrollable();
  }

  /** 只有总览落定后才开放滚动；过渡途中行盒的位移不能变成滚动范围。 */
  private syncScrollable() {
    const viewport = this.viewport;
    if (!viewport) return;
    const scrollable = this.overview && this.overflowing && this.switchTimer === null;
    if (scrollable) {
      viewport.dataset.scrollable = "true";
      viewport.tabIndex = 0;
      viewport.setAttribute("role", "region");
      viewport.setAttribute("aria-label", "歌词总览");
    } else if (viewport.dataset.scrollable) {
      delete viewport.dataset.scrollable;
      viewport.removeAttribute("tabindex");
      viewport.removeAttribute("role");
      viewport.removeAttribute("aria-label");
    }
    if (!scrollable) viewport.scrollTop = 0;
    this.syncEdges();
  }

  /** 淡出边只留在还有内容的一侧。 */
  private syncEdges = () => {
    const viewport = this.viewport;
    if (!viewport) return;
    const scrollable = viewport.dataset.scrollable === "true";
    const { scrollTop, scrollHeight, clientHeight } = viewport;
    viewport.dataset.atStart = String(scrollable && scrollTop <= 1);
    viewport.dataset.atEnd = String(scrollable && scrollTop + clientHeight >= scrollHeight - 1);
  };

  private onMotionChange = () => {
    if (this.reducedMotion.matches) {
      this.cancelAnimations();
      this.align(true);
    }
  };

  protected measure(): void {
    if (this.disposed || !this.lines.length || this.host.clientWidth === 0) return;
    // CSS 保证背景行始终占位且关闭 content-visibility 占位尺寸。
    const { groups, height } = this.groupsHeight();
    if (height === 0) return;
    const shown = Math.ceil(height * lyricOverview.scale);
    this.element.style.height = `${height}px`;
    this.host.style.height = `${shown}px`;
    this.fitViewport(height, shown);
    // 必须等内核读到相同的盒模型，再将首帧交给用户。
    if (!this.ready && this.fontsReady && this.isLayoutSettled(groups, height)) {
      this.align(true);
      this.ready = true;
      this.host.dataset.ready = "true";
    }
  }

  protected scheduleFrame(): void {
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

  protected override cancelTick(): void {
    super.cancelTick();
    if (this.pausedTimer !== null) window.clearTimeout(this.pausedTimer);
    this.pausedTimer = null;
  }

  protected beforeFrame(): void {
    this.syncMedia();
  }

  override dispose(): void {
    this.cancelAnimations();
    this.viewport?.removeEventListener("scroll", this.syncEdges);
    this.reducedMotion.removeEventListener("change", this.onMotionChange);
    super.dispose();
  }
}
