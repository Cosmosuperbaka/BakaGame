import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@bakagame/shared";
import { useUnreadCount } from "./UseUnreadCount";

const ME = "me";
let seq = 0;
const say = (playerId: string, text = "你好"): ChatMessage => {
  seq += 1;
  return {
    id: `m${seq}`,
    playerId,
    playerName: playerId,
    text,
    createdAt: seq * 1000,
    system: false,
  };
};
const notice = (text: string): ChatMessage => ({ ...say("", text), system: true });

const mount = (messages: ChatMessage[] | undefined, open = false) =>
  renderHook(({ messages, open }) => useUnreadCount(messages, { open, selfPlayerId: ME }), {
    initialProps: { messages, open },
  });

describe("useUnreadCount", () => {
  it("进房那一刻已有的历史不算未读，之后别人说的话逐条累加", () => {
    const history = [say("a"), say("b")];
    const view = mount(history);
    expect(view.result.current).toBe(0);

    const next = [...history, say("a")];
    view.rerender({ messages: next, open: false });
    expect(view.result.current).toBe(1);
    view.rerender({ messages: [...next, say("c")], open: false });
    expect(view.result.current).toBe(2);
  });

  it("还没进房（列表为空值）时不计数，进房时的历史整体记为已读", () => {
    const view = mount(undefined);
    expect(view.result.current).toBe(0);
    const history = [say("a"), say("b"), say("c")];
    view.rerender({ messages: history, open: false });
    expect(view.result.current).toBe(0);
    view.rerender({ messages: [...history, say("a")], open: false });
    expect(view.result.current).toBe(1);
  });

  it("空房间里的第一条消息也算未读", () => {
    const view = mount([]);
    view.rerender({ messages: [say("a")], open: false });
    expect(view.result.current).toBe(1);
  });

  it("系统提示与自己发的不算未读", () => {
    const history = [say("a")];
    const view = mount(history);
    view.rerender({
      messages: [...history, notice("小布丁 加入了房间"), say(ME), notice("第 1 天开始")],
      open: false,
    });
    expect(view.result.current).toBe(0);
  });

  it("打开聊天清零；关上以后从打开时看到的最后一条往后数", () => {
    const history = [say("a")];
    const view = mount(history);
    const two = [...history, say("b"), say("c")];
    view.rerender({ messages: two, open: false });
    expect(view.result.current).toBe(2);

    view.rerender({ messages: two, open: true });
    expect(view.result.current).toBe(0);
    view.rerender({ messages: two, open: false });
    expect(view.result.current).toBe(0);

    view.rerender({ messages: [...two, say("a")], open: false });
    expect(view.result.current).toBe(1);
  });

  it("聊天开着时来的消息直接算已读", () => {
    const history = [say("a")];
    const view = mount(history, true);
    const more = [...history, say("b"), say("c")];
    view.rerender({ messages: more, open: true });
    expect(view.result.current).toBe(0);
    view.rerender({ messages: more, open: false });
    expect(view.result.current).toBe(0);
  });

  it("客户端窗口滚掉了最后已读的那条时，按时间先后继续数", () => {
    const first = say("a");
    const read = say("b");
    const view = mount([first, read]);
    // 窗口满了：最早的两条被挤出，只剩之后的三条
    const window = [say("c"), say("d"), say("e")];
    view.rerender({ messages: window, open: false });
    expect(view.result.current).toBe(3);
  });

  it("离开房间再进另一间，重新以进房时的历史为基线", () => {
    const view = mount([say("a")]);
    view.rerender({ messages: [say("a"), say("b")], open: false });
    expect(view.result.current).toBeGreaterThan(0);
    view.rerender({ messages: undefined, open: false });
    expect(view.result.current).toBe(0);
    view.rerender({ messages: [say("x"), say("y")], open: false });
    expect(view.result.current).toBe(0);
  });
});
