import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UNKNOWN_LICENSE, type CreditDependency } from "@/lib/Credits";
import { CreditsDependencies } from "./CreditsDependencies";

const dependency = (
  overrides: Partial<CreditDependency> & Pick<CreditDependency, "name" | "version">
): CreditDependency => ({
  license: "MIT",
  description: "",
  url: "",
  direct: true,
  scope: "runtime",
  dependencies: [],
  ...overrides,
});

const DEPENDENCIES: readonly CreditDependency[] = [
  dependency({
    name: "@radix-ui/react-dialog",
    version: "1.1.23",
    dependencies: ["@radix-ui/react-slot"],
  }),
  dependency({
    name: "@radix-ui/react-slot",
    version: "1.2.3",
    direct: false,
  }),
  dependency({
    name: "left-pad",
    version: "1.3.0",
    license: UNKNOWN_LICENSE,
    scope: "development",
  }),
  dependency({
    name: "react",
    version: "19.3.0",
    dependencies: ["scheduler"],
  }),
  dependency({
    name: "scheduler",
    version: "0.27.0",
    direct: false,
  }),
  dependency({
    name: "sharp",
    version: "0.35.4",
    license: "Apache-2.0",
    scope: "development",
  }),
];

// jsdom 没有实现 pointer capture，Radix Select 的触发器在 pointerdown 里会调用它们。
beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
});

function renderDependencies(onSelect = vi.fn()) {
  render(<CreditsDependencies dependencies={DEPENDENCIES} onSelect={onSelect} />);
  return { onSelect };
}

const rowNames = () =>
  screen
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-label") ?? button.textContent ?? "");

describe("CreditsDependencies", () => {
  it("一级只渲染直接依赖，计数按主包统计", () => {
    renderDependencies();

    expect(screen.getByText("4 个主包")).toBeInTheDocument();
    // @radix-ui/react-slot 与 scheduler 是传递依赖，只在二级抽屉里出现。
    expect(
      screen.queryByRole("button", { name: /查看 @radix-ui\/react-slot/ })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /查看 scheduler/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
  });

  it("搜索只作用于主包，并更新计数", async () => {
    const user = userEvent.setup();
    renderDependencies();
    const search = screen.getByRole("searchbox", { name: "搜索依赖" });

    await user.type(search, "sharp");
    expect(screen.getByText("1 个主包")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /查看 sharp v/ })).toBeInTheDocument();

    await user.clear(search);
    // 传递依赖不在一级清单里，按它的名字搜索没有结果。
    await user.type(search, "scheduler");
    expect(screen.getByText("0 个主包")).toBeInTheDocument();
    expect(screen.getByText("没有匹配的主包")).toBeInTheDocument();
  });

  it("输入有内容时出现清除搜索按钮，点击后恢复全部主包", async () => {
    const user = userEvent.setup();
    renderDependencies();
    await user.type(screen.getByRole("searchbox", { name: "搜索依赖" }), "sharp");
    expect(screen.queryByRole("button", { name: /查看 react v/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "清除搜索" }));
    expect(screen.getByText("4 个主包")).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "搜索依赖" })).toHaveValue("");
  });

  it("License 筛选项与计数都由主包派生", async () => {
    const user = userEvent.setup();
    renderDependencies();

    await user.click(screen.getByRole("combobox", { name: "License 筛选" }));
    expect(await screen.findByRole("option", { name: "MIT（2）" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Apache-2.0（1）" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "未知（1）" })).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Apache-2.0（1）" }));

    expect(screen.getByText("1 个主包")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /查看 sharp v/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /查看 react v/ })).not.toBeInTheDocument();
  });

  it("无结果时给虚线空状态，清除筛选后恢复列表", async () => {
    const user = userEvent.setup();
    renderDependencies();
    await user.type(screen.getByRole("searchbox", { name: "搜索依赖" }), "不存在的包");

    expect(screen.getByText("没有匹配的主包")).toBeInTheDocument();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(screen.getByText("4 个主包")).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "搜索依赖" })).toHaveValue("");
  });

  it("行里标出开发依赖、未知许可证与子依赖数量，点击整行回传包名", async () => {
    const user = userEvent.setup();
    const { onSelect } = renderDependencies();

    const legacyRow = screen.getByRole("button", { name: /^查看 left-pad v/ });
    expect(within(legacyRow).getByText("开发依赖")).toBeInTheDocument();
    expect(within(legacyRow).getByText("未知")).toBeInTheDocument();
    // 没有子依赖的行不显示尾标。
    expect(within(legacyRow).queryByText(/个依赖$/)).not.toBeInTheDocument();

    const reactRow = screen.getByRole("button", { name: /^查看 react v/ });
    expect(within(reactRow).getByText("1 个依赖")).toBeInTheDocument();

    await user.click(reactRow);
    expect(onSelect).toHaveBeenCalledWith("react");
  });

  it("主包按输入顺序渲染，不在组件内重排", () => {
    renderDependencies();
    const names = rowNames();
    expect(names[0]).toMatch(/^查看 @radix-ui\/react-dialog/);
    expect(names[1]).toMatch(/^查看 left-pad/);
    expect(names[2]).toMatch(/^查看 react/);
    expect(names[3]).toMatch(/^查看 sharp/);
  });
});
