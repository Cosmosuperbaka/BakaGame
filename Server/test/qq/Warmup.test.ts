import { describe, expect, it, mock, afterEach } from "bun:test";
import { QQMusicProvider } from "../../src/infrastructure/QQMusicProvider";
import qqmusic from "qqmusic-api-enhanced";

const originals = { search: qqmusic.search };
const restore = () => Object.assign(qqmusic, originals);
afterEach(restore);

describe("QQ音乐上游预热（契约对齐网易云 warmUp）", () => {
  it("预热只探测一次匿名上游，重复调用不再发请求", async () => {
    let probes = 0;
    const provider = new QQMusicProvider({ minRequestIntervalMs: 0 });
    qqmusic.search = mock(async () => {
      probes += 1;
      return { status: 200, body: { songs: [] } };
    }) as any;

    await provider.warmUp();
    await provider.warmUp();
    expect(probes).toBe(1);
  });

  it("预热失败只记告警且不钉死重试，也不推进匿名熔断", async () => {
    let probes = 0;
    let succeed = false;
    const warnings: Array<{ message: string; meta: unknown }> = [];
    const provider = new QQMusicProvider({
      minRequestIntervalMs: 0,
      logger: {
        warn: (message: string, meta: unknown) => warnings.push({ message, meta }),
      } as any,
    });
    qqmusic.search = mock(async () => {
      probes += 1;
      if (!succeed) throw new Error("预热抖动");
      return { status: 200, body: { songs: [{ mid: "m", title: "T" }] } };
    }) as any;

    await expect(provider.warmUp()).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toBe("QQ音乐上游预热失败，将在首次请求时重试");

    // 拒绝的 Promise 不留在字段上：下一次预热仍可重试。
    succeed = true;
    await provider.warmUp();
    expect(probes).toBe(2);

    // 预热失败不计入匿名熔断的失败 streak：真实检索仍会回源。
    await expect(provider.search("甲", 5)).resolves.toHaveLength(1);
    expect(probes).toBe(3);
  });
});
