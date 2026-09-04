import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/Tooltip";
import LandingPage from "./LandingPage";
import { formatRelativeTime } from "@/lib/Time";

function renderLandingPage() {
  return render(
    <BrowserRouter>
      <TooltipProvider>
        <LandingPage />
      </TooltipProvider>
    </BrowserRouter>,
  );
}

describe("LandingPage", () => {
  it("renders all three friend links with correct URLs and target attributes", () => {
    renderLandingPage();

    const friendLinks = [
      { name: "二刺猿笑传之猜猜呗", href: "https://ccb.baka.website/" },
      { name: "动漫高手一眼顶针", href: "https://anipeek.animaster.dpdns.org/" },
      { name: "动漫高手截码战", href: "https://decrypto.monight.dpdns.org/" },
    ];

    for (const link of friendLinks) {
      const el = screen.getByRole("link", { name: new RegExp(link.name) });
      expect(el).toBeInTheDocument();
      expect(el).toHaveAttribute("href", link.href);
      expect(el).toHaveAttribute("target", "_blank");
      expect(el).toHaveAttribute("rel", "noreferrer");
    }
  });

  it("renders social links and game entries", () => {
    renderLandingPage();

    expect(screen.getByRole("link", { name: "加入 QQ 群" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "GitHub 仓库" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "作者哔哩哔哩主页" })).toBeInTheDocument();

    expect(screen.getByTestId("game-entry-whoisfaker")).toBeInTheDocument();
    expect(screen.getByTestId("game-entry-songuessr")).toBeInTheDocument();
    expect(screen.getByTestId("game-entry-animecharguessr")).toBeInTheDocument();
  });

  it("renders categorized changelog in modal and omits absent categories", async () => {
    const user = userEvent.setup();
    renderLandingPage();

    const versionButton = screen.getByRole("button", { name: /^V\d+\.\d+\.\d+/ });
    await user.click(versionButton);

    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // 检查存在对应更新的分类 Badge 与条目
    const featBadges = screen.getAllByText("feat");
    expect(featBadges.length).toBeGreaterThan(0);
    expect(screen.getByText("更新日志支持按变更类型分类展示")).toBeInTheDocument();
    expect(screen.getByText("Whoisfaker新增观战频道")).toBeInTheDocument();

    const fixBadges = screen.getAllByText("fix");
    expect(fixBadges.length).toBeGreaterThan(0);

    // 未填写的类型（如 chore、docs）在更新日志中不渲染
    expect(screen.queryByText("chore")).not.toBeInTheDocument();
    expect(screen.queryByText("docs")).not.toBeInTheDocument();
  });

  it("formats relative time correctly using Intl.RelativeTimeFormat", () => {
    const fixedNow = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(fixedNow);

    try {
      // 刚刚 (未来或0)
      expect(formatRelativeTime(new Date(fixedNow + 1000).toISOString())).toBe("刚刚");

      // 秒级
      expect(formatRelativeTime(new Date(fixedNow - 10 * 1000).toISOString())).toBe("10秒钟前");

      // 分钟级
      expect(formatRelativeTime(new Date(fixedNow - 5 * 60 * 1000).toISOString())).toBe("5分钟前");

      // 小时级
      expect(formatRelativeTime(new Date(fixedNow - 3 * 3600 * 1000).toISOString())).toBe("3小时前");

      // 天级
      expect(formatRelativeTime(new Date(fixedNow - 2 * 86400 * 1000).toISOString())).toBe("2天前");

      // 无效输入原样返回
      expect(formatRelativeTime("invalid-date")).toBe("invalid-date");
    } finally {
      nowSpy.mockRestore();
    }
  });
});


