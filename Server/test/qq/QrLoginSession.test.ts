import { describe, expect, it, mock, afterEach } from "bun:test";
import { QQMusicProvider } from "../../src/infrastructure/QQMusicProvider";
import qqmusic from "qqmusic-api-enhanced";

const originals = {
  login_qr_create: qqmusic.login_qr_create,
  login_qr_check: qqmusic.login_qr_check,
  login_status: qqmusic.login_status,
};
const restore = () => Object.assign(qqmusic, originals);
afterEach(restore);

describe("QQ音乐扫码登录会话（对齐网易云按 key 分桶口径）", () => {
  it("并发扫码登录按会话 key 分桶，各自的轮询拿到各自的凭证", async () => {
    let seq = 0;
    const provider = new QQMusicProvider({ minRequestIntervalMs: 0 });
    qqmusic.login_qr_create = mock(async () => {
      seq += 1;
      return {
        status: 200,
        body: {
          qrsig: `sig-${seq}`,
          ptqrtoken: seq,
          url: `https://qr/${seq}`,
          qrimg: `data:qr${seq}`,
        },
      };
    }) as any;
    qqmusic.login_qr_check = mock(async ({ qrsig }: { qrsig?: string }) => ({
      status: 200,
      body: { code: 200, cookieStr: `qm_keyst=done-${qrsig}` },
    })) as any;
    qqmusic.login_status = mock(async () => ({
      status: 200,
      body: { isLogin: true, account: { userId: "1", nickname: "扫码用户" } },
    })) as any;

    const qrA = await provider.createQrLogin("qq", "qq");
    // 后发起者不会覆盖前者的会话分桶
    const qrB = await provider.createQrLogin("qq", "qq");
    expect(qrA.key).toBe("sig-1:::1");
    expect(qrB.key).toBe("sig-2:::2");

    const resultA = await provider.checkQrLogin(qrA.key, "qq", "qq");
    const resultB = await provider.checkQrLogin(qrB.key, "qq", "qq");
    expect(resultA.status).toBe("authorized");
    expect(resultB.status).toBe("authorized");
    expect(resultA.session?.cookie).toBe("qm_keyst=done-sig-1");
    expect(resultB.session?.cookie).toBe("qm_keyst=done-sig-2");
  });

  it("会话结束（授权完成）后丢弃对应分桶，过期二维码的会话由 TTL 清理", async () => {
    const provider = new QQMusicProvider({ minRequestIntervalMs: 0 });
    qqmusic.login_qr_create = mock(async () => ({
      status: 200,
      body: { qrsig: "sig", ptqrtoken: 1, url: "https://qr", qrimg: "data:qr" },
    })) as any;
    qqmusic.login_qr_check = mock(async () => ({
      status: 200,
      body: { code: 800, message: "二维码已失效" },
    })) as any;
    qqmusic.login_status = mock(async () => {
      throw new Error("过期会话不应触发登录态校验");
    }) as any;

    const qr = await provider.createQrLogin("qq", "qq");
    await expect(provider.checkQrLogin(qr.key, "qq", "qq")).resolves.toMatchObject({
      status: "expired",
    });
  });
});
