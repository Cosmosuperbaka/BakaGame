import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CreditDependency, CreditLicenseDocument } from "@/lib/Credits";
import { LicenseSheet } from "./LicenseSheet";

const dependency: CreditDependency = {
  name: "react",
  version: "19.3.0",
  license: "MIT",
  description: "界面与组件树。",
  url: "https://react.dev",
  direct: true,
  scope: "runtime",
};

const documentWithFiles: CreditLicenseDocument = {
  files: [{ name: "LICENSE", text: "MIT License\n\nCopyright (c) Meta Platforms, Inc. and affiliates." }],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("LicenseSheet", () => {
  it("包元数据先出现，加载中给出说明，原文到达后保留换行", async () => {
    const pending = deferred<CreditLicenseDocument | null>();
    const loadLicense = vi.fn(() => pending.promise);
    const { container } = render(<LicenseSheet dependency={dependency} loadLicense={loadLicense} />);

    expect(screen.getByText("v19.3.0")).toBeInTheDocument();
    expect(screen.getByText("MIT")).toBeInTheDocument();
    expect(screen.getByText("界面与组件树。")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("正在读取许可证原文…");

    await act(async () => {
      pending.resolve(documentWithFiles);
    });

    expect(await screen.findByText("LICENSE")).toBeInTheDocument();
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toBe(documentWithFiles.files[0].text);
    expect(loadLicense).toHaveBeenCalledWith("react");
  });

  it("包里没有许可证原文时说明原因并给出包主页与 npm 链接", async () => {
    render(<LicenseSheet dependency={dependency} loadLicense={() => Promise.resolve({ files: [] })} />);

    expect(await screen.findByText("该包未附带许可证原文。")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /项目主页/ })[0]).toHaveAttribute("href", dependency.url);
    expect(screen.getAllByRole("link", { name: /npm 页面/ })[0]).toHaveAttribute(
      "href",
      "https://www.npmjs.com/package/react",
    );
  });

  it("加载失败给出错误文案，重试后展示原文", async () => {
    const user = userEvent.setup();
    const loadLicense = vi
      .fn<(packageName: string) => Promise<CreditLicenseDocument | null>>()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(documentWithFiles);
    render(<LicenseSheet dependency={dependency} loadLicense={loadLicense} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("许可证原文加载失败");
    await user.click(screen.getByRole("button", { name: "重试" }));

    expect(await screen.findByText("LICENSE")).toBeInTheDocument();
    expect(loadLicense).toHaveBeenCalledTimes(2);
  });
});
