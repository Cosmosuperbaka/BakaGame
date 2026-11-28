import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SonGuessrAudioQualityAck } from "@bakagame/shared";
import type { GameSendCommand } from "@/lib/GameWs";
import type { SonGuessrCommandMap } from "@/lib/SonGuessrWs";
import { canDecodeFormat, canDecodeQuality } from "@/lib/SongAudioQuality";
import { SONG_AUDIO_QUALITY_KEY } from "@/lib/Storage";
import { AUDIO_QUALITY_ACK_TIMEOUT_MS, useSongAudioQuality } from "./UseSongAudioQuality";

// jsdom 的 canPlayType 一律回空串：解码能力由各用例自己定。
vi.mock("@/lib/SongAudioQuality", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/SongAudioQuality")>()),
  canDecodeQuality: vi.fn(() => true),
  canDecodeFormat: vi.fn(() => true),
}));

const TICKET = "/api/songuessr/audio/1234/ticket-round-1";
const LOSSLESS = `${TICKET}?q=lossless`;

type Ack = SonGuessrAudioQualityAck | undefined;

/** 每次调用给一个可手动兑现的回执，模拟等服务端的那一段。 */
const deferredCommand = () => {
  const pending: Array<{ payload: unknown; resolve: (ack: Ack) => void; reject: () => void }> = [];
  const sendCommand = vi.fn(
    (_type: string, payload: unknown) =>
      new Promise<Ack>((resolve, reject) =>
        pending.push({ payload, resolve, reject: () => reject(new Error("断线")) })
      )
  );
  return {
    sendCommand: sendCommand as unknown as GameSendCommand<SonGuessrCommandMap>,
    calls: sendCommand,
    pending,
  };
};

const mount = (
  sendCommand: GameSendCommand<SonGuessrCommandMap>,
  initial: { roundNumber?: number; ticketUrl?: string } = { roundNumber: 1, ticketUrl: TICKET }
) =>
  renderHook(
    (props: { roundNumber?: number; ticketUrl?: string }) =>
      useSongAudioQuality({ roomId: "1234", sendCommand, ...props }),
    { initialProps: initial }
  );

