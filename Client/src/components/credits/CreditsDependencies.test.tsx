import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UNKNOWN_LICENSE, type CreditDependency } from "@/lib/Credits";
import { CreditsDependencies } from "./CreditsDependencies";

const DEPENDENCIES: readonly CreditDependency[] = [
  {
    name: "@radix-ui/react-dialog",
    version: "1.1.23",
    license: "MIT",
    description: "",
    url: "",
    direct: true,
    scope: "runtime",
  },
  {
    name: "legacy-tool",
    version: "0.0.1",
    license: UNKNOWN_LICENSE,
    description: "",
    url: "",
    direct: false,
    scope: "development",
  },
  {
    name: "react",
    version: "19.3.0",
    license: "MIT",
    description: "",
    url: "https://react.dev",
    direct: true,
    scope: "runtime",
  },
  {
    name: "sharp",
    version: "0.35.4",
    license: "Apache-2.0",
    description: "",
    url: "",
    direct: true,
    scope: "development",
  },
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
  screen.getAllByRole("button").map((button) => button.textContent ?? "");

describe("CreditsDependencies", () => {
  it("搜索即时过滤包名、版本与 License，并更新结果计数", async () => {
    const user = userEvent.setup();
    renderDependencies();
    expect(screen.getByText("4 个依赖")).toBeInTheDocument();

    const search = screen.getByRole("searchbox", { name: "搜索依赖" });
    await user.type(search, "sharp");
    expect(screen.getByText("1 个依赖")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^查看 sharp v/ })).toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "19.3");
    expect(screen.getByRole("button", { name: /^查看 react v/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^查看 sharp v/ })).not.toBeInTheDocument();
  });

  it("输入有内容时出现清除搜索按钮，点击后恢复全部依赖", async () => {
    const user = userEvent.setup();
    renderDependencies();
    await user.type(screen.getByRole("searchbox", { name: "搜索依赖" }), "sharp");
    expect(screen.queryByRole("button", { name: /^查看 react v/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "清除搜索" }));
    expect(screen.getByText("4 个依赖")).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "搜索依赖" })).toHaveValue("");
  });

  it("License 筛选按 creditLicenseOptions 的候选项过滤", async () => {
    const user = userEvent.setup();
    renderDependencies();

    await user.click(screen.getByRole("combobox", { name: "License 筛选" }));
    await user.click(await screen.findByRole("option", { name: /Apache-2\.0/ }));

    expect(screen.getByText("1 个依赖")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^查看 sharp v/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^查看 react v/ })).not.toBeInTheDocument();
  });

  it("无结果时给虚线空状态，清除筛选后恢复列表", async () => {
    const user = userEvent.setup();
    renderDependencies();
    await user.type(screen.getByRole("searchbox", { name: "搜索依赖" }), "不存在的包");

    expect(screen.getByText("没有匹配的依赖")).toBeInTheDocument();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(screen.getByText("4 个依赖")).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "搜索依赖" })).toHaveValue("");
  });

  it("行里标出开发依赖与未声明许可证，点击整行回传该依赖", async () => {
    const user = userEvent.setup();
    const { onSelect } = renderDependencies();
    const legacyRow = screen.getByRole("button", { name: /^查看 legacy-tool v/ });
    expect(within(legacyRow).getByText("开发依赖")).toBeInTheDocument();
    expect(within(legacyRow).getByText("未知")).toBeInTheDocument();

    await user.click(legacyRow);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: "legacy-tool" }));
  });

  it("依赖清单按输入顺序渲染，不在组件内重排", () => {
    renderDependencies();
    const names = rowNames();
    expect(names[0]).toMatch(/^@radix-ui\/react-dialog/);
    expect(names[1]).toMatch(/^legacy-tool/);
    expect(names[2]).toMatch(/^react/);
    expect(names[3]).toMatch(/^sharp/);
  });
});
