import { describe, expect, test } from "bun:test";
import {
  assertOutboundUrl,
  fetchWithGuardedRedirects,
  isBlockedOutboundHost,
} from "../src/infrastructure/OutboundGuard";

const blocked = [
  "127.0.0.1",
  "10.1.2.3",
  "172.16.0.1",
  "172.31.255.255",
  "192.168.1.1",
  "169.254.169.254",
  "100.64.0.1",
  "100.127.255.255",
  "0.0.0.0",
  "198.18.0.1",
  "224.0.0.1",
  "255.255.255.255",
  "localhost",
  "intranet",
  "db.internal",
  "nas.local",
  "host.localhost",
  "metadata.google.internal",
  "[::1]",
  "[::]",
  "[fe80::1]",
  "[fc00::1]",
  "[fd12::34]",
  "[ff02::1]",
  "[64:ff9b::10.0.0.1]",
  "[::ffff:7f00:1]",
  "[::ffff:169.254.169.254]",
];

const allowed = [
  "lain.bgm.tv",
  "images.invalid",
  "images.example",
  "q1.qlogo.cn",
  "1.1.1.1",
  "8.8.8.8",
  "bangumi.baka.website",
];

/** 按地址表编排假响应，顺带记录请求顺序、init 与被放弃的响应体。 */
const redirectCase = (table: Record<string, { status: number; location?: string }>) => {
  const requested: string[] = [];
  const inits: RequestInit[] = [];
  const cancelled: string[] = [];
  const fetcher = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    requested.push(url);
    inits.push(init ?? {});
    const entry = table[url];
    if (!entry) throw new Error(`未预期的出站地址：${url}`);
    return new Response(
      new ReadableStream<Uint8Array>({
        cancel: () => {
          cancelled.push(url);
        },
      }),
      {
        status: entry.status,
        headers: entry.location ? { location: entry.location } : {},
      }
    );
  };
  return { cancelled, fetcher, inits, requested };
};

describe("出站地址护栏", () => {
  test("内网、链路本地、元数据与保留地址一律拒绝，公网主机放行", () => {
    for (const host of blocked) expect(isBlockedOutboundHost(host)).toBe(true);
    for (const host of allowed) expect(isBlockedOutboundHost(host)).toBe(false);
  });

  test("URL 解析器归一化的等价写法同样落到拒绝侧", () => {
    for (const raw of [
      "http://2130706433/",
      "http://0x7f.1/",
      "http://127.1/",
      "http://[0:0:0:0:0:0:0:1]/",
    ]) {
      expect(() => assertOutboundUrl(raw)).toThrow(/内网|保留/);
    }
    expect(assertOutboundUrl("https://lain.bgm.tv/pic/crt/g/1.jpg").hostname).toBe("lain.bgm.tv");
  });

  test("非 http(s) 与带凭据的地址在下载前拒绝", () => {
    expect(() => assertOutboundUrl("file:///secret.png")).toThrow(/http\(s\)/);
    expect(() => assertOutboundUrl("gopher://1.1.1.1:6379/")).toThrow(/http\(s\)/);
    expect(() => assertOutboundUrl("not-a-url")).toThrow(/无法解析/);
    expect(() => assertOutboundUrl("http://user:pass@1.1.1.1/")).toThrow(/凭据/);
  });

  test("跳转逐跳复核：同源可跟随、跨源与内网一律拒绝，被放弃的响应体不泄漏", async () => {
    const { fetcher, requested, cancelled, inits } = redirectCase({
      "https://img.invalid/a": { status: 302, location: "/b" },
      "https://img.invalid/b": { status: 200 },
    });
    const response = await fetchWithGuardedRedirects(
      fetcher,
      "https://img.invalid/a",
      { headers: { Accept: "image/avif" } },
      { pinOrigin: true }
    );
    expect(response.status).toBe(200);
    expect(requested).toEqual(["https://img.invalid/a", "https://img.invalid/b"]);
    expect(inits.map((init) => init.redirect)).toEqual(["manual", "manual"]);
    expect(inits[0]?.headers).toEqual({ Accept: "image/avif" });
    expect(cancelled).toEqual(["https://img.invalid/a"]);
  });

  test("pinOrigin 时跳转离开同源即失败", async () => {
    const { fetcher, requested } = redirectCase({
      "https://img.invalid/a": { status: 302, location: "https://mirror.invalid/b" },
    });
    await expect(
      fetchWithGuardedRedirects(fetcher, "https://img.invalid/a", {}, { pinOrigin: true })
    ).rejects.toThrow(/离开/);
    expect(requested).toHaveLength(1);
  });

  test("不可信地址的每一跳都要重过内网判定", async () => {
    const { fetcher, requested } = redirectCase({
      "https://img.invalid/a": {
        status: 302,
        location: "http://169.254.169.254/latest/meta-data/",
      },
    });
    await expect(fetchWithGuardedRedirects(fetcher, "https://img.invalid/a")).rejects.toThrow(
      /内网|保留/
    );
    expect(requested).toHaveLength(1);
  });

  test("跳转次数封顶，环路不会把在途请求拖死", async () => {
    const { fetcher, requested } = redirectCase({
      "https://img.invalid/a": { status: 302, location: "/a" },
    });
    await expect(
      fetchWithGuardedRedirects(fetcher, "https://img.invalid/a", {}, { pinOrigin: true })
    ).rejects.toThrow(/跳转次数超限/);
    expect(requested).toHaveLength(4);
  });

  test("非跳转状态带 Location 头也不跟随", async () => {
    const { fetcher, requested } = redirectCase({
      "https://img.invalid/a": { status: 200, location: "http://127.0.0.1/admin" },
    });
    const response = await fetchWithGuardedRedirects(fetcher, "https://img.invalid/a");
    expect(response.status).toBe(200);
    expect(requested).toEqual(["https://img.invalid/a"]);
  });
});
