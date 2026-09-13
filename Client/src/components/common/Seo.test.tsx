import { render, waitFor } from "@testing-library/react";
import { HelmetProvider } from "react-helmet-async";
import { describe, expect, it } from "vitest";
import { Seo } from "./Seo";

// react-helmet-async 需要一个独立的 context 实例，否则同一个 Provider 在
// 多个用例之间会复用同一份状态，断言到上一个用例残留的标签。
function renderSeo(props: React.ComponentProps<typeof Seo>) {
  const context = {};
  return {
    context,
    result: render(
      <HelmetProvider context={context}>
        <Seo {...props} />
      </HelmetProvider>,
    ),
  };
}

describe("Seo", () => {
  it("不接管标题，只写入描述与自指向 canonical", async () => {
    // 模拟 index.html 兜底标题：所有页面统一纯站名，Seo 不得追加或改写。
    document.title = "BakaGame";
    renderSeo({
      description: "测试描述",
      path: "/whoisfaker",
    });

    await waitFor(() => {
      const description = document.head.querySelector('meta[name="description"]');
      expect(description?.getAttribute("content")).toBe("测试描述");
    });
    const canonical = document.head.querySelector('link[rel="canonical"]');
    expect(canonical?.getAttribute("href")).toBe("https://game.baka.website/whoisfaker");
    // 反向断言：标签页标题必须保持纯站名（产品决策，禁止加后缀）。
    expect(document.title).toBe("BakaGame");
  });

  it("默认允许索引", async () => {
    renderSeo({ description: "描述", path: "/" });

    await waitFor(() => {
      const robots = document.head.querySelector('meta[name="robots"]');
      expect(robots?.getAttribute("content")).toBe("index,follow");
    });
  });

  it("indexable 为 false 时标记 noindex", async () => {
    renderSeo({
      description: "描述",
      path: "/whoisfaker/room/abc",
      indexable: false,
    });

    await waitFor(() => {
      const robots = document.head.querySelector('meta[name="robots"]');
      expect(robots?.getAttribute("content")).toBe("noindex,follow");
    });
  });

  it("写入 og 系列标签，og:title 固定为站名", async () => {
    renderSeo({ description: "分享描述", path: "/songuessr" });

    await waitFor(() => {
      expect(document.head.querySelector('meta[property="og:title"]')?.getAttribute("content")).toBe("BakaGame");
      expect(document.head.querySelector('meta[property="og:url"]')?.getAttribute("content")).toBe(
        "https://game.baka.website/songuessr",
      );
      expect(document.head.querySelector('meta[property="og:site_name"]')?.getAttribute("content")).toBe("BakaGame");
    });
  });

  it("结构化数据序列化为合法 JSON 并落在 head 内", async () => {
    renderSeo({
      description: "描述",
      path: "/",
      structuredData: { "@context": "https://schema.org", "@type": "WebSite", name: "BakaGame" },
    });

    await waitFor(() => {
      const script = document.head.querySelector('script[type="application/ld+json"]');
      expect(script).not.toBeNull();
      const parsed = JSON.parse(script!.textContent ?? "");
      expect(parsed["@type"]).toBe("WebSite");
      expect(parsed.name).toBe("BakaGame");
    });

    // 反向断言：JSON-LD 必须落在 head。
    // 曾经用 Helmet 的 script prop 承载，React 19 会把它渲染进 body 再由
    // head 提升机制搬运，该行为在预渲染与测试环境不可靠，搜索引擎可能读不到。
    expect(document.body.querySelector('script[type="application/ld+json"]')).toBeNull();
  });

  it("页面切换时结构化数据被替换而不是叠加", async () => {
    const first = renderSeo({
      description: "描述",
      path: "/",
      structuredData: { "@context": "https://schema.org", "@type": "WebSite", name: "第一个" },
    });

    await waitFor(() => {
      expect(document.head.querySelectorAll('script[type="application/ld+json"]').length).toBe(1);
    });

    first.result.unmount();
    renderSeo({
      description: "描述",
      path: "/songuessr",
      structuredData: { "@context": "https://schema.org", "@type": "WebSite", name: "第二个" },
    });

    await waitFor(() => {
      const scripts = document.head.querySelectorAll('script[type="application/ld+json"]');
      expect(scripts.length).toBe(1);
      expect(JSON.parse(scripts[0].textContent ?? "").name).toBe("第二个");
    });
  });
});
