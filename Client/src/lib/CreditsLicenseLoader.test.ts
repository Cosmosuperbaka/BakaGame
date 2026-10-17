import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 虚拟模块在测试里没有真实安装树可扫，用 `vi.hoisted` 提供确定的桶：
 * `r` 桶有 react 的原文，`l` 桶有 left-pad 的空 files，其余包走 null 分支。
 */
const mockState = vi.hoisted(() => {
  const buckets = {
    r: { react: { files: [{ name: "LICENSE", text: "MIT License\n" }] } },
    l: { "left-pad": { files: [] as { name: string; text: string }[] } },
  };
  return {
    buckets,
    loaders: {
      r: vi.fn(async () => buckets.r),
      l: vi.fn(async () => buckets.l),
    },
  };
});

vi.mock("virtual:credits-licenses", () => ({ default: mockState.loaders }));

/** 重新求值模块，清掉上一次用例留下的 Promise 缓存。 */
async function loadModule() {
  vi.resetModules();
  return import("./CreditsLicenseLoader");
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("loadCreditsLicense", () => {
  it("按 licenseBucket 取对应桶的原文，并保持文件顺序", async () => {
    const { loadCreditsLicense } = await loadModule();

    await expect(loadCreditsLicense("react")).resolves.toEqual(mockState.buckets.r.react);
    expect(mockState.loaders.r).toHaveBeenCalledTimes(1);
    expect(mockState.loaders.l).not.toHaveBeenCalled();
  });

  it("包里没有许可证文件时返回原文文档（files 为空数组），不当作失败", async () => {
    const { loadCreditsLicense } = await loadModule();

    await expect(loadCreditsLicense("left-pad")).resolves.toEqual(mockState.buckets.l["left-pad"]);
  });

  it("桶里没有这个包时返回 null，不额外请求别的桶", async () => {
    const { loadCreditsLicense } = await loadModule();

    await expect(loadCreditsLicense("react")).resolves.toEqual(mockState.buckets.r.react);
    await expect(loadCreditsLicense("radix-ui")).resolves.toBeNull();
    expect(mockState.loaders.r).toHaveBeenCalledTimes(1);
  });

  it("同一个包重复读取复用同一个 Promise，不重复加载桶", async () => {
    const { loadCreditsLicense } = await loadModule();

    const first = loadCreditsLicense("react");
    const second = loadCreditsLicense("react");
    expect(second).toBe(first);
    await expect(first).resolves.toEqual(mockState.buckets.r.react);
    expect(mockState.loaders.r).toHaveBeenCalledTimes(1);
  });

  it("失败不落缓存，重试会重新请求同一桶", async () => {
    const { loadCreditsLicense } = await loadModule();
    mockState.loaders.r.mockRejectedValueOnce(new Error("chunk load failed"));

    await expect(loadCreditsLicense("react")).rejects.toThrow("chunk load failed");
    await expect(loadCreditsLicense("react")).resolves.toEqual(mockState.buckets.r.react);
    expect(mockState.loaders.r).toHaveBeenCalledTimes(2);
  });
});
