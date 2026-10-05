import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BangumiSongCandidate, BangumiSubjectSearchResult, SongSearchResult } from "@/types";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import { AnimeSearch, SongSearch } from "./SongSearch";

const initial = useSonGuessrStore.getState();
afterEach(() => {
  // setState 的普通 action 替换不属于 vi.restoreAllMocks 的还原范围。
  useSonGuessrStore.setState(initial, true);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { resolve, reject, promise };
}

const STAR: SongSearchResult = { id: "song-1", title: "夜空中最亮的星", artist: "逃跑计划", album: "世界" };
const RAIN: SongSearchResult = { id: "song-2", title: "雨夜", artist: "测试歌手", requiresVip: true };
const SUMMER: BangumiSubjectSearchResult = { id: "sub-1", name: "夏空メロディー", nameCn: "夏空旋律", year: 2021, rating: 7.8, tags: [], metaTags: [] };
const OP: BangumiSongCandidate = {
  song: { id: "song-op", title: "夏空メロディー", artist: "コトノハ", album: "OP 单曲" },
  track: { title: "夏空メロディー", artist: "コトノハ", kind: "opening" },
};

/**
 * 用真实时钟：面板的进退场是 framer-motion 动画，假时钟下不会推进。
 * 防抖窗口只有 350ms，等它过去再断言即可。
 */
const setup = () => userEvent.setup();
const flushDebounce = () => act(() => new Promise<void>((resolve) => { window.setTimeout(resolve, 400); }));

describe("SongSearch", () => {
  it("输入即查，结果浮层里点整行提交，成功后清空收起", async () => {
    const user = setup();
    const searchMusic = vi.fn().mockResolvedValue([STAR, RAIN]);
    useSonGuessrStore.setState({ searchMusic });
    const onSelect = vi.fn().mockResolvedValue(undefined);
    render(<SongSearch mode="guess" onSelect={onSelect} />);

    const input = screen.getByRole("combobox", { name: "搜索歌曲" });
    await user.type(input, "夜");
    await flushDebounce();
    expect(searchMusic).toHaveBeenCalledExactlyOnceWith("夜");
    // 行内副标题是歌手与专辑，会员歌曲带标记；没有单独的「猜这首」按钮。
    expect(screen.getByRole("option", { name: /夜空中最亮的星.*逃跑计划 · 世界/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /雨夜.*会员专享/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /猜这首|设为答案/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("option", { name: /夜空中最亮的星/ }));
    expect(onSelect).toHaveBeenCalledWith(STAR);
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
    expect(input).toHaveValue("");
  });

  it("提交失败时保留结果并在面板顶部报错", async () => {
    const user = setup();
    useSonGuessrStore.setState({ searchMusic: vi.fn().mockResolvedValue([STAR]) });
    const onSelect = vi.fn().mockRejectedValue(new Error("本回合已结束"));
    render(<SongSearch mode="guess" onSelect={onSelect} />);
    await user.type(screen.getByRole("combobox", { name: "搜索歌曲" }), "星");
    await flushDebounce();
    await user.click(screen.getByRole("option", { name: /夜空中最亮的星/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("本回合已结束");
    expect(screen.getByRole("option", { name: /夜空中最亮的星/ })).toBeInTheDocument();
  });

  it("本回合猜过的歌保留在结果里但不可再选", async () => {
    const user = setup();
    useSonGuessrStore.setState({ searchMusic: vi.fn().mockResolvedValue([STAR, RAIN]) });
    const onSelect = vi.fn();
    render(<SongSearch mode="guess" guessedIds={[STAR.id]} onSelect={onSelect} />);
    await user.type(screen.getByRole("combobox", { name: "搜索歌曲" }), "夜");
    await flushDebounce();
    const guessed = screen.getByRole("option", { name: /夜空中最亮的星.*已猜过/ });
    expect(guessed).toHaveAttribute("aria-disabled", "true");
    await user.click(guessed);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("清空输入后在途请求晚到也不复活结果；新查询先回来时旧查询的失败被丢弃", async () => {
    const user = setup();
    const first = deferred<SongSearchResult[]>();
    const second = deferred<SongSearchResult[]>();
    const searchMusic = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    useSonGuessrStore.setState({ searchMusic });
    render(<SongSearch mode="guess" onSelect={vi.fn()} />);
    const input = screen.getByRole("combobox", { name: "搜索歌曲" });

    await user.type(input, "A");
    await flushDebounce();
    expect(screen.getByRole("status")).toHaveTextContent("正在查询网易云音乐");
    await user.clear(input);
    // 面板收起有退场动画，等它退完。
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    await user.type(input, "B");
    await flushDebounce();
    await act(async () => { second.resolve([RAIN]); await second.promise; });
    expect(screen.getByRole("option", { name: /雨夜/ })).toBeInTheDocument();
    await act(async () => { first.reject(new Error("旧请求失败")); });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: /雨夜/ })).toBeInTheDocument();
  });

  it("查询无结果与失败都显示在面板里", async () => {
    const user = setup();
    const searchMusic = vi.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("网易云暂时不可用"));
    useSonGuessrStore.setState({ searchMusic });
    render(<SongSearch mode="guess" onSelect={vi.fn()} />);
    const input = screen.getByRole("combobox", { name: "搜索歌曲" });
    await user.type(input, "无");
    await flushDebounce();
    expect(screen.getByRole("status")).toHaveTextContent("没有找到匹配歌曲");
    await user.type(input, "效");
    await flushDebounce();
    expect(screen.getByRole("alert")).toHaveTextContent("网易云暂时不可用");
  });
});

describe("AnimeSearch", () => {
  it("猜测时点番剧即提交", async () => {
    const user = setup();
    useSonGuessrStore.setState({ searchBangumi: vi.fn().mockResolvedValue([SUMMER]) });
    const onSelect = vi.fn().mockResolvedValue(undefined);
    render(<AnimeSearch mode="guess" onSelect={onSelect} />);
    await user.type(screen.getByRole("combobox", { name: "搜索番剧" }), "夏空");
    await flushDebounce();
    await user.click(screen.getByRole("option", { name: /夏空旋律.*夏空メロディー · 2021 · 7\.8 分/ }));
    expect(onSelect).toHaveBeenCalledWith(SUMMER, undefined);
  });

  it("出题时点番剧进入关联曲，选一首提交；更换番剧回到番剧结果", async () => {
    const user = setup();
    const resolveAnimeSongs = vi.fn().mockResolvedValue([OP]);
    useSonGuessrStore.setState({ searchBangumi: vi.fn().mockResolvedValue([SUMMER]), resolveAnimeSongs });
    const onSelect = vi.fn().mockResolvedValue(undefined);
    render(<AnimeSearch mode="submit" onSelect={onSelect} />);
    await user.type(screen.getByRole("combobox", { name: "搜索番剧" }), "夏空");
    await flushDebounce();

    await user.click(screen.getByRole("option", { name: /夏空旋律/ }));
    expect(resolveAnimeSongs).toHaveBeenCalledWith(SUMMER.id);
    expect(await screen.findByRole("option", { name: /更换番剧.*夏空旋律/ })).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /更换番剧/ }));
    // 返回行的说明里也有番剧名；等它与关联曲列表退场后，只剩番剧结果这一行。
    await waitFor(() => expect(screen.queryByRole("option", { name: /更换番剧/ })).not.toBeInTheDocument());
    const subject = screen.getByRole("option", { name: /夏空旋律/ });

    await user.click(subject);
    await user.click(await screen.findByRole("option", { name: /OP.*コトノハ · OP 单曲|コトノハ · OP 单曲.*OP/ }));
    expect(onSelect).toHaveBeenCalledWith(SUMMER, OP.song.id);
  });

  it("番剧没有可播放的关联曲时给出说明，顶上仍可更换", async () => {
    const user = setup();
    useSonGuessrStore.setState({ searchBangumi: vi.fn().mockResolvedValue([SUMMER]), resolveAnimeSongs: vi.fn().mockResolvedValue([]) });
    render(<AnimeSearch mode="submit" onSelect={vi.fn()} />);
    await user.type(screen.getByRole("combobox", { name: "搜索番剧" }), "夏空");
    await flushDebounce();
    await user.click(screen.getByRole("option", { name: /夏空旋律/ }));
    expect(await screen.findByRole("status")).toHaveTextContent("该番剧未匹配到可播放的关联歌曲");
    expect(screen.getByRole("option", { name: /更换番剧/ })).toBeInTheDocument();
  });
});
