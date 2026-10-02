import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, RouterProvider, createMemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  usePageNavigate,
  usePageTransitionDirection,
  usePageTransitionEnds,
  useSharedElementName,
} from "./UsePageTransition";

/** 浏览器拍快照那一刻的状态：旧页在调用 startViewTransition 时、新页在更新回调完成时。 */
interface Capture {
  direction: string | undefined;
  names: Record<string, string | null>;
}

const nameOf = (node: HTMLElement) => node.style.viewTransitionName || null;

function snapshot(): Capture {
  const names: Record<string, string | null> = {};
  for (const node of document.querySelectorAll<HTMLElement>("[data-shared]")) names[node.dataset.shared!] = nameOf(node);
  return { direction: document.documentElement.dataset.pageDirection, names };
}

function stubViewTransition() {
  const captures: { old?: Capture; new?: Capture } = {};
  const start = vi.fn((update: () => unknown) => {
    captures.old = snapshot();
    const done = Promise.resolve()
      .then(update)
      .then(() => {
        captures.new = snapshot();
      });
    return { finished: done, ready: done, updateCallbackDone: done, skipTransition: vi.fn() };
  });
  Object.defineProperty(document, "startViewTransition", { configurable: true, value: start });
  return { start, captures };
}

function Shared({ id, partner }: { id: string; partner?: string | false }) {
  const name = useSharedElementName("title", partner);
  return <span data-shared={id} style={{ viewTransitionName: name }} />;
}

function Frame({ children }: { children: React.ReactNode }) {
  usePageTransitionDirection();
  return <>{children}</>;
}

function Go({ to, label }: { to: string; label: string }) {
  const navigate = usePageNavigate();
  return <button type="button" onClick={() => navigate(to)}>{label}</button>;
}

function renderRouter(initial: string) {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: (
          <Frame>
            <p>landing</p>
            <Shared id="card-a" partner="/a" />
            <Shared id="card-b" partner="/b" />
            <Go to="/a" label="进入 A" />
          </Frame>
        ),
      },
      {
        path: "/a",
        element: (
          <Frame>
            <p>lobby-a</p>
            <Shared id="lobby-title" partner="/" />
            <Go to="/" label="返回主页" />
          </Frame>
        ),
      },
    ],
    { initialEntries: [initial] },
  );
  render(<RouterProvider router={router} />);
}

afterEach(() => {
  delete (document as { startViewTransition?: unknown }).startViewTransition;
  delete document.documentElement.dataset.pageDirection;
});

describe("usePageNavigate", () => {
  it("前进到更深一层：方向为 forward，两页只给另一端是本次过渡的候选命名", async () => {
    const { start, captures } = stubViewTransition();
    renderRouter("/");

    await userEvent.click(screen.getByRole("button", { name: "进入 A" }));
    expect(await screen.findByText("lobby-a")).toBeInTheDocument();
    await waitFor(() => expect(captures.new).toBeDefined());

    expect(start).toHaveBeenCalledTimes(1);
    // 旧页：去往 /a 的卡片命名，另一张卡片不命名，免得重名或在不相干的过渡里单独淡出。
    expect(captures.old).toEqual({ direction: "forward", names: { "card-a": "title", "card-b": null } });
    // 新页：大厅标题与之同名，两者读作同一个元素。
    expect(captures.new).toEqual({ direction: "forward", names: { "lobby-title": "title" } });
  });

  it("回到更浅一层：方向为 back，过渡结束后撤掉方向与命名", async () => {
    const { captures } = stubViewTransition();
    renderRouter("/a");

    await userEvent.click(screen.getByRole("button", { name: "返回主页" }));
    expect(await screen.findByText("landing")).toBeInTheDocument();
    await waitFor(() => expect(captures.new).toBeDefined());

    expect(captures.old).toEqual({ direction: "back", names: { "lobby-title": "title" } });
    expect(captures.new).toEqual({ direction: "back", names: { "card-a": "title", "card-b": null } });
    await waitFor(() => expect(document.documentElement.dataset.pageDirection).toBeUndefined());
    expect(snapshot().names).toEqual({ "card-a": null, "card-b": null });
  });

  it("不支持 View Transitions 的环境直接换页，不留方向标记", async () => {
    renderRouter("/");

    await userEvent.click(screen.getByRole("button", { name: "进入 A" }));
    expect(await screen.findByText("lobby-a")).toBeInTheDocument();
    expect(document.documentElement.dataset.pageDirection).toBeUndefined();
  });
});

describe("usePageTransitionEnds", () => {
  it("声明式路由（单元测试、Storybook）下不抛错，视为不在过渡中", () => {
    function Probe() {
      const ends = usePageTransitionEnds();
      return <p>{ends ? "transitioning" : "idle"}</p>;
    }
    render(
      <MemoryRouter>
        <Probe />
        <Shared id="solo" />
      </MemoryRouter>,
    );
    expect(screen.getByText("idle")).toBeInTheDocument();
    expect(snapshot().names).toEqual({ solo: null });
  });
});
