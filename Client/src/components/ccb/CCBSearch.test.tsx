import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CCBCharacterSummary, CCBSubjectSummary } from "@bakagame/shared";
import { useCCBStore } from "@/stores/UseCCBStore";
import { CCBSearch, CCBSubjectSearch } from "./CCBSearch";

// 带图片地址时角色图不走懒加载的 IntersectionObserver（jsdom 没有）。
const IMAGE = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const NIJIKA: CCBCharacterSummary = { id: 1, name: "伊地知虹夏", nameCn: "伊地知虹夏", imageUrl: IMAGE };
const BOCCHI: CCBCharacterSummary = { id: 2, name: "後藤ひとり", nameCn: "后藤一里", imageUrl: IMAGE };
const BOCCHI_THE_ROCK: CCBSubjectSummary = { id: 328609, name: "ぼっち・ざ・ろっく！", nameCn: "孤独摇滚！", type: 2, year: 2022, rating: 8.9, heat: 1 };

const original = useCCBStore.getState();
afterEach(() => {
  useCCBStore.setState({
    searchCharacters: original.searchCharacters,
    searchSubjects: original.searchSubjects,
    loadSubjectCharacters: original.loadSubjectCharacters,
  });
  vi.restoreAllMocks();
});

function stubSearch() {
  const searchCharacters = vi.fn(async () => [NIJIKA, BOCCHI]);
  const searchSubjects = vi.fn(async () => [BOCCHI_THE_ROCK]);
  const loadSubjectCharacters = vi.fn(async () => [BOCCHI]);
  useCCBStore.setState({ searchCharacters, searchSubjects, loadSubjectCharacters });
  return { searchCharacters, searchSubjects, loadSubjectCharacters };
}

describe("CCB 角色搜索", () => {
  it("停止输入后自动搜角色：先日文名后中文名，点整行提交，成功后清空收起", async () => {
    const user = userEvent.setup();
    const { searchCharacters, searchSubjects } = stubSearch();
    const onSelect = vi.fn(async () => true);
    render(<CCBSearch allowSubjects bannedIds={[1]} onSelect={onSelect} />);
    const input = screen.getByRole("combobox", { name: "搜索角色" });
    expect(screen.getByRole("button", { name: "搜角色" })).toHaveAttribute("aria-pressed", "true");

    await user.type(input, "ぼっち");
    const bocchi = await screen.findByRole("option", { name: /後藤ひとり.*后藤一里/ });
    // 连续敲字只在停顿后查一次，不逐字请求。
    expect(searchCharacters).toHaveBeenCalledTimes(1);
    expect(searchCharacters).toHaveBeenCalledWith("ぼっち");
    expect(searchSubjects).not.toHaveBeenCalled();
    // 主名与副名相同时不重复显示，已被选择的角色保留在列表里但不可选。
    const nijika = screen.getByRole("option", { name: /伊地知虹夏/ });
    expect(nijika).toHaveAttribute("aria-disabled", "true");
    expect(nijika.textContent?.match(/伊地知虹夏/g)).toHaveLength(1);
    await user.click(nijika);
    expect(onSelect).not.toHaveBeenCalled();

    await user.click(bocchi);
    expect(onSelect).toHaveBeenCalledWith(BOCCHI);
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
    expect(input).toHaveValue("");
  });

  it("提交失败时保留结果，可以换一个再选", async () => {
    const user = userEvent.setup();
    stubSearch();
    const onSelect = vi.fn(async () => false);
    render(<CCBSearch allowSubjects={false} defaultMode="subject" onSelect={onSelect} />);
    // 不允许搜作品时没有作品按钮，默认范围也落回角色。
    expect(screen.queryByRole("button", { name: "搜作品" })).not.toBeInTheDocument();
    await user.type(screen.getByRole("combobox", { name: "搜索角色" }), "虹夏{Enter}");
    await user.click(await screen.findByRole("option", { name: /伊地知虹夏/ }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("option", { name: /伊地知虹夏/ })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "搜索角色" })).toHaveValue("虹夏");
  });

  it("默认搜作品：点作品进入角色列表，返回行回到作品结果；切到角色用同一关键词立即重查", async () => {
    const user = userEvent.setup();
    const { searchCharacters, searchSubjects, loadSubjectCharacters } = stubSearch();
    const onSelect = vi.fn(async () => true);
    render(<CCBSearch allowSubjects defaultMode="subject" onSelect={onSelect} />);
    expect(screen.getByRole("button", { name: "搜作品" })).toHaveAttribute("aria-pressed", "true");
    const input = screen.getByRole("combobox", { name: "搜索角色" });
    await user.type(input, "孤独摇滚");

    await user.click(await screen.findByRole("option", { name: /ぼっち・ざ・ろっく！.*孤独摇滚！.*2022/ }));
    expect(searchSubjects).toHaveBeenCalledWith("孤独摇滚");
    expect(loadSubjectCharacters).toHaveBeenCalledWith(BOCCHI_THE_ROCK.id);
    expect(await screen.findByRole("option", { name: /返回作品.*孤独摇滚！/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /後藤ひとり/ })).toBeInTheDocument();

    await user.click(screen.getByRole("option", { name: /返回作品/ }));
    expect(await screen.findByRole("option", { name: /ぼっち・ざ・ろっく！/ })).toBeInTheDocument();
    expect(searchCharacters).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "搜角色" }));
    expect(screen.getByRole("button", { name: "搜角色" })).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByRole("option", { name: /伊地知虹夏/ })).toBeInTheDocument();
    expect(searchCharacters).toHaveBeenCalledWith("孤独摇滚");
    // 作品结果随范围切换作废（播完退场后卸载），不留在角色面板里。
    await waitFor(() => expect(screen.queryByRole("option", { name: /ぼっち・ざ・ろっく！/ })).not.toBeInTheDocument());
  });

  it("查询失败在面板里报错", async () => {
    const user = userEvent.setup();
    useCCBStore.setState({ searchCharacters: vi.fn(async () => { throw new Error("Bangumi 暂时无法访问"); }) });
    render(<CCBSearch allowSubjects onSelect={() => {}} />);
    await user.type(screen.getByRole("combobox", { name: "搜索角色" }), "虹夏");
    expect(await screen.findByRole("alert")).toHaveTextContent("Bangumi 暂时无法访问");
  });
});

describe("追加作品搜索", () => {
  it("点作品即加入，已加入的标「已添加」并不可再选", async () => {
    const user = userEvent.setup();
    stubSearch();
    const onAdd = vi.fn();
    const view = render(<CCBSubjectSearch addedIds={[]} onAdd={onAdd} />);
    await user.type(screen.getByRole("combobox", { name: "搜索作品" }), "孤独摇滚");
    await user.click(await screen.findByRole("option", { name: /孤独摇滚！/ }));
    expect(onAdd).toHaveBeenCalledWith(BOCCHI_THE_ROCK);

    view.rerender(<CCBSubjectSearch addedIds={[BOCCHI_THE_ROCK.id]} onAdd={onAdd} />);
    const added = screen.getByRole("option", { name: /孤独摇滚！.*已添加/ });
    expect(added).toHaveAttribute("aria-disabled", "true");
    await user.click(added);
    expect(onAdd).toHaveBeenCalledTimes(1);
  });
});
