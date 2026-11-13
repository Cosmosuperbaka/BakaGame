import { describe, expect, it, vi } from "vitest";
import type { SonGuessrSendCommand } from "@/lib/SonGuessrWs";
import { SongQrLogin, type QrLoginDeps } from "./SongQrLogin";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const qr = (key: string) => ({
  key,
  qrUrl: `https://example.invalid/${key}`,
  qrImage: `img-${key}`,
});

function setup(send: (type: string, payload?: unknown) => Promise<unknown>) {
  const onAuthorized = vi.fn<QrLoginDeps["onAuthorized"]>();
  const onCreateFailed = vi.fn<QrLoginDeps["onCreateFailed"]>();
  const sendSpy = vi.fn(send);
  const login = new SongQrLogin({
    send: sendSpy as unknown as SonGuessrSendCommand,
    onAuthorized,
    onCreateFailed,
  });
  return { login, send: sendSpy, onAuthorized, onCreateFailed };
}

describe("SongQrLogin 扫码登录状态机", () => {
  it("生成二维码：忙碌期间 busy，成功后带二维码与对应平台的扫码提示", async () => {
    const pending = deferred<ReturnType<typeof qr>>();
    const { login, send } = setup(() => pending.promise);

    const started = login.start("netease", "qq");
    expect(login.getSnapshot()).toMatchObject({ busy: true, qr: null });
    pending.resolve(qr("a"));
    await started;

    expect(send).toHaveBeenCalledWith("song.auth.qr.create");
    expect(login.getSnapshot()).toEqual({
      qr: qr("a"),
      status: "请使用网易云音乐 App 扫码",
      busy: false,
    });
  });

  it.each([
    ["qq", "请使用手机 QQ 扫码"],
    ["wx", "请使用微信扫码"],
    ["mobile", "请使用 QQ 音乐 App 扫码"],
  ] as const)("QQ 音乐按扫码方式 %s 发请求并换提示", async (mode, prompt) => {
    const { login, send } = setup(async () => qr("q"));
    await login.start("qq", mode);
    expect(send).toHaveBeenCalledWith("song.auth.qr.create", { platform: "qq", type: mode });
    expect(login.getSnapshot().status).toBe(prompt);
  });

  it("生成失败：状态行写原因、通知调用方、busy 复位", async () => {
    const { login, onCreateFailed } = setup(async () => {
      throw new Error("上游繁忙");
    });
    await login.start("netease", "qq");
    expect(login.getSnapshot()).toMatchObject({ qr: null, status: "上游繁忙", busy: false });
    expect(onCreateFailed).toHaveBeenCalledWith("上游繁忙");
  });

  it("并发两次扫码：先发的迟到回包（成功或失败）都不得覆盖后发的", async () => {
    const first = deferred<ReturnType<typeof qr>>();
    const second = deferred<ReturnType<typeof qr>>();
    const replies = [first.promise, second.promise];
    const { login, onCreateFailed } = setup(() => replies.shift()!);

    const a = login.start("netease", "qq");
    const b = login.start("netease", "qq");
    second.resolve(qr("new"));
    await b;
    expect(login.getSnapshot().qr).toEqual(qr("new"));

    first.reject(new Error("旧的失败"));
    await a;
    expect(login.getSnapshot()).toMatchObject({ qr: qr("new"), busy: false });
    expect(onCreateFailed).not.toHaveBeenCalled();
  });

  it("并发两次扫码：先发的迟到成功回包同样被丢弃", async () => {
    const first = deferred<ReturnType<typeof qr>>();
    const second = deferred<ReturnType<typeof qr>>();
    const replies = [first.promise, second.promise];
    const { login } = setup(() => replies.shift()!);

    const a = login.start("netease", "qq");
    const b = login.start("netease", "qq");
    second.resolve(qr("new"));
    await b;
    first.resolve(qr("old"));
    await a;
    expect(login.getSnapshot().qr).toEqual(qr("new"));
  });

  describe("核对扫码状态", () => {
    const started = async (reply: (type: string, payload?: unknown) => Promise<unknown>) => {
      const result = setup(async (type, payload) =>
        type === "song.auth.qr.create" ? qr("k1") : reply(type, payload)
      );
      await result.login.start("netease", "qq");
      return result;
    };

    it("还在等待：保留二维码，状态行取服务端说明，缺省写等待扫码", async () => {
      const { login } = await started(async () => ({ status: "waiting", message: "已扫码待确认" }));
      await login.check("netease", "qq");
      expect(login.getSnapshot()).toMatchObject({ qr: qr("k1"), status: "已扫码待确认" });

      const empty = await started(async () => ({ status: "waiting", message: "" }));
      await empty.login.check("netease", "qq");
      expect(empty.login.getSnapshot().status).toBe("等待扫码");
    });

    it("过期：丢掉二维码并提示刷新", async () => {
      const { login } = await started(async () => ({ status: "expired", message: "x" }));
      await login.check("netease", "qq");
      expect(login.getSnapshot()).toMatchObject({ qr: null, status: "二维码已过期，请点击刷新" });
    });

    it("授权成功：交出凭据、清二维码，之后迟到的核对不再生效", async () => {
      const { login, onAuthorized, send } = await started(async () => ({
        status: "authorized",
        message: "ok",
        cookie: "MUSIC_U=fixture",
        account: { nickname: "夹具" },
      }));
      await login.check("netease", "qq");
      expect(send).toHaveBeenLastCalledWith("song.auth.qr.check", { key: "k1" });
      expect(onAuthorized).toHaveBeenCalledWith("netease", {
        cookie: "MUSIC_U=fixture",
        account: { nickname: "夹具" },
      });
      expect(login.getSnapshot()).toMatchObject({ qr: null, status: "登录成功" });

      await login.check("netease", "qq");
      expect(onAuthorized).toHaveBeenCalledTimes(1);
    });

    it("授权回包缺凭据时不落盘，也不清二维码", async () => {
      const { login, onAuthorized } = await started(async () => ({
        status: "authorized",
        message: "缺字段",
      }));
      await login.check("netease", "qq");
      expect(onAuthorized).not.toHaveBeenCalled();
      expect(login.getSnapshot().qr).toEqual(qr("k1"));
    });

    it("QQ 音乐核对带上平台与扫码方式", async () => {
      const { login, send } = setup(async (type) =>
        type === "song.auth.qr.create" ? qr("q1") : { status: "waiting", message: "" }
      );
      await login.start("qq", "wx");
      await login.check("qq", "wx");
      expect(send).toHaveBeenLastCalledWith("song.auth.qr.check", {
        key: "q1",
        platform: "qq",
        type: "wx",
      });
    });

    it("上一次核对没回来时不重复发", async () => {
      const slow = deferred<unknown>();
      const { login, send } = await started(() => slow.promise);
      const first = login.check("netease", "qq");
      await login.check("netease", "qq");
      expect(send.mock.calls.filter(([type]) => type === "song.auth.qr.check")).toHaveLength(1);
      slow.resolve({ status: "waiting", message: "" });
      await first;
    });

    it("核对在途时刷新或取消：旧回包（含授权）整个丢弃", async () => {
      const slow = deferred<unknown>();
      const { login, onAuthorized } = await started(() => slow.promise);
      const checking = login.check("netease", "qq");
      login.cancel();
      slow.resolve({
        status: "authorized",
        message: "ok",
        cookie: "MUSIC_U=old",
        account: { nickname: "旧" },
      });
      await checking;
      expect(onAuthorized).not.toHaveBeenCalled();
      expect(login.getSnapshot()).toMatchObject({ qr: null, busy: false });
    });

    it("取消后可以再核对新二维码：旧核对留下的占位不会卡住新轮询", async () => {
      const slow = deferred<unknown>();
      let created = 0;
      const { login, send } = setup(async (type) => {
        if (type === "song.auth.qr.create") return qr(`k${++created}`);
        return created === 1 ? slow.promise : { status: "waiting", message: "" };
      });
      await login.start("netease", "qq");
      const stale = login.check("netease", "qq");
      await login.start("netease", "qq");
      await login.check("netease", "qq");
      expect(send.mock.calls.filter(([type]) => type === "song.auth.qr.check")).toHaveLength(2);
      slow.resolve({ status: "waiting", message: "" });
      await stale;
    });

    it.each([
      ["MUSIC_LOGIN_RISK", "网易云暂时拒绝了本次登录，请稍后重新扫码", true],
      ["MUSIC_LOGIN_CANCELLED", "对方取消了登录", true],
      ["MUSIC_LOGIN_FAILED", "对方取消了登录", true],
      ["MUSIC_SESSION_INVALID", "对方取消了登录", true],
      ["RATE_LIMITED", "对方取消了登录", false],
    ])("核对报错 %s：终态丢码，其余错误只更新提示继续轮询", async (code, text, terminal) => {
      const { login } = await started(async () => {
        throw Object.assign(new Error("对方取消了登录"), { code });
      });
      await login.check("netease", "qq");
      expect(login.getSnapshot().status).toBe(text);
      expect(login.getSnapshot().qr === null).toBe(terminal);
    });

    it("QQ 音乐被风控的提示写 QQ 音乐", async () => {
      const { login } = setup(async (type) => {
        if (type === "song.auth.qr.create") return qr("q");
        throw Object.assign(new Error("x"), { code: "MUSIC_LOGIN_RISK" });
      });
      await login.start("qq", "qq");
      await login.check("qq", "qq");
      expect(login.getSnapshot().status).toBe("QQ音乐暂时拒绝了本次登录，请稍后重新扫码");
    });
  });

  it("卸载后在途请求回来什么都不做", async () => {
    const pending = deferred<ReturnType<typeof qr>>();
    const { login } = setup(() => pending.promise);
    const started = login.start("netease", "qq");
    login.dispose();
    pending.resolve(qr("late"));
    await started;
    expect(login.getSnapshot().qr).toBeNull();
  });

  it("订阅方在每次状态变化时被通知，取消订阅后不再通知", async () => {
    const { login } = setup(async () => qr("a"));
    const listener = vi.fn();
    const off = login.subscribe(listener);
    await login.start("netease", "qq");
    expect(listener).toHaveBeenCalled();
    listener.mockClear();
    off();
    login.cancel();
    expect(listener).not.toHaveBeenCalled();
  });

  describe("退出时的服务端清除", () => {
    it("成功：返回 cleared，QQ 带平台参数", async () => {
      const { login, send } = setup(async () => ({}));
      expect(await login.clear("qq")).toBe("cleared");
      expect(send).toHaveBeenCalledWith("song.auth.clear", { platform: "qq" });
      expect(await login.clear("netease")).toBe("cleared");
      expect(send).toHaveBeenLastCalledWith("song.auth.clear");
      expect(login.getSnapshot().busy).toBe(false);
    });

    it("失败：返回 failed，busy 复位，调用方据此保留本机凭据", async () => {
      const { login } = setup(async () => {
        throw new Error("断线");
      });
      expect(await login.clear("netease")).toBe("failed");
      expect(login.getSnapshot().busy).toBe(false);
    });

    it("等待期间被取代：返回 superseded", async () => {
      const slow = deferred<unknown>();
      const { login } = setup(() => slow.promise);
      const clearing = login.clear("netease");
      expect(login.getSnapshot().busy).toBe(true);
      login.cancel();
      slow.resolve({});
      expect(await clearing).toBe("superseded");
    });
  });
});
