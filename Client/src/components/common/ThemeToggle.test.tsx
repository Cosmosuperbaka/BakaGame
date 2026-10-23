import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setThemePreference, THEME_STORAGE_KEY } from "@/lib/Theme";
import { ThemeToggle } from "./ThemeToggle";

const resetTheme = () => {
  document.documentElement.classList.remove("dark");
  document.documentElement.style.colorScheme = "";
  localStorage.clear();
  setThemePreference("system");
};

afterEach(() => {
  cleanup();
  resetTheme();
});

describe("ThemeToggle", () => {
  beforeEach(resetTheme);

  it("触发按钮的可访问名读出当前档位", () => {
    setThemePreference("dark");
    render(<ThemeToggle />);
    expect(screen.getByRole("button", { name: "主题：深色" })).toBeInTheDocument();
  });

  it("浮层列出三档全称，每档都带一枚图标", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);
    await user.click(screen.getByRole("button", { name: "主题：跟随系统" }));

    const group = await screen.findByRole("radiogroup", { name: "主题" });
    const options = within(group).getAllByRole("radio");
    // 与触发按钮同一口径的全称：不出现「自动」这类只在浮层里换叫法的简称。
    expect(options.map((option) => option.closest("label")?.textContent)).toEqual([
      "浅色",
      "深色",
      "跟随系统",
    ]);
    for (const option of options) {
      expect(option.closest("label")?.querySelector("svg")).toBeInTheDocument();
    }
  });

  it("选中档位同时写入本地偏好与根元素类名", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);
    await user.click(screen.getByRole("button", { name: "主题：跟随系统" }));

    const group = await screen.findByRole("radiogroup", { name: "主题" });
    await user.click(within(group).getByRole("radio", { name: "浅色" }));

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(within(group).getByRole("radio", { name: "浅色" })).toBeChecked();

    await user.click(within(group).getByRole("radio", { name: "深色" }));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});
