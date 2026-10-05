import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SearchCombobox, SearchOptionContent, type SearchBack, type SearchStatus } from "./SearchCombobox";

interface Item {
  id: string;
  name: string;
}

const ITEMS: Item[] = [
  { id: "a", name: "伊地知虹夏" },
  { id: "b", name: "后藤一里" },
  { id: "c", name: "山田凉" },
];

function Harness({
  options = ITEMS,
  status = null,
  back = null,
  blocked = [],
  onSelect = () => {},
  onSubmit,
}: {
  options?: Item[];
  status?: SearchStatus | null;
  back?: SearchBack | null;
  blocked?: string[];
  onSelect?: (item: Item) => void;
  onSubmit?: () => void;
}) {
  const [value, setValue] = useState("");
  return (
    <>
      <SearchCombobox
        value={value}
        onValueChange={setValue}
        label="搜索角色"
        placeholder="角色名"
        options={options}
        getKey={(item) => item.id}
        renderOption={(item) => <SearchOptionContent title={item.name} />}
        isOptionDisabled={(item) => blocked.includes(item.id)}
        onSelect={onSelect}
        onSubmit={onSubmit}
        listKey="list"
        status={status}
        back={back}
        actions={<button type="button">搜角色</button>}
      />
      <button type="button">别处</button>
    </>
  );
}

describe("SearchCombobox", () => {
  it("聚焦时展开结果，点整行即选中", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    const input = screen.getByRole("combobox", { name: "搜索角色" });
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    await user.click(input);
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("listbox", { name: "搜索角色结果" })).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /后藤一里/ }));
    expect(onSelect).toHaveBeenCalledWith(ITEMS[1]);
    // 选中不抢输入框的焦点。
    expect(input).toHaveFocus();
  });

  it("失焦与 Esc 都会收起面板，再次聚焦或输入时回来", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByRole("combobox", { name: "搜索角色" });
    await user.click(input);
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "别处" }));
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
    expect(input).toHaveAttribute("aria-expanded", "false");

    await user.click(input);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
    expect(input).toHaveFocus();
    await user.type(input, "虹");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("按下右侧按钮不收起面板，焦点留在输入框", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByRole("combobox", { name: "搜索角色" });
    await user.click(input);
    await user.click(screen.getByRole("button", { name: "搜角色" }));
    expect(input).toHaveFocus();
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("上下键移动高亮、回车选中；没有高亮时回车走提交", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onSubmit = vi.fn();
    render(<Harness onSelect={onSelect} onSubmit={onSubmit} />);
    const input = screen.getByRole("combobox", { name: "搜索角色" });
    await user.click(input);

    await user.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();

    await user.keyboard("{ArrowDown}{ArrowDown}");
    const second = screen.getByRole("option", { name: /后藤一里/ });
    expect(second).toHaveAttribute("aria-selected", "true");
    expect(input).toHaveAttribute("aria-activedescendant", second.id);
    await user.keyboard("{ArrowUp}{ArrowUp}");
    // 自第一项再往上绕到末项。
    expect(screen.getByRole("option", { name: /山田凉/ })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith(ITEMS[2]);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("不可选的候选点了不触发选中", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} blocked={["a"]} />);
    await user.click(screen.getByRole("combobox", { name: "搜索角色" }));
    const blocked = screen.getByRole("option", { name: /伊地知虹夏/ });
    expect(blocked).toHaveAttribute("aria-disabled", "true");
    await user.click(blocked);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("二级列表顶上的返回行可点、可用键盘选到", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    render(<Harness back={{ label: "返回作品", detail: "孤独摇滚！", onBack }} />);
    await user.click(screen.getByRole("combobox", { name: "搜索角色" }));
    expect(screen.getAllByRole("option")).toHaveLength(ITEMS.length + 1);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onBack).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("option", { name: /返回作品/ }));
    expect(onBack).toHaveBeenCalledTimes(2);
  });

  it("没有候选时只显示状态行，错误立即播报", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Harness options={[]} />);
    const input = screen.getByRole("combobox", { name: "搜索角色" });
    await user.click(input);
    // 没有可显示的内容时不展开空面板。
    expect(input).toHaveAttribute("aria-expanded", "false");

    rerender(<Harness options={[]} status={{ tone: "busy", text: "正在搜索" }} />);
    expect(screen.getByRole("status")).toHaveTextContent("正在搜索");
    rerender(<Harness options={[]} status={{ tone: "error", text: "搜索失败" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("搜索失败");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
