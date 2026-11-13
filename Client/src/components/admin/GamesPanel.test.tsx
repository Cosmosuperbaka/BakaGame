import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDLE_SEARCH_MS } from "@/hooks/UseIdleSearch";
import { GamesPanel } from "./GamesPanel";

const games = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn() }));

vi.mock("@/lib/Api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/Api")>()),
  api: { admin: { games } },
}));

beforeEach(() => games.list.mockResolvedValue({ items: [], total: 0 }));
afterEach(() => vi.clearAllMocks());

describe("对局记录的房间号筛选", () => {
  it("连续输入只在停下后请求一次，且去掉首尾空白", async () => {
    const events = userEvent.setup();
    render(<GamesPanel />);
    await screen.findByText("没有符合条件的对局");
    expect(games.list).toHaveBeenCalledTimes(1);

    await events.type(screen.getByLabelText("房间号"), " ABCD ");
    // 每个按键都立即请求的话，这里已经多出好几次。
    expect(games.list).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(games.list).toHaveBeenCalledTimes(2), {
      timeout: IDLE_SEARCH_MS + 1000,
    });
    expect(games.list).toHaveBeenLastCalledWith({ roomId: "ABCD", limit: 20, offset: 0 });
  });
});
