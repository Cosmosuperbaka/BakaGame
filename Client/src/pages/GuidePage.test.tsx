import { render, screen, waitFor } from "@testing-library/react";
import { HelmetProvider } from "react-helmet-async";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import GuidePage from "./GuidePage";
import { GUIDES } from "@/data/Guides";

// 与 Seo.test.tsx 同理：每个用例一个独立的 Helmet context，避免读到上一个用例残留的标签。
function renderGuide(initialPath: string) {
  const context = {};
  return render(
    <HelmetProvider context={context}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/guide/:slug" element={<GuidePage />} />
          <Route path="/" element={<div>主页占位</div>} />
        </Routes>
      </MemoryRouter>
    </HelmetProvider>,
  );
}

describe("GuidePage", () => {
  const guide = GUIDES[0];

  it("渲染 H1 与正文段落", () => {
    renderGuide(`/guide/${guide.slug}`);

    expect(screen.getByRole("heading", { level: 1, name: guide.title })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: guide.sections[0].heading })).toBeInTheDocument();
    expect(screen.getByText(guide.sections[0].paragraphs[0])).toBeInTheDocument();
  });

  it("写入独立 description 与自指向 canonical", async () => {
    renderGuide(`/guide/${guide.slug}`);

    await waitFor(() => {
      const description = document.head.querySelector('meta[name="description"]');
      expect(description?.getAttribute("content")).toBe(guide.description);
    });
    const canonical = document.head.querySelector('link[rel="canonical"]');
    expect(canonical?.getAttribute("href")).toBe(`https://game.baka.website/guide/${guide.slug}`);
  });

  it("输出 Article 与 FAQPage 结构化数据", async () => {
    renderGuide(`/guide/${guide.slug}`);

    await waitFor(() => {
      const script = document.head.querySelector('script[type="application/ld+json"]');
      expect(script).not.toBeNull();
      const parsed = JSON.parse(script!.textContent ?? "");
      const types = parsed["@graph"].map((node: { "@type": string }) => node["@type"]);
      expect(types).toEqual(["Article", "FAQPage"]);

      const faqPage = parsed["@graph"][1];
      expect(faqPage.mainEntity).toHaveLength(guide.faqs.length);
      expect(faqPage.mainEntity[0].name).toBe(guide.faqs[0].question);
      expect(faqPage.mainEntity[0].acceptedAnswer.text).toBe(guide.faqs[0].answer);
    });

    // 反向断言：结构化数据必须落在 head，不能漂到 body 里被爬虫忽略。
    expect(document.body.querySelector('script[type="application/ld+json"]')).toBeNull();
  });

  it("未收录的 slug 回退主页", () => {
    renderGuide("/guide/not-a-real-guide");

    expect(screen.getByText("主页占位")).toBeInTheDocument();
  });

  it("每篇指南都提供独立 description，且 slug 不重复", () => {
    const slugs = GUIDES.map((item) => item.slug);
    expect(new Set(slugs).size).toBe(slugs.length);

    const descriptions = GUIDES.map((item) => item.description);
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });
});
