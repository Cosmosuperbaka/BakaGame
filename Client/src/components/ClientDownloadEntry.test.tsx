import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 每个用例都重新装一遍模块：`ClientPackages` 把成功结果缓存在模块级，
 * 不复位的话后一个用例拿到的是前一个用例的制品列表。
 * 传多个载荷即按次序返回（末一个之后重复它），用来演「先失败、重试后成功」。
 */
async function renderWithPackages(...payloads: unknown[]) {
  vi.resetModules();
  let attempt = 0;
  const fetchMock = vi.fn(async () => {
    const packages = payloads[Math.min(attempt++, payloads.length - 1)];
    // 只用到 `ok` 与 `json()`，不必依赖环境里的 fetch 实现。
    return { ok: true, json: async () => ({ packages }) };
  });
  vi.stubGlobal("fetch", fetchMock);
  const { ClientDownloadEntry } = await import("./ClientDownloadEntry");
  render(<ClientDownloadEntry />);
  return fetchMock;
}

const WINDOWS = {
  platform: "windows",
  arch: "x64",
  url: "https://cdn.test/files/BakaGame-latest-x64.exe",
  available: true,
  sizeBytes: 84_216_320,
  builtAt: "2026-10-19T09:12:33.000Z",
};

const ANDROID = {
  platform: "android",
  arch: "全架构通用",
  url: "https://cdn.test/files/BakaGame-latest-release.apk",
  available: true,
  sizeBytes: 7_168_400,
  builtAt: "2026-10-18T23:59:59.000Z",
};

afterEach(() => {
  delete window.__BAKA_CHANNEL__;
  vi.unstubAllGlobals();
});

describe("ClientDownloadEntry", () => {
  it("壳里没有下载入口：已经在客户端里的人没有「再装一遍」要选", async () => {
    for (const clientType of ["desktop", "mobile"] as const) {
      // 只注入通道对象本身：入口判的是壳在不在，不读里面的凭据与自检。
      window.__BAKA_CHANNEL__ = {
        clientType,
        platform: clientType === "mobile" ? "android" : "windows",
        clientVersion: "1.0.0",
      };
      vi.resetModules();
      const { ClientDownloadEntry } = await import("./ClientDownloadEntry");
      const { unmount } = render(<ClientDownloadEntry />);

      expect(screen.queryByRole("button", { name: "下载客户端" })).not.toBeInTheDocument();
      unmount();
    }
  });

  it("入口只写「下载客户端」，点开之前不谈系统与安装包", async () => {
    const fetchMock = await renderWithPackages([WINDOWS, ANDROID]);
    const user = userEvent.setup();

    const entry = screen.getByRole("button", { name: "下载客户端" });
    expect(screen.queryByText(/反作弊/)).not.toBeInTheDocument();
    // 打开弹窗才需要发布信息：玩家没点，就不该替全站多问一次。
    expect(fetchMock).not.toHaveBeenCalled();

    await user.click(entry);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("默认档标出架构、构建日期与文件大小，下载链指向该平台的包", async () => {
    await renderWithPackages([WINDOWS, ANDROID]);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "下载客户端" }));

    const dialog = await screen.findByRole("dialog");
    expect(screen.getByRole("radio", { name: "Windows" })).toBeChecked();
    expect(dialog).toHaveTextContent("x64");
    // 构建日期按北京时间写，与站内其它时刻同一口径。
    expect(dialog).toHaveTextContent("2026/10/19 17:12");
    expect(dialog).toHaveTextContent("80.3 MB");

    const download = screen.getByRole("link", { name: "下载 Windows 安装包" });
    expect(download).toHaveAttribute("href", WINDOWS.url);
    expect(download).toHaveAttribute("target", "_blank");
  });

  it("切到安卓档后三项信息跟着换成安卓的包", async () => {
    await renderWithPackages([WINDOWS, ANDROID]);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "下载客户端" }));
    await user.click(await screen.findByRole("radio", { name: "Android" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("全架构通用");
    expect(dialog).toHaveTextContent("6.8 MB");
    expect(dialog).toHaveTextContent("2026/10/19 07:59");
    expect(screen.getByRole("link", { name: "下载 Android 安装包" })).toHaveAttribute(
      "href",
      ANDROID.url
    );
    expect(screen.queryByRole("link", { name: "下载 Windows 安装包" })).not.toBeInTheDocument();
  });

  it("制品还没推上去时置灰按钮并写明尚未发布，不给一个跳 404 的链接", async () => {
    await renderWithPackages([
      { ...WINDOWS, available: false, sizeBytes: undefined, builtAt: undefined },
    ]);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "下载客户端" }));

    const dialog = await screen.findByRole("dialog");
    expect(screen.getByRole("button", { name: "尚未发布" })).toBeDisabled();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    // 架构是发布约定，包没发也照样能标；只有实测值才留空。
    expect(dialog).toHaveTextContent("x64");
    expect(dialog).toHaveTextContent("未知");
  });

  it("服务端读不到时不假装「没有包」：重试确实会再问一次", async () => {
    const fetchMock = await renderWithPackages(undefined, [WINDOWS, ANDROID]);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "下载客户端" }));

    expect(await screen.findByText("暂时读不到发布信息。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "暂时无法下载" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("link", { name: "下载 Windows 安装包" })).toBeInTheDocument();
  });
});
