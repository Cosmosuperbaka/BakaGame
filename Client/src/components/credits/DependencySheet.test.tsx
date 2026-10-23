import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  creditDependencyIndex,
  type CreditDependency,
  type CreditLicenseDocument,
} from "@/lib/Credits";
import {
  CREDITS_FIXTURE_DEPENDENCIES,
  CREDITS_FIXTURE_LICENSES,
  loadFixtureLicense,
} from "./CreditsFixtures";
import { DependencySheet } from "./DependencySheet";

const byName = creditDependencyIndex(CREDITS_FIXTURE_DEPENDENCIES);

function fixtureDependency(name: string): CreditDependency {
  const dependency = byName.get(name);
  if (!dependency) throw new Error(`夹具缺少依赖 ${name}`);
  return dependency;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function renderSheet({
  name = "react",
  path = [name],
  loadLicense = loadFixtureLicense,
  onNavigate = vi.fn(),
  onRewind = vi.fn(),
}: {
  name?: string;
  path?: readonly string[];
  loadLicense?: (packageName: string) => Promise<CreditLicenseDocument | null>;
  onNavigate?: (name: string) => void;
  onRewind?: (index: number) => void;
} = {}) {
  render(
    <DependencySheet
      dependency={fixtureDependency(name)}
      byName={byName}
      path={path}
      onNavigate={onNavigate}
      onRewind={onRewind}
      loadLicense={loadLicense}
    />
  );
  return { onNavigate, onRewind };
}

/** 统计格读出的值：标签与数字在同一格里，按标签定位再取那格的数字。 */
function statValue(label: string): string | undefined {
  const cell = screen.getByText(label).parentElement;
  return cell?.querySelector("p")?.textContent;
}

describe("DependencySheet", () => {
  it("先展示包身份与醒目的项目主页 / npm 跳转按钮", () => {
    renderSheet();

    expect(screen.getByText("react")).toBeInTheDocument();
    expect(screen.getByText("直接依赖")).toBeInTheDocument();
    expect(screen.getByText("界面与组件树。")).toBeInTheDocument();
    // 子依赖行里也有 MIT 徽章，这里只在身份徽章行内核对版本与许可证。
    const identityBadges = screen.getByText("直接依赖").parentElement;
    expect(identityBadges).not.toBeNull();
    if (identityBadges) {
      expect(within(identityBadges).getByText("v19.3.0")).toBeInTheDocument();
      expect(within(identityBadges).getByText("MIT")).toBeInTheDocument();
    }

    const homepage = screen.getByRole("link", { name: /项目主页/ });
    expect(homepage).toHaveAttribute("href", "https://react.dev");
    const npm = screen.getByRole("link", { name: /npm 页面/ });
    expect(npm).toHaveAttribute("href", "https://www.npmjs.com/package/react");
  });

  it("没有项目主页时只给 npm 页面按钮，不渲染空链接", () => {
    renderSheet({ name: "left-pad" });

    expect(screen.queryByRole("link", { name: /项目主页/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /npm 页面/ })).toHaveAttribute(
      "href",
      "https://www.npmjs.com/package/left-pad"
    );
  });

  it("统计直接子依赖与传递闭包，并允许点击子依赖下钻", async () => {
    const user = userEvent.setup();
    const { onNavigate } = renderSheet({ name: "vite", path: ["vite"] });

    // vite 直接依赖 esbuild / postcss / rollup，沿依赖链还能到达 4 个包。
    expect(statValue("直接子依赖")).toBe("3");
    expect(statValue("间接依赖（传递闭包）")).toBe("7");
    // 子依赖行与依赖清单一期共用同一套列轨，因此可访问名同形。
    expect(screen.getByRole("button", { name: /^查看 esbuild v/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^查看 rollup v/ }));
    expect(onNavigate).toHaveBeenCalledWith("rollup");
  });

  it("运行时子依赖归到运行时分组", () => {
    // react 的直接子依赖 scheduler 是运行时传递依赖。
    renderSheet({ name: "react", path: ["react"] });

    const group = screen.getByRole("region", { name: "运行时依赖" });
    expect(within(group).getByText("scheduler")).toBeInTheDocument();
    // 分组标题已经说明类型，行内不再挂类型徽章。
    expect(within(group).queryByText("运行时依赖")).not.toBeInTheDocument();
  });

  it("开发子依赖归到开发分组，组内不重复类型徽章", () => {
    // vite 的三个直接子依赖都是开发依赖。
    renderSheet({ name: "vite", path: ["vite"] });

    const group = screen.getByRole("region", { name: "开发依赖" });
    expect(within(group).getByText("esbuild")).toBeInTheDocument();
    expect(within(group).queryByText("开发依赖")).not.toBeInTheDocument();
  });

  it("没有子依赖时给弱化说明，不渲染子依赖列表", () => {
    renderSheet({ name: "left-pad" });

    expect(statValue("直接子依赖")).toBe("0");
    expect(statValue("间接依赖（传递闭包）")).toBe("0");
    expect(screen.getByText("无子依赖")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /的依赖详情$/ })).not.toBeInTheDocument();
  });

  it("下钻后给出整条路径，点中间格一次跳回该层", async () => {
    const user = userEvent.setup();
    const { onRewind } = renderSheet({ name: "rollup", path: ["vite", "rollup"] });

    await user.click(screen.getByRole("button", { name: "返回上一层" }));
    expect(onRewind).toHaveBeenLastCalledWith(0);

    await user.click(screen.getByRole("button", { name: "vite" }));
    expect(onRewind).toHaveBeenLastCalledWith(0);
    // 当前层是文本不是按钮：不能把自己点没。
    expect(screen.queryByRole("button", { name: "rollup" })).not.toBeInTheDocument();
  });

  it("顶层不显示返回按钮", () => {
    renderSheet({ name: "rollup", path: ["rollup"] });
    expect(screen.queryByRole("button", { name: /^返回 / })).not.toBeInTheDocument();
  });

  it("传递的运行时依赖标出运行时依赖", () => {
    renderSheet({ name: "scheduler", path: ["react", "scheduler"] });
    expect(screen.getByText("运行时依赖")).toBeInTheDocument();
  });

  it("传递的开发依赖标出开发依赖", () => {
    renderSheet({ name: "@esbuild/win32-x64", path: ["vite", "@esbuild/win32-x64"] });
    expect(screen.getByText("开发依赖")).toBeInTheDocument();
  });

  it("许可证默认折叠，展开后才调用 loadLicense 并展示原文", async () => {
    const user = userEvent.setup();
    const pending = deferred<CreditLicenseDocument | null>();
    const loadLicense = vi.fn<(packageName: string) => Promise<CreditLicenseDocument | null>>(
      () => pending.promise
    );
    renderSheet({ loadLicense });

    expect(loadLicense).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "许可证原文" }));

    expect(loadLicense).toHaveBeenCalledWith("react");
    expect(screen.getByRole("status")).toHaveTextContent("正在读取许可证原文…");

    await act(async () => {
      pending.resolve(CREDITS_FIXTURE_LICENSES.react);
    });

    expect(await screen.findByText("LICENSE")).toBeInTheDocument();
    expect(screen.getByText("NOTICE")).toBeInTheDocument();
    const text = document.querySelector("pre")?.textContent ?? "";
    expect(text).toContain("MIT License");
  });

  it("包里没有许可证原文时说明原因", async () => {
    const user = userEvent.setup();
    const loadLicense = vi.fn(() => Promise.resolve<CreditLicenseDocument | null>({ files: [] }));
    renderSheet({ name: "left-pad", loadLicense });

    await user.click(screen.getByRole("button", { name: "许可证原文" }));
    expect(await screen.findByText("该包未附带许可证原文。")).toBeInTheDocument();
  });

  it("加载失败给出错误文案，重试后展示原文", async () => {
    const user = userEvent.setup();
    const loadLicense = vi
      .fn<(packageName: string) => Promise<CreditLicenseDocument | null>>()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(CREDITS_FIXTURE_LICENSES.react);
    renderSheet({ loadLicense });

    await user.click(screen.getByRole("button", { name: "许可证原文" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("许可证原文加载失败");
    await user.click(screen.getByRole("button", { name: "重试" }));

    expect(await screen.findByText("LICENSE")).toBeInTheDocument();
    expect(loadLicense).toHaveBeenCalledTimes(2);
  });
});
