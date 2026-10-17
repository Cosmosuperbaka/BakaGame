import { useState } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/Tooltip";
import type { ContributingCompany, CreditLicenseDocument } from "@/lib/Credits";
import { CreditsView, type CreditsTab } from "./CreditsView";
import {
  CREDITS_FIXTURE_CHANGELOG,
  CREDITS_FIXTURE_COMMITS,
  CREDITS_FIXTURE_DEPENDENCIES,
  CREDITS_FIXTURE_TECH_STACK,
  loadFixtureLicense,
} from "./CreditsFixtures";

const MODELS: readonly ContributingCompany[] = [
  {
    company: "Beta",
    models: [
      { name: "Beta 后发", releasedAt: "2026-06-01" },
      { name: "Beta 先发", releasedAt: "2026-01-01" },
    ],
  },
  {
    company: "Alpha",
    models: [{ name: "Alpha 唯一", releasedAt: "2026-02-01" }],
  },
];

function renderView({
  onTabChange = vi.fn(),
  loadLicense = loadFixtureLicense,
}: {
  onTabChange?: (tab: CreditsTab) => void;
  loadLicense?: (packageName: string) => Promise<CreditLicenseDocument | null>;
} = {}) {
  function Harness() {
    const [tab, setTab] = useState<CreditsTab>("credits");
    return (
      <TooltipProvider>
        <CreditsView
          tab={tab}
          onTabChange={(next) => {
            setTab(next);
            onTabChange(next);
          }}
          onBack={() => {}}
          versionLabel="V1.2.0"
          commitLabel="3ee6998"
          dependencies={CREDITS_FIXTURE_DEPENDENCIES}
          models={MODELS}
          techStack={CREDITS_FIXTURE_TECH_STACK}
          changelogEntries={CREDITS_FIXTURE_CHANGELOG}
          commits={CREDITS_FIXTURE_COMMITS}
          loadLicense={loadLicense}
        />
      </TooltipProvider>
    );
  }
  return render(<Harness />);
}

describe("CreditsView", () => {
  it("按「开源致谢 / 更新日志 / 提交历史」排列标签，并在切换时回调", async () => {
    const user = userEvent.setup();
    const onTabChange = vi.fn();
    renderView({ onTabChange });

    const tabs = screen.getAllByRole("tab").map((tab) => tab.textContent);
    expect(tabs).toEqual(["开源致谢", "更新日志", "提交历史"]);
    expect(screen.getByRole("heading", { name: "贡献模型" })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "更新日志" }));
    expect(onTabChange).toHaveBeenCalledWith("changelog");
    expect(await screen.findByText("新增开源致谢页，集中展示贡献模型、核心技术栈与依赖清单")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "提交历史" }));
    expect(onTabChange).toHaveBeenCalledWith("commits");
    expect(await screen.findByText("fix(Song): 统一主题曲类型判定并加固专辑错配防线")).toBeInTheDocument();
  });

  it("贡献模型按数据文件的公司顺序分组，组内按发布时间排序且只显示名称", async () => {
    renderView();

    const groups = screen.getAllByTestId(/^credits-company-/);
    expect(groups.map((group) => group.getAttribute("data-testid"))).toEqual([
      "credits-company-Beta",
      "credits-company-Alpha",
    ]);

    const betaModels = within(groups[0]).getAllByRole("listitem").map((item) => item.textContent);
    expect(betaModels).toEqual(["Beta 先发", "Beta 后发"]);
    // releasedAt 只参与排序，不展示。
    expect(screen.queryByText("2026-01-01")).not.toBeInTheDocument();
  });

  it("贡献模型在核心技术栈上方，技术栈版本取自依赖清单", () => {
    renderView();

    const models = screen.getByRole("heading", { name: "贡献模型" });
    const tech = screen.getByRole("heading", { name: "核心技术栈" });
    expect(models.compareDocumentPosition(tech) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // CORE_TECH_STACK 的 React 一条从依赖清单的 react 行取到实际版本。
    const reactCard = screen.getByRole("link", { name: /React/ });
    expect(within(reactCard).getByText("v19.3.0")).toBeInTheDocument();
  });

  it("点击依赖行打开许可证抽屉，加载完成后展示原文，关闭后焦点回到该行", async () => {
    const user = userEvent.setup();
    renderView();

    const row = screen.getByRole("button", { name: /^查看 react v/ });
    await user.click(row);

    const dialog = await screen.findByRole("dialog", { name: "react" });
    expect(await within(dialog).findByText("LICENSE")).toBeInTheDocument();
    expect(dialog.querySelector("pre")?.textContent).toContain("MIT License");
    expect(within(dialog).getByText("NOTICE")).toBeInTheDocument();
    expect(within(dialog).getByText("界面与组件树。")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "关闭面板" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(row).toHaveFocus());
  });

  it("包里没有原文时在抽屉里给出说明", async () => {
    const user = userEvent.setup();
    renderView();

    await user.click(screen.getByRole("button", { name: /^查看 left-pad v/ }));
    const dialog = await screen.findByRole("dialog", { name: "left-pad" });
    expect(await within(dialog).findByText("该包未附带许可证原文。")).toBeInTheDocument();
  });
});
