import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ToggleChip } from "./ToggleChip";

describe("ToggleChip", () => {
  it("aria-pressed 表达选中，点击交出相反的值", async () => {
    const user = userEvent.setup();
    const onPressedChange = vi.fn();
    const { rerender } = render(
      <ToggleChip pressed={false} onPressedChange={onPressedChange}>
        动画
      </ToggleChip>
    );
    const chip = screen.getByRole("button", { name: "动画" });
    expect(chip).toHaveAttribute("aria-pressed", "false");
    await user.click(chip);
    expect(onPressedChange).toHaveBeenLastCalledWith(true);
    rerender(
      <ToggleChip pressed onPressedChange={onPressedChange}>
        动画
      </ToggleChip>
    );
    expect(chip).toHaveAttribute("aria-pressed", "true");
    await user.click(chip);
    expect(onPressedChange).toHaveBeenLastCalledWith(false);
  });

  it("未选态的描边色可以单独覆盖，选中态不受影响", () => {
    const { rerender } = render(
      <ToggleChip
        pressed={false}
        onPressedChange={() => {}}
        idleClassName="border-muted-foreground/40"
      >
        组件
      </ToggleChip>
    );
    const chip = screen.getByRole("button", { name: "组件" });
    expect(chip.className).toContain("border-muted-foreground/40");
    expect(chip.className).not.toContain("border-border");
    rerender(
      <ToggleChip pressed onPressedChange={() => {}} idleClassName="border-muted-foreground/40">
        组件
      </ToggleChip>
    );
    expect(chip.className).toContain("border-primary/40");
    expect(chip.className).not.toContain("border-muted-foreground/40");
  });
});
