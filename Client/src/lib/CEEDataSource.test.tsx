import { render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CEECharacterSummary, CEESubjectSummary } from "@bakagame/shared";
import type { ReactNode } from "react";
import { ceeWsClient, type CEESendCommand } from "@/lib/CEEWs";
import { CEECharacterImage } from "@/components/cee/CEECharacterImage";
import { ceePrivateState } from "@/stories/fixtures/CEE";
import { useCEEStore } from "@/stores/UseCEEStore";
import { clearCEERankedQueryCache, useCEERankedStore } from "@/stores/UseCEERankedStore";
import {
  CEEDataSourceContext,
  rankedCEEDataSource,
  useCEEDataSource,
  type CEEDataSource,
} from "./CEEDataSource";

/** jsdom 没有 IntersectionObserver：这里把「被观察」直接当成已滚进视口。 */
class ImmediateObserver {
  private readonly callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element): void {
    this.callback(
      [{ isIntersecting: true, target } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver
    );
  }
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

const character: CEECharacterSummary = { id: 41, name: "Nao", nameCn: "直" };
const characters: CEECharacterSummary[] = [character];
const subjects: CEESubjectSummary[] = [
  { id: 42, name: "Sora", nameCn: "空", type: 2, year: 2005, rating: 7.5, heat: 100 },
];

const room = useCEEStore.getState();
const ranked = useCEERankedStore.getState();

beforeEach(() => {
  vi.restoreAllMocks();
  useCEEStore.setState({
    searchCharacters: room.searchCharacters,
    searchSubjects: room.searchSubjects,
    loadSubjectCharacters: room.loadSubjectCharacters,
    sendCommand: room.sendCommand,
    privateState: null,
  });
  useCEERankedStore.setState({
    searchCharacters: ranked.searchCharacters,
    searchSubjects: ranked.searchSubjects,
    loadSubjectCharacters: ranked.loadSubjectCharacters,
    characterImage: ranked.characterImage,
  });
  clearCEERankedQueryCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const asIs = ({ children }: { children: ReactNode }) => <>{children}</>;
const withRanked = ({ children }: { children: ReactNode }) => (
  <CEEDataSourceContext.Provider value={rankedCEEDataSource}>
    {children}
  </CEEDataSourceContext.Provider>
);

/** 只替换取图与前缀的假来源：其余成员沿用排位实现，用例只关心它关心的那两项。 */
function imageSource(cacheKeyPrefix: string, characterImage: CEEDataSource["characterImage"]) {
  const source: CEEDataSource = {
    ...rankedCEEDataSource,
    characterImage,
    cacheKeyPrefix,
  };
  return source;
}

describe("数据源缺省值", () => {
  it("没有 Provider 时读到的就是多人房来源", async () => {
    const searchCharacters = vi.fn(async () => characters);
    const searchSubjects = vi.fn(async () => subjects);
    const loadSubjectCharacters = vi.fn(async () => characters);
    useCEEStore.setState({ searchCharacters, searchSubjects, loadSubjectCharacters });

    const { result } = renderHook(() => useCEEDataSource(), { wrapper: asIs });
    expect(result.current.cacheKeyPrefix).toBe("cee");
    await expect(result.current.searchCharacters("直")).resolves.toEqual(characters);
    await expect(result.current.searchSubjects("空")).resolves.toEqual(subjects);
    await expect(result.current.loadSubjectCharacters(42)).resolves.toEqual(characters);
    expect(searchCharacters).toHaveBeenCalledWith("直");
    expect(searchSubjects).toHaveBeenCalledWith("空");
    expect(loadSubjectCharacters).toHaveBeenCalledWith(42);
  });

  it("多人房的图片命令沿用房间的 sendCommand", async () => {
    const sendCommand = vi.fn(async () => ({ imageUrl: "https://example.com/pic.jpg" }));
    useCEEStore.setState({ sendCommand: sendCommand as unknown as CEESendCommand });

    const { result } = renderHook(() => useCEEDataSource(), { wrapper: asIs });
    await expect(result.current.characterImage(41, "large")).resolves.toBe(
      "https://example.com/pic.jpg"
    );
    await expect(result.current.subjectImage(42)).resolves.toBe("https://example.com/pic.jpg");
    expect(sendCommand).toHaveBeenCalledWith("cee.character.image", {
      characterId: 41,
      size: "large",
    });
    expect(sendCommand).toHaveBeenCalledWith("cee.subject.image", { subjectId: 42 });
  });

  it("MCP 接管只从房间私有状态读出", () => {
    const { result, rerender } = renderHook(() => useCEEDataSource().useControlled(), {
      wrapper: asIs,
    });
    expect(result.current).toBe(false);

    useCEEStore.setState({ privateState: ceePrivateState({ mcpControlled: true }) });
    rerender();
    expect(result.current).toBe(true);
  });
});

describe("排位数据源", () => {
  it("查询与取图都发 cee.ranked.* 命令，一次也不碰房间命令", async () => {
    const send = vi.spyOn(ceeWsClient, "send").mockImplementation(async (command) => {
      if (command === "cee.ranked.characterSearch") return { results: characters };
      if (command === "cee.ranked.subjectSearch") return { results: subjects };
      if (command === "cee.ranked.subjectCharacters") return { results: characters };
      if (command === "cee.ranked.characterImage")
        return { imageUrl: "https://example.com/ranked.jpg" };
      return {};
    });
    const sendCommand = vi.fn();
    useCEEStore.setState({ sendCommand });

    const { result } = renderHook(() => useCEEDataSource(), { wrapper: withRanked });
    await result.current.searchCharacters("直");
    await result.current.searchSubjects("空");
    await result.current.loadSubjectCharacters(42);
    await expect(result.current.characterImage(41, "grid")).resolves.toBe(
      "https://example.com/ranked.jpg"
    );

    expect(send.mock.calls.map(([command]) => command)).toEqual([
      "cee.ranked.characterSearch",
      "cee.ranked.subjectSearch",
      "cee.ranked.subjectCharacters",
      "cee.ranked.characterImage",
    ]);
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("排位没有作品封面命令：subjectImage 直接返回 undefined 且不发请求", async () => {
    const send = vi.spyOn(ceeWsClient, "send").mockResolvedValue({});
    await expect(rankedCEEDataSource.subjectImage(42)).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it("排位来源恒不认为 MCP 接管，即使房间已被接管", () => {
    useCEEStore.setState({ privateState: ceePrivateState({ mcpControlled: true }) });
    const { result } = renderHook(() => useCEEDataSource().useControlled(), {
      wrapper: withRanked,
    });
    expect(result.current).toBe(false);
  });

  it("排位来源的图片缓存键前缀与多人房不同", () => {
    expect(rankedCEEDataSource.cacheKeyPrefix).not.toBe("cee");
  });
});

describe("图片缓存键按来源隔离", () => {
  it("同一角色换成排位来源时会重新取图，而不是复用多人房解析好的地址", async () => {
    vi.stubGlobal("IntersectionObserver", ImmediateObserver);
    const roomImage = vi.fn(async () => "https://example.com/room.png");
    const rankedImage = vi.fn(async () => "https://example.com/ranked.png");
    const srcIn = (container: HTMLElement) => container.querySelector("img")?.getAttribute("src");

    const first = render(
      <CEEDataSourceContext.Provider value={imageSource("cee", roomImage)}>
        <CEECharacterImage character={character} />
      </CEEDataSourceContext.Provider>
    );
    await waitFor(() => expect(srcIn(first.container)).toBe("https://example.com/room.png"));

    const second = render(
      <CEEDataSourceContext.Provider value={imageSource("cee-ranked", rankedImage)}>
        <CEECharacterImage character={character} />
      </CEEDataSourceContext.Provider>
    );
    // 键共用的话这里会直接命中多人房已解析的地址，`rankedImage` 一次都不会被调用。
    await waitFor(() => expect(srcIn(second.container)).toBe("https://example.com/ranked.png"));
    expect(rankedImage).toHaveBeenCalledTimes(1);
    expect(roomImage).toHaveBeenCalledTimes(1);
  });
});
