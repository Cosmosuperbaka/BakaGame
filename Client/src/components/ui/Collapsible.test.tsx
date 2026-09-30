import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Collapsible } from "./Collapsible";

describe("Collapsible", () => {
  it("收起时内容已卸载，aria-controls 只在展开时指向内容区", async () => {
    render(<Collapsible title="角色简介"><p>简介正文</p></Collapsible>);
    const toggle = screen.getByRole("button", { name: "角色简介" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).not.toHaveAttribute("aria-controls");
    expect(screen.queryByText("简介正文")).not.toBeInTheDocument();

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const contentId = toggle.getAttribute("aria-controls") ?? "";
    expect(contentId).not.toBe("");
    expect(document.getElementById(contentId)).toContainElement(screen.getByText("简介正文"));

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).not.toHaveAttribute("aria-controls");
  });

  it("defaultOpen 时首次渲染即展开", () => {
    render(<Collapsible title="角色简介" defaultOpen><p>简介正文</p></Collapsible>);
    const toggle = screen.getByRole("button", { name: "角色简介" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById(toggle.getAttribute("aria-controls") ?? "")).toContainElement(screen.getByText("简介正文"));
  });
});
