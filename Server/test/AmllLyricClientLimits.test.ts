import { describe, expect, it } from "bun:test";
import { AmllLyricClient } from "../src/infrastructure/music/AmllLyricClient";
import { MusicCache } from "../src/infrastructure/music/MusicCache";
import { amllResponse, amllTtmlFixture } from "./netease/Fixtures";

const createClient = (fetcher: (input: string, init?: RequestInit) => Promise<Response>) =>
  new AmllLyricClient({
    idQueryParam: "ncmMusicId",
    cacheTtlMs: 60_000,
    cache: new MusicCache({ now: () => Date.now(), isUpstreamBusy: () => false }),
    requestTimeoutMs: 200,
    fetcher,
  });

describe("AMLL 歌词客户端：出站边界", () => {
  it("请求不自动跟随跳转", async () => {
    let init: RequestInit | undefined;
    const client = createClient(async (_url, requestInit) => {
      init = requestInit;
      return amllResponse();
    });
    expect(await client.getTtmlLyrics("1", {})).toBe(amllTtmlFixture());
    expect(init?.redirect).toBe("error");
  });

  it("声明体积超限的响应被拒绝，且不当作确定缺失缓存", async () => {
    let calls = 0;
    const client = createClient(async () => {
      calls += 1;
      return new Response("{}", { headers: { "content-length": String(50 * 1024 * 1024) } });
    });
    expect(await client.getTtmlLyrics("1", {})).toBeUndefined();
    expect(await client.getTtmlLyrics("1", {})).toBeUndefined();
    expect(calls).toBe(2);
  });

  it("没有声明长度的流式响应超过上限后同样被拒绝", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    const client = createClient(
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(chunk);
            },
          })
        )
    );
    expect(await client.getTtmlLyrics("1", {})).toBeUndefined();
  });

  it("请求超过时限后当次降级为空，不无限等待", async () => {
    const client = createClient(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason as Error));
        })
    );
    expect(await client.getTtmlLyrics("1", {})).toBeUndefined();
  });
});
