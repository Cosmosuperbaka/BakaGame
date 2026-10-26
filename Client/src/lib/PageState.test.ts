import { describe, expect, it, vi } from "vitest";
import { clickByControl, snapshotPageState } from "./PageState";

const mount = (html: string) => {
  document.body.innerHTML = html;
};

describe("页面状态采集", () => {
  it("只带 data-agent-control 标注的控件与可读标签", () => {
    mount(`
      <button data-agent-control="site.game.faker" aria-label="WhoisFaker 开始游戏">开始</button>
      <button>没有标注的按钮</button>
      <input data-agent-control="lobby.search" aria-label="搜索房间" value="机密草稿" />
    `);
    const state = snapshotPageState("/songuessr");
    expect(state.game).toBe("song");
    expect(state.controls.map((control) => control.id)).toEqual([
      "site.game.faker",
      "lobby.search",
    ]);
    // 输入框的值不进上报：只取 aria-label。
    expect(JSON.stringify(state)).not.toContain("机密草稿");
  });

  it("房间页带房间号，关于页按站点页处理", () => {
    mount("");
    expect(snapshotPageState("/cee/room/5678").roomId).toBe("5678");
    expect(snapshotPageState("/abouts").game).toBeUndefined();
  });

  it("找不到控件时返回 false，点得到就真的触发点击", () => {
    mount(`<button data-agent-control="lobby.create">创建房间</button>`);
    const button = document.querySelector("button")!;
    const clicked = vi.fn();
    button.addEventListener("click", clicked);

    expect(clickByControl("lobby.create")).toBe(true);
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(clickByControl("lobby.leave")).toBe(false);
  });
});
