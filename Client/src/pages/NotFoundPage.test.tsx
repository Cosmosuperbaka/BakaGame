import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import NotFoundPage from "./NotFoundPage";

// 这一页的职责就是对人和抓取器都说清「这里没有页面」：正文之外，禁止收录的标记也得在。
// 端到端规格里有同样的断言，这里再守一层，单测阶段就能发现。
describe("NotFoundPage", () => {
  const renderAt = (path: string) =>
    render(
      <MemoryRouter initialEntries={[path]}>
        <NotFoundPage />
      </MemoryRouter>
    );

  it("说明页面不存在并给出回首页的真链接", () => {
    renderAt("/no-such-page");
    expect(screen.getByRole("heading", { name: "页面不存在" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "回到首页" })).toHaveAttribute("href", "/");
  });

  it("标记禁止收录：乱码地址不该进索引", async () => {
    renderAt("/no-such-page");
    await waitFor(() =>
      expect(document.head.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe(
        "noindex,follow"
      )
    );
  });
});
