import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { CCBRoomPanel } from "./CCBRoomPanel";

it("侧栏把键盘焦点留在面板内并允许按退出键关闭", async () => {
  const user = userEvent.setup();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  function Example() {
    const [panel, setPanel] = useState<"chat" | null>("chat");
    return <><button>背景操作</button><CCBRoomPanel panel={panel} title="聊天" onClose={() => setPanel(null)}><input aria-label="聊天消息" /></CCBRoomPanel></>;
  }
  try {
    render(<Example />);
    await user.click(screen.getByRole("textbox", { name: "聊天消息" }));
    await user.tab();
    expect(screen.getByRole("button", { name: "关闭面板" })).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "背景操作" })).toBeInTheDocument();
  } finally { vi.unstubAllGlobals(); }
});
