import type { LyricPlayer } from "@applemusic-like-lyrics/core";
import type { SongLyricLine } from "@bakagame/shared";
import { MEDIA_CLOCK_EVENTS } from "./SongLyricLines";

/**
 * 两个歌词场景（播放展示与片段选取）共用的 AMLL 骨架：观察器与字体事件、媒体时钟监听、
 * 字体就绪握手、逐帧循环与销毁。各自的排版测量、状态同步与滚动语义留在子类。
 *
 * 子类的 measure 与 syncMedia 都写成方法：基类的观察器与监听器在回调里才读它们，
 * 所以子类字段初始化先后不影响。
 */
export abstract class AmllSceneBase {
  protected readonly player: LyricPlayer;
  protected readonly element: HTMLElement;
  protected readonly host: HTMLElement;
  protected readonly observer: ResizeObserver;
  protected lines: SongLyricLine[] = [];
  protected audio: HTMLAudioElement | null = null;
  protected fontsReady = false;
  protected ready = false;
  protected disposed = false;
  protected frame = 0;
  protected lastFrame: number | null = null;
  private readonly clockListener = () => this.syncMedia();
  private readonly fontsListener = () => this.measure();

  protected constructor(player: LyricPlayer, host: HTMLElement) {
    this.player = player;
    this.element = player.getElement();
    this.host = host;
    this.observer = new ResizeObserver(() => this.measure());
  }

  /** 排版测量：宿主、歌词根节点或字体变化时调用。 */
  protected abstract measure(): void;
  /** 媒体时钟事件或每帧：把播放状态与时间同步给内核。 */
  protected abstract syncMedia(): void;
  /** 下一帧的调度策略因场景而异。 */
  protected abstract scheduleFrame(): void;
  /** 每帧在驱动内核之前先同步的场景状态。 */
  protected abstract beforeFrame(): void;

  /** 开始观察宿主与歌词根节点，并跟随字体加载完成重新测量。 */
  protected watchLayout(): void {
    this.observer.observe(this.host);
    this.observer.observe(this.element);
    document.fonts?.addEventListener("loadingdone", this.fontsListener);
  }

  /** 换歌词时内核的行盒全部重建：重置观察器，并把新的行盒一并纳入。 */
  protected rebindObserver(extra: Array<Element | null | undefined> = []): void {
    this.observer.disconnect();
    this.observer.observe(this.host);
    this.observer.observe(this.element);
    for (const element of extra) if (element) this.observer.observe(element);
  }

  /** 换成新的媒体元素：旧的摘掉监听，新的挂上。 */
  protected setAudio(audio: HTMLAudioElement | null): void {
    if (audio === this.audio) return;
    this.listenAudio(false);
    this.audio = audio;
    this.listenAudio(true);
  }

  private listenAudio(add: boolean): void {
    for (const event of MEDIA_CLOCK_EVENTS) {
      if (add) this.audio?.addEventListener(event, this.clockListener);
      else this.audio?.removeEventListener(event, this.clockListener);
    }
  }

  /**
   * 字体就绪握手：先挂载并触发布局，才会请求本段文字对应的字体分片；
   * 就绪时若已换了歌词或已销毁就作废。
   */
  protected whenFontsReady(): void {
    const source = this.lines;
    void (document.fonts?.ready ?? Promise.resolve()).then(() => {
      if (this.disposed || this.lines !== source) return;
      this.fontsReady = true;
      this.measure();
    });
  }

  /** 与内核 ResizeObserver 使用同一 clientHeight（含翻译、注音、和声及折行）。 */
  protected groupsHeight(): { groups: LyricPlayer["currentLyricGroups"]; height: number } {
    const groups = this.player.currentLyricGroups;
    return {
      groups,
      height: groups.reduce((total, group) => total + group.element.clientHeight, 0),
    };
  }

  /** 内核读到的盒模型与页面一致，才算排版落定；不按固定帧数猜测就绪。 */
  protected isLayoutSettled(groups: LyricPlayer["currentLyricGroups"], height: number): boolean {
    return (
      this.player.size[1] === height &&
      groups.every(
        (group) => this.player.lyricGroupSize.get(group)?.[1] === group.element.clientHeight
      )
    );
  }

  protected cancelTick(): void {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.lastFrame = null;
  }

  protected readonly tick = (time: number): void => {
    this.frame = 0;
    if (this.disposed) return;
    this.beforeFrame();
    this.player.update(this.lastFrame === null ? 0 : time - this.lastFrame);
    this.lastFrame = time;
    this.scheduleFrame();
  };

  /** 子类先清自己的定时器与监听，再调用这里收尾。 */
  dispose(): void {
    this.disposed = true;
    this.cancelTick();
    this.listenAudio(false);
    this.observer.disconnect();
    document.fonts?.removeEventListener("loadingdone", this.fontsListener);
    this.player.dispose();
  }
}
