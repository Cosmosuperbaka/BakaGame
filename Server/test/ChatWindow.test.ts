import { expect, test } from "bun:test";
import { CLIENT_CHAT_WINDOW, mergeChatWindow } from "../src/shared/ChatWindow";

const message = (id: string, createdAt: number, text = id) => ({ id, createdAt, text });

test("同 id 以后到的为准，结果按时间升序", () => {
  const merged = mergeChatWindow(
    [message("b", 2), message("a", 1)],
    [message("b", 2, "改写"), message("c", 3)]
  );
  expect(merged.map((entry) => [entry.id, entry.text])).toEqual([
    ["a", "a"],
    ["b", "改写"],
    ["c", "c"],
  ]);
});

test("只保留最近的窗口条数", () => {
  const many = Array.from({ length: CLIENT_CHAT_WINDOW + 5 }, (_, index) =>
    message(`m${index}`, index)
  );
  const merged = mergeChatWindow([], many);
  expect(merged).toHaveLength(CLIENT_CHAT_WINDOW);
  expect(merged[0].id).toBe("m5");
  expect(mergeChatWindow(many, [], 3).map((entry) => entry.id)).toEqual([
    `m${CLIENT_CHAT_WINDOW + 2}`,
    `m${CLIENT_CHAT_WINDOW + 3}`,
    `m${CLIENT_CHAT_WINDOW + 4}`,
  ]);
});
