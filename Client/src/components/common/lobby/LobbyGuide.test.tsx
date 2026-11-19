import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { findPageMeta } from "@/data/PageMeta";
import { LobbyGuide } from "./LobbyGuide";

const meta = findPageMeta("/cee")!;
const region = () =>
  document.getElementById(
    screen.getByRole("button", { name: "玩法说明" }).getAttribute("aria-controls")!
  )!;

describe("LobbyGuide", () => {
  // 外壳在首帧前被清空，执行脚本的抓取器读到的正文只有这里：收起时也必须留在 DOM 里。
  it("默认收起，正文仍在页面上，只是以 until-found 藏起", () => {
    render(<LobbyGuide path="/cee" />);
    const toggle = screen.getByRole("button", { name: "玩法说明" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(region()).toHaveAttribute("hidden", "until-found");
    expect(region()).toHaveTextContent(meta.shell.sections![0].heading);
    expect(region()).toHaveTextContent(meta.faq[0].q);
    expect(region()).toHaveTextContent(meta.faq[0].a);
  });

  // 文案与静态外壳同源：外壳的每一段正文与每条问答都要出现，不另写一份。
  it("正文与问答逐条取自 PageMeta", () => {
    render(<LobbyGuide path="/cee" />);
    const text = region().textContent ?? "";
    for (const paragraph of meta.shell.paragraphs) expect(text).toContain(paragraph);
    for (const section of meta.shell.sections ?? []) {
      expect(text).toContain(section.heading);
      for (const paragraph of section.paragraphs) expect(text).toContain(paragraph);
    }
    for (const item of meta.faq) expect(text).toContain(item.a);
  });

  it("键盘展开与收起，展开时不再藏起", async () => {
    const user = userEvent.setup();
    render(<LobbyGuide path="/cee" />);
    const toggle = screen.getByRole("button", { name: "玩法说明" });
    toggle.focus();
    await user.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(region()).not.toHaveAttribute("hidden");
    await user.keyboard(" ");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    // 收起动画播完才藏起来
    await waitFor(() => expect(region()).toHaveAttribute("hidden", "until-found"));
  });

  it("页内查找命中时（beforematch）同步成展开态", () => {
    render(<LobbyGuide path="/cee" />);
    act(() => {
      fireEvent(region(), new Event("beforematch"));
    });
    expect(screen.getByRole("button", { name: "玩法说明" })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
  });

  it("未登记的路径不渲染", () => {
    const { container } = render(<LobbyGuide path="/nowhere" />);
    expect(container).toBeEmptyDOMElement();
  });
});
