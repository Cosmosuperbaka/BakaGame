import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SitePageCommand } from "@bakagame/shared";
import { getAgentFocus, clearAgentFocus } from "@/stores/UsePageControl";
import { runPageCommand } from "./PageActions";

const navigate = vi.fn();
const scrollIntoView = vi.fn();
let controller: AbortController;

const run = (command: Omit<SitePageCommand, "id">) => {
  const pending = runPageCommand({ id: "1", ...command } as SitePageCommand, {
    navigate,
    signal: controller.signal,
  });
  return vi.runAllTimersAsync().then(() => pending);
};

const mount = (html: string) => {
  document.body.innerHTML = html;
};

beforeEach(() => {
  vi.useFakeTimers();
  navigate.mockReset();
  controller = new AbortController();
  window.history.replaceState(null, "", "/");
  window.scrollTo = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
  clearAgentFocus();
});

describe("Agent 动作", () => {
  it("点击前焦点先落到控件上，走的是页面自己的处理函数", async () => {
    mount(`<button data-agent-control="room.ready">准备</button>`);
    const button = document.querySelector("button")!;
    const order: string[] = [];
    button.addEventListener("pointerdown", () => order.push(`down:${getAgentFocus()?.action}`));
    button.addEventListener("click", (event) => order.push(`click:${event.isTrusted}`));

    const result = await run({ action: "click", control: "room.ready" });
    expect(result).toEqual({ id: "1", ok: true });
    expect(order).toEqual(["down:click", "click:false"]);
    expect(getAgentFocus()).toMatchObject({ element: button, label: "准备" });
  });

  it("屏幕外的目标先滚入视野再移动焦点", async () => {
    mount(`<button data-agent-control="far">远处</button>`);
    const button = document.querySelector("button")!;
    button.getBoundingClientRect = () =>
      ({ top: 5000, bottom: 5040, left: 0, right: 80, width: 80, height: 40 }) as DOMRect;
    await run({ action: "click", control: "far" });
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("逐字输入触发受控组件的 onChange，replace 先清空，超长截断", async () => {
    mount(`<input data-agent-control="chat.input" maxlength="4" value="旧" />`);
    const input = document.querySelector("input")!;
    const seen: string[] = [];
    input.addEventListener("input", () => seen.push(input.value));

    await run({ action: "type", control: "chat.input", text: "你好世界再见", replace: true });
    expect(input.value).toBe("你好世界");
    expect(seen).toEqual(["", "你", "你好", "你好世", "你好世界"]);
    expect(document.activeElement).toBe(input);
  });

  it("type 省略控件时只能写进当前焦点，焦点不是输入框就失败", async () => {
    mount(`<input data-agent-control="a" /><button data-agent-control="b">按钮</button>`);
    await run({ action: "focus", control: "a" });
    await run({ action: "type", text: "嗨" });
    expect(document.querySelector("input")!.value).toBe("嗨");

    await run({ action: "focus", control: "b" });
    const failed = await run({ action: "type", text: "嗨" });
    expect(failed).toMatchObject({ ok: false, error: expect.stringContaining("不是输入框") });
  });

  it("Enter 提交表单、Escape 交给页面的监听，组合键不开放", async () => {
    mount(`<form><input data-agent-control="f" /></form>`);
    const form = document.querySelector("form")!;
    const submitted = vi.fn((event: Event) => event.preventDefault());
    form.addEventListener("submit", submitted);
    const escaped = vi.fn();
    document.addEventListener("keydown", (event) => event.key === "Escape" && escaped());

    await run({ action: "press", control: "f", key: "Enter" });
    await run({ action: "press", control: "f", key: "Escape" });
    expect(submitted).toHaveBeenCalledTimes(1);
    expect(escaped).toHaveBeenCalledTimes(1);
  });

  it("原生下拉按标签或值选中，并触发 change", async () => {
    mount(`
      <select data-agent-control="team">
        <option value="r">红队</option><option value="b">蓝队</option>
      </select>
    `);
    const select = document.querySelector("select")!;
    const changed = vi.fn();
    select.addEventListener("change", changed);
    await run({ action: "select", control: "team", value: "蓝队" });
    expect(select.value).toBe("b");
    expect(changed).toHaveBeenCalledTimes(1);

    const failed = await run({ action: "select", control: "team", value: "绿队" });
    expect(failed).toMatchObject({ ok: false, error: "没有选项：绿队" });
  });

  it("自绘下拉先点开再点选项，两次都是真实控件", async () => {
    mount(`<button role="combobox" data-agent-control="mode">模式</button>`);
    const trigger = document.querySelector("button")!;
    const picked = vi.fn();
    trigger.addEventListener("click", () => {
      const option = document.createElement("div");
      option.setAttribute("role", "option");
      option.textContent = "团队赛";
      option.addEventListener("click", picked);
      document.body.append(option);
    });
    await run({ action: "select", control: "mode", value: "团队赛" });
    expect(picked).toHaveBeenCalledTimes(1);
  });

  it("滑杆按方向键走到目标值", async () => {
    mount(
      `<div role="slider" tabindex="0" aria-valuenow="2" data-agent-control="rounds">回合</div>`
    );
    const slider = document.querySelector<HTMLElement>("[role=slider]")!;
    slider.addEventListener("keydown", (event) => {
      const value = Number(slider.getAttribute("aria-valuenow"));
      slider.setAttribute("aria-valuenow", String(value + (event.key === "ArrowRight" ? 1 : -1)));
    });
    await run({ action: "select", control: "rounds", value: "5" });
    expect(slider.getAttribute("aria-valuenow")).toBe("5");
  });

  it("导航只去可达页面；走前端路由，不整页跳转", async () => {
    await run({ action: "navigate", path: "/cee" });
    expect(navigate).toHaveBeenCalledWith("/cee");
    navigate.mockReset();
    const failed = await run({ action: "navigate", path: "/admin" });
    expect(failed.ok).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("站外链接、下载与敏感页面的链接都拒绝点击", async () => {
    mount(`
      <a href="https://example.com/x" data-agent-control="out">外链</a>
      <a href="/files/a.zip" download data-agent-control="dl">下载</a>
      <a href="/admin" data-agent-control="admin">后台</a>
      <a href="/cee" data-agent-control="ok">大厅</a>
    `);
    expect((await run({ action: "click", control: "out" })).ok).toBe(false);
    expect((await run({ action: "click", control: "dl" })).ok).toBe(false);
    expect((await run({ action: "click", control: "admin" })).ok).toBe(false);
    expect((await run({ action: "click", control: "ok" })).ok).toBe(true);
  });

  it("焦点停在链接上时，回车和空格同样受链接限制，Tab 不受影响", async () => {
    mount(`
      <a href="https://example.com/x" data-agent-control="out">外链</a>
      <a href="/admin" data-agent-control="admin">后台</a>
      <button data-agent-control="next">下一个</button>
    `);
    const clicked = vi.fn((event: Event) => event.preventDefault());
    document.addEventListener("click", clicked);
    await run({ action: "focus", control: "out" });
    expect((await run({ action: "press", key: "Enter" })).ok).toBe(false);
    expect((await run({ action: "press", key: "Space" })).ok).toBe(false);
    expect((await run({ action: "press", key: "Enter", control: "admin" })).ok).toBe(false);
    expect(clicked).not.toHaveBeenCalled();
    await run({ action: "focus", control: "out" });
    expect((await run({ action: "press", key: "Tab" })).ok).toBe(true);
    document.removeEventListener("click", clicked);
  });

  it("受限页面上只能读取和离开，其它动作一律拒绝", async () => {
    window.history.replaceState(null, "", "/admin");
    mount(`<button data-agent-control="danger">删除</button>`);
    const clicked = vi.fn();
    document.querySelector("button")?.addEventListener("click", clicked);
    for (const command of [
      { action: "click", control: "danger" },
      { action: "focus", control: "danger" },
      { action: "press", key: "Enter" },
      { action: "type", text: "x" },
      { action: "scroll", direction: "down" },
    ] as Omit<SitePageCommand, "id">[]) {
      const result = await run(command);
      expect(result.ok).toBe(false);
      expect(result.view?.restricted).toBe(true);
    }
    expect(clicked).not.toHaveBeenCalled();
    expect((await run({ action: "read" })).view?.restricted).toBe(true);
    expect((await run({ action: "navigate", path: "/cee" })).ok).toBe(true);
    expect(navigate).toHaveBeenCalledWith("/cee");
  });

  it("过期 id、禁用与敏感控件都失败，并带上最新画面供 Agent 重新决策", async () => {
    mount(`
      <button data-agent-control="off" disabled>开始</button>
      <div data-agent-sensitive><button data-agent-control="login">登录</button></div>
      <p>当前画面</p>
    `);
    const gone = await run({ action: "click", control: "e999" });
    expect(gone).toMatchObject({ ok: false, error: expect.stringContaining("没有控件") });
    expect(gone.view?.lines).toContain("当前画面");
    expect(await run({ action: "click", control: "off" })).toMatchObject({ ok: false });
    expect(await run({ action: "click", control: "login" })).toMatchObject({ ok: false });
  });

  it("人类收回后立刻停手：逐字输入中途中止，后面的字不再写入", async () => {
    mount(`<input data-agent-control="chat.input" />`);
    const input = document.querySelector("input")!;
    const pending = runPageCommand(
      { id: "1", action: "type", control: "chat.input", text: "字".repeat(60) },
      { navigate, signal: controller.signal }
    );
    // 焦点移动的时长走完，再打一两个字。
    await vi.advanceTimersByTimeAsync(1_500);
    const typed = input.value.length;
    expect(typed).toBeGreaterThan(0);
    expect(typed).toBeLessThan(60);
    controller.abort();
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ ok: false, error: "接管已结束" });
    expect(input.value.length).toBe(typed);
  });

  it("read 只读画面，不碰任何控件", async () => {
    mount(`<p>等待开始</p>`);
    const result = await run({ action: "read" });
    expect(result.view?.lines).toContain("等待开始");
    expect(getAgentFocus()).toMatchObject({ action: "read" });
  });
});