describe("useSongAudioQuality", () => {
  beforeEach(() => {
    vi.mocked(canDecodeQuality).mockReturnValue(true);
    vi.mocked(canDecodeFormat).mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("选「自动」时直接用快照里的默认地址，不向服务端要别的档", () => {
    const { sendCommand, calls } = deferredCommand();
    const { result } = mount(sendCommand);
    expect(result.current.preference).toBe("auto");
    expect(result.current.audioUrl).toBe(TICKET);
    expect(result.current.pending).toBe(false);
    expect(result.current.state).toEqual({ kind: "default" });
    expect(calls).not.toHaveBeenCalled();
  });

  it("回合开头按存档的档位去要地址：回执之前不加载，拿到后换成那一档", async () => {
    window.localStorage.setItem(SONG_AUDIO_QUALITY_KEY, "lossless");
    const { sendCommand, calls, pending } = deferredCommand();
    const { result } = mount(sendCommand);

    expect(calls).toHaveBeenCalledWith("song.game.audioQuality", {
      roundNumber: 1,
      quality: "lossless",
    });
    expect(result.current.pending).toBe(true);
    expect(result.current.audioUrl).toBeUndefined();
    expect(result.current.state).toEqual({ kind: "resolving", requested: "lossless" });

    await act(async () => {
      pending[0]!.resolve({ quality: "lossless", audioUrl: LOSSLESS, format: "flac" });
    });
    expect(result.current.pending).toBe(false);
    expect(result.current.audioUrl).toBe(LOSSLESS);
    expect(result.current.state).toEqual({
      kind: "ready",
      requested: "lossless",
      actual: "lossless",
      format: "flac",
    });
  });

  it("上游降档时照实报实际档位", async () => {
    window.localStorage.setItem(SONG_AUDIO_QUALITY_KEY, "master");
    const { sendCommand, pending } = deferredCommand();
    const { result } = mount(sendCommand);
    await act(async () => {
      pending[0]!.resolve({ quality: "exhigh", audioUrl: `${TICKET}?q=exhigh`, format: "mp3" });
    });
    expect(result.current.state).toMatchObject({
      kind: "ready",
      requested: "master",
      actual: "exhigh",
    });
    expect(result.current.audioUrl).toBe(`${TICKET}?q=exhigh`);
  });

  it.each([
    {
      label: "这首歌没有这一档",
      settle: (p: ReturnType<typeof deferredCommand>["pending"][0]) =>
        p.resolve({ unavailable: true }),
      reason: "unavailable",
    },
    {
      label: "回合已经换了",
      settle: (p: ReturnType<typeof deferredCommand>["pending"][0]) => p.resolve({ ignored: true }),
      reason: "unavailable",
    },
    {
      label: "请求失败",
      settle: (p: ReturnType<typeof deferredCommand>["pending"][0]) => p.reject(),
      reason: "failed",
    },
  ])("$label时回到默认地址", async ({ settle, reason }) => {
    window.localStorage.setItem(SONG_AUDIO_QUALITY_KEY, "dolby");
    const { sendCommand, pending } = deferredCommand();
    const { result } = mount(sendCommand);
    await act(async () => {
      settle(pending[0]!);
    });
    expect(result.current.audioUrl).toBe(TICKET);
    expect(result.current.pending).toBe(false);
    expect(result.current.state).toEqual({ kind: "fallback", requested: "dolby", reason });
  });

  it("回执迟迟不来时先用默认地址开播，迟到的回执不再换档", async () => {
    vi.useFakeTimers();
    window.localStorage.setItem(SONG_AUDIO_QUALITY_KEY, "hires");
    const { sendCommand, pending } = deferredCommand();
    const { result } = mount(sendCommand);

    await act(async () => {
      vi.advanceTimersByTime(AUDIO_QUALITY_ACK_TIMEOUT_MS);
    });
    expect(result.current.audioUrl).toBe(TICKET);
    expect(result.current.state).toEqual({
      kind: "fallback",
      requested: "hires",
      reason: "failed",
    });

    await act(async () => {
      pending[0]!.resolve({ quality: "hires", audioUrl: `${TICKET}?q=hires` });
    });
    expect(result.current.audioUrl).toBe(TICKET);
  });

  it("这台设备解不了的档不去要；回执里的格式解不了也回到默认档，之后的回合不再要", async () => {
    vi.mocked(canDecodeQuality).mockImplementation((quality) => quality !== "dolby");
    window.localStorage.setItem(SONG_AUDIO_QUALITY_KEY, "dolby");
    const first = deferredCommand();
    const dolby = mount(first.sendCommand);
    expect(first.calls).not.toHaveBeenCalled();
    expect(dolby.result.current.audioUrl).toBe(TICKET);
    expect(dolby.result.current.state).toEqual({
      kind: "fallback",
      requested: "dolby",
      reason: "unsupported",
    });
    dolby.unmount();

    vi.mocked(canDecodeFormat).mockReturnValue(false);
    window.localStorage.setItem(SONG_AUDIO_QUALITY_KEY, "vivid");
    const second = deferredCommand();
    const vivid = mount(second.sendCommand);
    await act(async () => {
      second.pending[0]!.resolve({
        quality: "vivid",
        audioUrl: `${TICKET}?q=vivid`,
        format: "ogg",
      });
    });
    expect(vivid.result.current.audioUrl).toBe(TICKET);
    expect(vivid.result.current.state).toMatchObject({ kind: "fallback", reason: "unsupported" });

    vivid.rerender({ roundNumber: 2, ticketUrl: "/api/songuessr/audio/1234/ticket-round-2" });
    expect(second.calls).toHaveBeenCalledTimes(1);
    expect(vivid.result.current.state).toMatchObject({ kind: "fallback", reason: "unsupported" });
  });

  it("回合中途换档：新档到手之前接着放手上这一档，不停下来", async () => {
    const { sendCommand, pending } = deferredCommand();
    const { result } = mount(sendCommand);
    expect(result.current.audioUrl).toBe(TICKET);

    act(() => result.current.setPreference("lossless"));
    expect(window.localStorage.getItem(SONG_AUDIO_QUALITY_KEY)).toBe("lossless");
    expect(result.current.state).toEqual({ kind: "resolving", requested: "lossless" });
    expect(result.current.pending).toBe(false);
    expect(result.current.audioUrl).toBe(TICKET);

    await act(async () => {
      pending[0]!.resolve({ quality: "lossless", audioUrl: LOSSLESS, format: "flac" });
    });
    expect(result.current.audioUrl).toBe(LOSSLESS);

    // 换回「自动」就回到默认地址，不再发请求。
    act(() => result.current.setPreference("auto"));
    expect(result.current.audioUrl).toBe(TICKET);
    expect(pending).toHaveLength(1);
  });

  it("下一回合重新要这一档；回合开头没有可放的就等回执", async () => {
    window.localStorage.setItem(SONG_AUDIO_QUALITY_KEY, "lossless");
    const { sendCommand, calls, pending } = deferredCommand();
    const { result, rerender } = mount(sendCommand);
    await act(async () => {
      pending[0]!.resolve({ quality: "lossless", audioUrl: LOSSLESS });
    });

    const nextTicket = "/api/songuessr/audio/1234/ticket-round-2";
    rerender({ roundNumber: 2, ticketUrl: nextTicket });
    expect(calls).toHaveBeenLastCalledWith("song.game.audioQuality", {
      roundNumber: 2,
      quality: "lossless",
    });
    expect(result.current.pending).toBe(true);
    expect(result.current.audioUrl).toBeUndefined();

    // 两回合之间没有歌要放：不要地址，也不算等待。
    rerender({ roundNumber: undefined, ticketUrl: undefined });
    expect(result.current.pending).toBe(false);
    expect(result.current.state).toEqual({ kind: "default" });
  });

  it("换上的那一档放不出来就回到默认地址；默认地址自己的失败不归它管", async () => {
    window.localStorage.setItem(SONG_AUDIO_QUALITY_KEY, "lossless");
    const { sendCommand, calls, pending } = deferredCommand();
    const { result, rerender } = mount(sendCommand);
    await act(async () => {
      pending[0]!.resolve({ quality: "lossless", audioUrl: LOSSLESS });
    });

    expect(result.current.reportSourceError(TICKET)).toBe(false);
    let handled = false;
    act(() => {
      handled = result.current.reportSourceError(LOSSLESS);
    });
    expect(handled).toBe(true);
    expect(result.current.audioUrl).toBe(TICKET);
    expect(result.current.state).toEqual({
      kind: "fallback",
      requested: "lossless",
      reason: "failed",
    });

    // 只是这一次没放出来（网络、过期）：下一回合照样再要。
    const round2 = "/api/songuessr/audio/1234/ticket-round-2";
    rerender({ roundNumber: 2, ticketUrl: round2 });
    expect(calls).toHaveBeenCalledTimes(2);
    await act(async () => {
      pending[1]!.resolve({ quality: "lossless", audioUrl: `${round2}?q=lossless` });
    });

    // 解码失败：当场标成这台设备解不了，本次打开页面内不再请求。
    act(() => {
      handled = result.current.reportSourceError(`${round2}?q=lossless`, true);
    });
    expect(handled).toBe(true);
    expect(result.current.audioUrl).toBe(round2);
    expect(result.current.state).toMatchObject({ kind: "fallback", reason: "unsupported" });
    rerender({ roundNumber: 3, ticketUrl: "/api/songuessr/audio/1234/ticket-round-3" });
    expect(calls).toHaveBeenCalledTimes(2);
  });
});
