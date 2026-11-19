import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsReadOnly } from "@/components/common/room/settings/Layout";
import { updateRoomSettingsMemory } from "@/lib/RoomSettingsMemory";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import { songSettings, songSnapshot } from "@/stories/fixtures/SonGuessr";
import { SONG_SUBJECT_LIMIT_BOUNDS, SUBJECT_YEAR_BOUNDS } from "@bakagame/shared/values";
import { SongGameSettings, SongQuestionSettings, SongRoomSettings } from "./SongSettingsPanels";

vi.mock("@/lib/RoomSettingsMemory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/RoomSettingsMemory")>()),
  updateRoomSettingsMemory: vi.fn(),
}));

const initial = useSonGuessrStore.getState();
let sendCommand: ReturnType<typeof vi.fn>;
let showToast: ReturnType<typeof vi.fn>;

const snapshot = () => songSnapshot({ phase: "waiting" });

/** 防抖 400ms：推进时钟，让待提交的草稿落到发送边界。 */
const settle = () => act(() => vi.advanceTimersByTimeAsync(500));

beforeEach(() => {
  vi.useFakeTimers();
  sendCommand = vi.fn().mockResolvedValue({});
  showToast = vi.fn();
  useSonGuessrStore.setState({
    sendCommand: sendCommand as never,
    showToast: showToast as never,
    snapshot: snapshot(),
  });
  vi.mocked(updateRoomSettingsMemory).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  useSonGuessrStore.setState(initial, true);
});

const pickAnime = () => fireEvent.click(screen.getByRole("radio", { name: "听歌识番" }));

