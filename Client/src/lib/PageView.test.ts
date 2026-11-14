import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findPageControl, isOperable, readPageView } from "./PageView";

const mount = (html: string) => {
  document.body.innerHTML = html;
};

beforeEach(() => {
  window.history.replaceState(null, "", "/whoisfaker/room/1234");
  document.title = "BakaGame";
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Agent 看到的页面", () => {
  it("返回可见文字、控件与位置，不含隐藏内容", () => {
    mount(`
      <main>
        <h1>等待开始</h1>
        <p>你的词语是 <strong>苹果</strong></p>
        <p hidden>隐藏属性</p>
        <p style="display:none">不显示</p>
        <p style="visibility:hidden">不可见</p>
        <p style="opacity:0">全透明</p>
        <p style="filter:blur(4px)">模糊遮挡</p>
        <p aria-hidden="true">对读屏隐藏</p>
        <span class="sr" style="position:absolute;width:1px;height:1px">屏幕阅读器专用</span>
        <script>const secret = "脚本";</script>
        <button data-agent-control="room.ready">准备</button>
      </main>
    `);
    const view = readPageView();
    expect(view).toMatchObject({ path: "/whoisfaker/room/1234", game: "faker", roomId: "1234" });
    expect(view.lines).toContain("等待开始");
    expect(view.lines).toContain("你的词语是 苹果");
    for (const hidden of ["隐藏属性", "不显示", "不可见", "全透明", "模糊遮挡", "对读屏隐藏"])
      expect(view.lines.join("\n")).not.toContain(hidden);
    expect(view.lines.join("\n")).not.toContain("屏幕阅读器专用");
    expect(view.lines.join("\n")).not.toContain("脚本");
    expect(view.controls).toEqual([
      expect.objectContaining({ id: "room.ready", role: "button", label: "准备" }),
    ]);
  });

  it("对人不可见的控件，Agent 既看不到也操作不了（模糊遮挡、压成一个像素）", () => {
    mount(`
      <div style="filter:blur(4px)">
        <button data-agent-control="room.answer">答案</button>
      </div>
      <div style="position:absolute;width:1px;height:1px">
        <button data-agent-control="room.clip">屏幕阅读器专用</button>
      </div>
      <button data-agent-control="room.ready">准备</button>
    `);
    const view = readPageView();
    expect(view.controls.map((control) => control.id)).toEqual(["room.ready"]);
    // 语义名是可猜的：看不到的控件即使猜中了名字也必须找不到。
    expect(findPageControl("room.answer")).toBeNull();
    expect(findPageControl("room.clip")).toBeNull();
    expect(
      isOperable(document.querySelector<HTMLElement>("[data-agent-control='room.answer']")!)
    ).toBe(false);
    expect(findPageControl("room.ready")).not.toBeNull();
  });

  it("敏感区域与接管层对 Agent 不存在：读不到，也操作不了", () => {
    mount(`
      <section data-agent-sensitive>
        <p>配对码 ABCD2345</p>
        <button data-agent-control="site.login">登录</button>
      </section>
      <div data-agent-layer>
        <button data-agent-control="takeover.release">收回控制</button>
      </div>
      <button data-agent-control="room.ready">准备</button>
    `);
    const view = readPageView();
    expect(view.lines.join("\n")).not.toContain("ABCD2345");
    expect(view.controls.map((control) => control.id)).toEqual(["room.ready"]);
    expect(findPageControl("site.login")).toBeNull();
    expect(findPageControl("takeover.release")).toBeNull();
    expect(findPageControl("room.ready")).not.toBeNull();
  });

  it("密码框只报存在，不报内容；普通输入框报当前值与状态", () => {
    mount(`
      <label for="pw">房间密码</label><input id="pw" type="password" value="hunter2" />
      <input aria-label="聊天" value="大家好" />
      <input type="checkbox" aria-label="观战" checked />
      <button disabled>开始</button>
    `);
    const { controls } = readPageView();
    const password = controls.find((control) => control.role === "password");
    expect(password).toMatchObject({ label: "房间密码" });
    expect(password).not.toHaveProperty("value");
    expect(JSON.stringify(controls)).not.toContain("hunter2");
    expect(controls.find((control) => control.label === "聊天")?.value).toBe("大家好");
    expect(controls.find((control) => control.label === "观战")?.states).toContain("checked");
    expect(controls.find((control) => control.label === "开始")?.states).toContain("disabled");
  });

  it("下拉带选项，图片带替代文字，没有语义的元素靠 id 也能看到", () => {
    mount(`
      <select aria-label="队伍"><option>红队</option><option selected>蓝队</option></select>
      <img alt="角色立绘" />
      <div data-agent-control="room.card"><span>房间 1234</span></div>
    `);
    const view = readPageView();
    const select = view.controls.find((control) => control.role === "select");
    expect(select).toMatchObject({ value: "蓝队", options: ["红队", "蓝队"] });
    expect(view.lines.join("\n")).toContain("[图片：角色立绘]");
    expect(view.lines.join("\n")).toContain("房间 1234");
    expect(view.controls.map((control) => control.id)).toContain("room.card");
  });

  it("同一语义 id 的第二份控件退回短 id，两份都能找到", () => {
    mount(`
      <button data-agent-control="chat.send">发送</button>
      <button data-agent-control="chat.send">发送</button>
    `);
    const ids = readPageView().controls.map((control) => control.id);
    expect(ids[0]).toBe("chat.send");
    expect(ids[1]).toMatch(/^e\d+$/);
    expect(findPageControl(ids[1]!)).not.toBeNull();
  });

  it("不可达页面只留路径：管理后台的内容一个字都不出去", () => {
    window.history.replaceState(null, "", "/admin");
    mount(`<h1>用户管理</h1><button>封禁</button>`);
    const view = readPageView();
    expect(view).toMatchObject({ path: "/admin", restricted: true, lines: [], controls: [] });
  });

  it("文本总量封顶并标记截断，不让一页撑爆通道", () => {
    mount(
      Array.from({ length: 400 }, (_, index) => `<p>第 ${index} 行 ${"字".repeat(120)}</p>`).join(
        ""
      )
    );
    const view = readPageView();
    expect(view.truncated).toBe(true);
    expect(JSON.stringify(view).length).toBeLessThan(64 * 1024);
  });

  it("弹窗打开时报告标题；敏感弹窗只说受限，内容也读不到", () => {
    mount(`<div role="dialog" aria-label="创建房间"><p>房间名</p></div>`);
    expect(readPageView().dialog).toBe("创建房间");
    mount(`
      <div data-agent-sensitive><div role="dialog" aria-label="登录"><p>验证码</p></div></div>
    `);
    const view = readPageView();
    expect(view.dialog).toBe("受限内容");
    expect(view.lines).toEqual([]);
  });

  it("隐藏与被遮挡的控件不可操作", () => {
    mount(`
      <div aria-hidden="true"><button id="behind">背后</button></div>
      <div inert><button id="inert">惰性</button></div>
      <button id="ok">可用</button>
    `);
    expect(isOperable(document.getElementById("behind")!)).toBe(false);
    expect(isOperable(document.getElementById("inert")!)).toBe(false);
    expect(isOperable(document.getElementById("ok")!)).toBe(true);
  });

  it("玩法归属与房号按路径登记表判定，三款房间页与结尾斜杠都认", () => {
    mount("<main><p>正文</p></main>");
    const at = (path: string) => {
      window.history.replaceState(null, "", path);
      return readPageView();
    };
    expect(at("/whoisfaker/room/1234")).toMatchObject({ game: "faker", roomId: "1234" });
    expect(at("/songuessr/room/ab_cd-12")).toMatchObject({ game: "song", roomId: "ab_cd-12" });
    expect(at("/cee/room/1234")).toMatchObject({ game: "cee", roomId: "1234" });
    expect(at("/whoisfaker/room/1234/")).toMatchObject({ game: "faker", roomId: "1234" });
    expect(at("/songuessr/solo")).toMatchObject({ game: "song" });
    expect(at("/songuessr/solo").roomId).toBeUndefined();
    // 站点页可达但不属于任何一款；排位赛不可达，连玩法归属都不报。
    expect(at("/abouts").game).toBeUndefined();
    expect(at("/cee/ranked")).toMatchObject({ restricted: true });
    expect(at("/cee/ranked").game).toBeUndefined();
  });
});
