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
    logo: "openai",
    models: [
      { name: "Beta 后发", releasedAt: "2026-06-01", logo: "gpt" },
      {
        name: "Beta 先发",
        releasedAt: "2026-01-01",
        logo: "gpt",
        url: "https://openai.com/index/introducing-gpt-5-4/",
      },
    ],
  },
  {
    company: "Alpha",
    logo: "anthropic",
    models: [{ name: "Alpha 唯一", releasedAt: "2026-02-01", logo: "claude" }],
  },
];

const MAIN_PACKAGE_COUNT = CREDITS_FIXTURE_DEPENDENCIES.filter(
  (dependency) => dependency.direct
).length;

/** 统计格读出的值：标签与数字同在一格，按标签定位再取那格的数字。 */
function statValue(scope: HTMLElement, label: string): string | undefined {
  const cell = within(scope).getByText(label).parentElement;
  return cell?.querySelector("p")?.textContent;
}

function renderView({
  onTabChange = vi.fn(),
  loadLicense = vi.fn(loadFixtureLicense),
  initialTab = "credits" as CreditsTab,
}: {
  onTabChange?: (tab: CreditsTab) => void;
  loadLicense?: (packageName: string) => Promise<CreditLicenseDocument | null>;
  /** 起始标签：法务两页的正文要直接落在对应标签上验，不必先点一遍。 */
  initialTab?: CreditsTab;
} = {}) {
  function Harness() {
    const [tab, setTab] = useState<CreditsTab>(initialTab);
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
  it("按「开源致谢 / 更新日志 / 提交历史 / 隐私说明 / 用户条款」排列标签，并在切换时回调", async () => {
    const user = userEvent.setup();
    const onTabChange = vi.fn();
    renderView({ onTabChange });

    const tabs = screen.getAllByRole("tab").map((tab) => tab.textContent);
    expect(tabs).toEqual(["开源致谢", "更新日志", "提交历史", "隐私说明", "用户条款"]);
    expect(screen.getByRole("heading", { name: "参与开发的大模型" })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "更新日志" }));
    expect(onTabChange).toHaveBeenCalledWith("changelog");
    expect(
      await screen.findByText("新增开源致谢页，集中展示贡献模型、核心技术栈与依赖清单")
    ).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "提交历史" }));
    expect(onTabChange).toHaveBeenCalledWith("commits");
    expect(
      await screen.findByText("fix(Song): 统一主题曲类型判定并加固专辑错配防线")
    ).toBeInTheDocument();
  });

  it("参与开发的大模型按公司字母序分行、组内按发布时间排序，只展示名称与模型数", () => {
    renderView();

    // 夹具里 Beta 声明在 Alpha 之前：展示序读作 Alpha、Beta 才说明公司序由排序给出，不取声明顺序。
    const groups = screen.getAllByTestId(/^credits-company-/);
    expect(groups.map((group) => group.getAttribute("data-testid"))).toEqual([
      "credits-company-Alpha",
      "credits-company-Beta",
    ]);

    const betaModels = within(groups[1])
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(betaModels).toEqual(["Beta 先发", "Beta 后发"]);
    expect(within(groups[1]).getByText("2 个模型")).toBeInTheDocument();
    expect(within(groups[0]).getByText("1 个模型")).toBeInTheDocument();
    // releasedAt 只参与排序，不展示。
    expect(screen.queryByText("2026-01-01")).not.toBeInTheDocument();
  });

  it("有发布页面的模型徽章是新标签外链，没有的退化为静态标签", () => {
    renderView();

    const link = screen.getByRole("link", { name: "Beta 先发" });
    expect(link).toHaveAttribute("href", "https://openai.com/index/introducing-gpt-5-4/");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
    // 无 url 的模型不生成链接，避免出现点不动的外链。
    expect(screen.queryByRole("link", { name: "Beta 后发" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Alpha 唯一" })).not.toBeInTheDocument();
  });

  it("核心技术栈按前端 / 后端 / 脚手架 / 运维与开发辅助四组排列，版本取自依赖清单", () => {
    renderView();

    const categoryHeadings = ["前端", "后端", "脚手架", "运维与开发辅助"].map((label) =>
      screen.getByRole("heading", { level: 3, name: label })
    );
    for (let index = 1; index < categoryHeadings.length; index += 1) {
      expect(
        categoryHeadings[index - 1].compareDocumentPosition(categoryHeadings[index]) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    }

    // CORE_TECH_STACK 的 React 一条从依赖清单的 react 行取到实际版本。
    const reactCard = screen.getByRole("link", { name: /^React(?! Router)/ });
    expect(within(reactCard).getByText("v19.3.0")).toBeInTheDocument();
  });

  it("特别鸣谢按固定顺序列出五个来源，每条带标识且全部为新标签外链", () => {
    renderView();

    const section = screen.getByRole("region", { name: "特别鸣谢" });
    const items = within(section).getAllByRole("listitem");
    expect(items.map((item) => item.querySelector(".font-medium")?.textContent)).toEqual([
      "anime-character-guessr",
      "Bangumi 番组计划",
      "萌娘百科",
      "QQ音乐",
      "网易云音乐",
    ]);
    // 每条的图标格里都真有一枚标识：品牌字形、彩色官方矢量或通用图标都算。
    // 不能只查条目里有没有 svg——外链箭头本身就是 svg，那样这条断言会空过。
    for (const item of items) {
      const tile = item.querySelector('[data-slot="thanks-icon"]');
      expect(tile?.querySelector("svg, img"), item.textContent).not.toBeNull();
    }

    const links = within(section).getAllByRole("link");
    expect(links).toHaveLength(5);
    for (const link of links) {
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noreferrer");
    }

    const guessr = within(section).getByRole("link", { name: /anime-character-guessr/ });
    expect(guessr).toHaveAttribute("href", "https://github.com/kennylimz/anime-character-guessr");
    expect(guessr.textContent).toContain("二刺猿笑传之猜猜呗原版");

    const bangumi = within(section).getByRole("link", { name: /Bangumi 番组计划/ });
    expect(bangumi).toHaveAttribute("href", "https://bgm.tv/");
  });

  it("依赖清单一级只列主包，传递依赖不出现在一级行里", () => {
    renderView();

    expect(screen.getByText(`${MAIN_PACKAGE_COUNT} 个主包`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^查看 react v/ })).toBeInTheDocument();
    // scheduler 是 react 的传递依赖，只在二级抽屉里出现。
    expect(screen.queryByRole("button", { name: /查看 scheduler/ })).not.toBeInTheDocument();
  });

  it("点击主包打开抽屉，可下钻子依赖并返回，许可证折叠后才加载，关闭后焦点回到主包行", async () => {
    const user = userEvent.setup();
    const loadLicense = vi.fn(loadFixtureLicense);
    renderView({ loadLicense });

    const row = screen.getByRole("button", { name: /^查看 react v/ });
    await user.click(row);
    const reactDialog = await screen.findByRole("dialog", { name: "react" });
    expect(statValue(reactDialog, "直接子依赖")).toBe("1");
    expect(statValue(reactDialog, "间接依赖（传递闭包）")).toBe("1");
    // 许可证区默认折叠：展开前不触发懒加载。
    expect(loadLicense).not.toHaveBeenCalled();

    const dialog = screen.getByRole("dialog", { name: "react" });
    await user.click(within(dialog).getByRole("button", { name: "许可证原文" }));
    expect(loadLicense).toHaveBeenCalledWith("react");
    expect(await within(dialog).findByText("LICENSE")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: /^查看 scheduler v/ }));
    const childDialog = await screen.findByRole("dialog", { name: "scheduler" });
    // 下钻后页眉给出整条路径：react › scheduler，中间格可点回该层。
    expect(within(childDialog).getByRole("button", { name: "react" })).toBeInTheDocument();
    expect(statValue(childDialog, "直接子依赖")).toBe("0");
    expect(statValue(childDialog, "间接依赖（传递闭包）")).toBe("0");

    await user.click(within(childDialog).getByRole("button", { name: "返回上一层" }));
    expect(await screen.findByRole("dialog", { name: "react" })).toBeInTheDocument();

    const reopened = screen.getByRole("dialog", { name: "react" });
    await user.click(within(reopened).getByRole("button", { name: "关闭面板" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(row).toHaveFocus());
  });

  it("没有许可证原文的主包在抽屉展开后说明原因", async () => {
    const user = userEvent.setup();
    renderView();

    await user.click(screen.getByRole("button", { name: /^查看 left-pad v/ }));
    const dialog = await screen.findByRole("dialog", { name: "left-pad" });
    await user.click(within(dialog).getByRole("button", { name: "许可证原文" }));
    expect(await within(dialog).findByText("该包未附带许可证原文。")).toBeInTheDocument();
  });

  it("法务两页是真正的标签：切换就地出正文，不跳页", async () => {
    const user = userEvent.setup();
    const onTabChange = vi.fn();
    renderView({ onTabChange });

    // 五个标签同排同款式，法务与另外三个没有任何结构差别。
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "开源致谢",
      "更新日志",
      "提交历史",
      "隐私说明",
      "用户条款",
    ]);

    await user.click(screen.getByRole("tab", { name: "隐私说明" }));
    expect(onTabChange).toHaveBeenCalledWith("privacy");
    await user.click(screen.getByRole("tab", { name: "用户条款" }));
    expect(onTabChange).toHaveBeenCalledWith("terms");
  });

  it("隐私标签渲染与整页路由同一份正文", () => {
    renderView({ initialTab: "privacy" });

    expect(screen.getByText("隐私说明")).toBeInTheDocument();
    expect(screen.getByText(/最后更新：/)).toBeInTheDocument();
    expect(screen.getByText("一、我们收集的信息")).toBeInTheDocument();
    // 标签里嵌的只有正文：整页路由那套「返回主页」表头不能被搬进来第二份。
    expect(screen.getAllByRole("button", { name: "返回主页" })).toHaveLength(1);
  });

  it("用户条款标签渲染同一份正文", () => {
    renderView({ initialTab: "terms" });

    expect(screen.getByText("用户条款")).toBeInTheDocument();
    expect(screen.getByText(/欢迎使用 BakaGame/)).toBeInTheDocument();
  });
});