describe("猜歌设置面板的自动保存", () => {
  it("房主改题型：防抖后发一次更新设置，并写入下次建房的记忆", async () => {
    render(<SongQuestionSettings snapshot={snapshot()} />);
    pickAnime();
    expect(sendCommand).not.toHaveBeenCalled();
    await settle();

    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(sendCommand).toHaveBeenCalledWith(
      "song.room.updateSettings",
      expect.objectContaining({ questionType: "anime" })
    );
    expect(updateRoomSettingsMemory).toHaveBeenCalledTimes(1);
  });

  it("房主改题型：防抖 400 毫秒到点才发保存", async () => {
    render(<SongQuestionSettings snapshot={snapshot()} />);
    pickAnime();
    await act(() => vi.advanceTimersByTimeAsync(399));
    expect(sendCommand).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });

  it("房主连续改两项：防抖窗口内只发最后一次草稿", async () => {
    render(<SongQuestionSettings snapshot={snapshot()} />);
    pickAnime();
    await act(() => vi.advanceTimersByTimeAsync(200));
    fireEvent.click(screen.getByRole("radio", { name: "自动出题" }));
    await act(() => vi.advanceTimersByTimeAsync(400));

    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(sendCommand).toHaveBeenCalledWith(
      "song.room.updateSettings",
      expect.objectContaining({ questionType: "anime", questionMode: "automatic" })
    );
  });

  it("单人模式照常保存，但不写多人房间的记忆", async () => {
    render(<SongQuestionSettings snapshot={snapshot()} solo />);
    pickAnime();
    await settle();

    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(updateRoomSettingsMemory).not.toHaveBeenCalled();
  });

  it("发送边界读 Store：草稿排好之后房间已离开等待阶段，就丢弃不发", async () => {
    render(<SongQuestionSettings snapshot={snapshot()} />);
    pickAnime();
    // 卸载与 props 都来不及更新的瞬间，Store 里的阶段已经变了。
    act(() => {
      useSonGuessrStore.setState({ snapshot: songSnapshot({ phase: "playing" }) });
    });
    await settle();

    expect(sendCommand).not.toHaveBeenCalled();
    expect(updateRoomSettingsMemory).not.toHaveBeenCalled();
  });

  it("Store 里已是另一间房：同样丢弃", async () => {
    render(<SongQuestionSettings snapshot={snapshot()} />);
    pickAnime();
    act(() => {
      useSonGuessrStore.setState({ snapshot: songSnapshot({ roomId: "OTHER", phase: "waiting" }) });
    });
    await settle();
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("发送被拒：弹出服务端给的原因，被拒的值不写进建房记忆", async () => {
    sendCommand.mockRejectedValueOnce({ code: "BAD", message: "设置不合法" });
    render(<SongQuestionSettings snapshot={snapshot()} />);
    pickAnime();
    await settle();

    expect(showToast).toHaveBeenCalledWith("设置不合法", "error");
    expect(updateRoomSettingsMemory).not.toHaveBeenCalled();
  });

  it("只读（非房主）：不保存也不写记忆", async () => {
    render(
      <SettingsReadOnly readOnly>
        <SongQuestionSettings snapshot={snapshot()} />
        <SongGameSettings snapshot={snapshot()} />
        <SongRoomSettings snapshot={snapshot()} />
      </SettingsReadOnly>
    );
    await settle();
    expect(sendCommand).not.toHaveBeenCalled();
    expect(updateRoomSettingsMemory).not.toHaveBeenCalled();
  });

  it("只读只认外层的只读上下文：取值跟随快照而不是首次渲染的草稿", () => {
    const view = render(
      <SettingsReadOnly readOnly>
        <SongQuestionSettings snapshot={snapshot()} />
      </SettingsReadOnly>
    );
    expect(screen.getByText("听歌识曲")).toBeInTheDocument();

    view.rerender(
      <SettingsReadOnly readOnly>
        <SongQuestionSettings
          snapshot={songSnapshot({
            phase: "waiting",
            settings: { ...snapshot().settings, questionType: "anime" },
          })}
        />
      </SettingsReadOnly>
    );
    expect(screen.getByText("听歌识番")).toBeInTheDocument();
  });

  it("猜测设置：改开关防抖保存，记在 game 名下", async () => {
    render(<SongGameSettings snapshot={snapshot()} />);
    fireEvent.click(screen.getByRole("switch", { name: "显示歌词" }));
    await settle();

    expect(sendCommand).toHaveBeenCalledWith(
      "song.room.updateSettings",
      expect.objectContaining({ showLyrics: false })
    );
    expect(updateRoomSettingsMemory).toHaveBeenCalledWith("song", expect.any(Function));
  });

  it("房间设置：私密房间还没有密码时先不保存，填了密码才提交", async () => {
    render(<SongRoomSettings snapshot={snapshot()} />);
    fireEvent.click(screen.getByRole("switch", { name: "私密房间" }));
    await settle();
    expect(sendCommand).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("房间密码"), { target: { value: "abc123" } });
    await settle();
    expect(sendCommand).toHaveBeenCalledWith(
      "song.room.updateSettings",
      expect.objectContaining({ visibility: "private", password: "abc123" })
    );
    // 名称与口令不进建房记忆：记下的只有「旁观可见答案」这一项。
    const written = vi
      .mocked(updateRoomSettingsMemory)
      .mock.calls.map(([, patch]) => (patch as (current: null) => unknown)(null));
    expect(JSON.stringify(written)).not.toContain("abc123");
    expect(written).toEqual([{ room: { spectatorsSeeAnswers: false } }]);
  });

  it("房间设置：旁观可见答案缺省关闭，打开后保存并记入 room 名下", async () => {
    render(<SongRoomSettings snapshot={snapshot()} />);
    const toggle = screen.getByRole("switch", { name: "旁观者可见答案" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    await settle();

    expect(sendCommand).toHaveBeenCalledWith(
      "song.room.updateSettings",
      expect.objectContaining({ spectatorsSeeAnswers: true })
    );
    const patch = vi.mocked(updateRoomSettingsMemory).mock.calls.at(-1)![1] as (
      current: null
    ) => unknown;
    expect(patch(null)).toEqual({ room: { spectatorsSeeAnswers: true } });
  });

  it("房间设置：旧快照没有这个字段时按关闭显示；非房主只读，不保存也不写记忆", async () => {
    const legacy = snapshot();
    delete (legacy.settings as { spectatorsSeeAnswers?: boolean }).spectatorsSeeAnswers;
    render(
      <SettingsReadOnly readOnly>
        <SongRoomSettings snapshot={legacy} />
      </SettingsReadOnly>
    );
    // 只读态不出开关，只显示取值；字段缺席按「关闭」显示。
    expect(screen.queryByRole("switch", { name: "旁观者可见答案" })).not.toBeInTheDocument();
    expect(screen.getByText("旁观者可见答案")).toBeInTheDocument();
    expect(screen.getAllByText("关闭").length).toBeGreaterThan(0);
    await settle();
    expect(sendCommand).not.toHaveBeenCalled();
    expect(updateRoomSettingsMemory).not.toHaveBeenCalled();
  });
});

describe("番剧筛选的数值界限", () => {
  it("作品数量与年份范围都取共享契约的界限", () => {
    const anime = songSnapshot({
      phase: "waiting",
      settings: songSettings({ questionMode: "automatic", questionType: "anime" }),
    });
    useSonGuessrStore.setState({ snapshot: anime });
    render(<SongQuestionSettings snapshot={anime} />);

    const limit = screen.getByRole("spinbutton", { name: "作品数量（部）" });
    expect(limit).toHaveAttribute("aria-valuemin", String(SONG_SUBJECT_LIMIT_BOUNDS.min));
    expect(limit).toHaveAttribute("aria-valuemax", String(SONG_SUBJECT_LIMIT_BOUNDS.max));
    for (const name of ["年份范围起始", "年份范围结束"]) {
      const year = screen.getByRole("spinbutton", { name });
      expect(year).toHaveAttribute("aria-valuemin", String(SUBJECT_YEAR_BOUNDS.min));
      expect(year).toHaveAttribute("aria-valuemax", String(SUBJECT_YEAR_BOUNDS.max));
    }
  });
});
