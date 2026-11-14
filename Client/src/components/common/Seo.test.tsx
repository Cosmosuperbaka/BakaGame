import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { stripStaticSeo } from "@/lib/StaticSeo";
import { Seo } from "./Seo";
import { PAGE_META, SITE_ORIGIN, SITE_TAGLINE, findPageMeta } from "@/data/PageMeta";

function renderSeo(props: React.ComponentProps<typeof Seo>) {
  return { result: render(<Seo {...props} />) };
}

describe("Seo", () => {
  it("写入页面标题、描述与自指向 canonical", async () => {
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
    await waitFor(() => expect(document.title).toBe("谁是卧底 Who is Faker - BakaGame"));
  });

  it("未登记的页面用显式标题", async () => {
    renderSeo({ description: "房间", path: "/cee/room/1234", title: "猜动漫角色房间" });
    await waitFor(() => expect(document.title).toBe("猜动漫角色房间"));
  });

  it("未登记且没传标题时退回站名", async () => {
    document.title = "上一页";
    renderSeo({ description: "房间", path: "/cee/room/1234" });
    await waitFor(() => expect(document.title).toBe("BakaGame"));
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

  it("写入 og 系列标签，og:title 跟随页面标题，并注入社交卡片大图", async () => {
    renderSeo({ description: "分享描述", path: "/songuessr" });

    await waitFor(() => {
      expect(
        document.head.querySelector('meta[property="og:title"]')?.getAttribute("content")
      ).toBe("听歌猜歌 Songuessr：听歌识曲与听歌识番 - BakaGame");
      expect(document.head.querySelector('meta[property="og:url"]')?.getAttribute("content")).toBe(
        "https://game.baka.website/songuessr"
      );
      expect(
        document.head.querySelector('meta[property="og:site_name"]')?.getAttribute("content")
      ).toBe("BakaGame");
      expect(
        document.head.querySelector('meta[property="og:image"]')?.getAttribute("content")
      ).toBe(`${SITE_ORIGIN}/og/og-song.jpg`);
      expect(
        document.head.querySelector('meta[name="twitter:card"]')?.getAttribute("content")
      ).toBe("summary_large_image");
    });
  });

  it("当存在 keywords 时写入 meta keywords", async () => {
    renderSeo({ path: "/whoisfaker" });
    const keywords = findPageMeta("/whoisfaker")!.keywords!;
    await waitFor(() => {
      expect(document.head.querySelector('meta[name="keywords"]')?.getAttribute("content")).toBe(
        keywords.join(", ")
      );
    });
  });

  it("未显式传描述时分享标签与页面描述共用登记文案", async () => {
    renderSeo({ path: "/cee" });
    const description = findPageMeta("/cee")!.description;
    await waitFor(() => {
      expect(document.head.querySelector('meta[name="description"]')?.getAttribute("content")).toBe(
        description
      );
      expect(
        document.head.querySelector('meta[property="og:description"]')?.getAttribute("content")
      ).toBe(description);
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
    // 直接渲染 <script> 时 React 19 不会把内联脚本提升到 head，而是留在组件位置（body），
    // 搜索引擎可能读不到；因此结构化数据由副作用按固定 id 写进 head。
    expect(document.body.querySelector('script[type="application/ld+json"]')).toBeNull();
  });

  it("登记页面的常见问答注入为 FAQPage 结构化数据", async () => {
    renderSeo({ path: "/whoisfaker" });
    const faq = findPageMeta("/whoisfaker")!.faq;

    await waitFor(() => {
      const script = document.getElementById("bakagame-faq-structured-data");
      expect(script).not.toBeNull();
      const parsed = JSON.parse(script!.textContent ?? "");
      expect(parsed["@type"]).toBe("FAQPage");
      expect(parsed.mainEntity).toHaveLength(faq.length);
      expect(parsed.mainEntity[0].name).toBe(faq[0].q);
      expect(parsed.mainEntity[0].acceptedAnswer.text).toBe(faq[0].a);
    });

    // 与结构化数据脚本各用各的固定 id，互不干扰；两者都必须落在 head。
    expect(document.getElementById("bakagame-structured-data")).not.toBeNull();
    expect(document.body.querySelector('script[type="application/ld+json"]')).toBeNull();
  });

  it("页面切换时结构化数据被替换而不是叠加", async () => {
    const first = renderSeo({
      description: "描述",
      path: "/",
      structuredData: { "@context": "https://schema.org", "@type": "WebSite", name: "第一个" },
    });

    await waitFor(() => {
      // 首页的 WebSite 与 FAQPage 各注入一份，互不叠加。
      expect(document.head.querySelectorAll('script[type="application/ld+json"]').length).toBe(2);
    });

    first.result.unmount();
    renderSeo({
      description: "描述",
      path: "/songuessr",
      structuredData: { "@context": "https://schema.org", "@type": "WebSite", name: "第二个" },
    });

    await waitFor(() => {
      // 子页面多一份面包屑：主实体、FAQPage、面包屑各一份，互不叠加。
      const scripts = document.head.querySelectorAll('script[type="application/ld+json"]');
      expect(scripts.length).toBe(3);
      expect(
        JSON.parse(document.getElementById("bakagame-structured-data")!.textContent ?? "").name
      ).toBe("第二个");
      expect(
        JSON.parse(document.getElementById("bakagame-faq-structured-data")!.textContent ?? "")[
          "@type"
        ]
      ).toBe("FAQPage");
    });
  });

  it("页面切换到无结构化数据时移除旧 JSON-LD", async () => {
    const first = renderSeo({
      description: "描述",
      path: "/",
      structuredData: { "@context": "https://schema.org", "@type": "WebSite", name: "旧页面" },
    });
    await waitFor(() => expect(document.getElementById("bakagame-structured-data")).not.toBeNull());
    await waitFor(() =>
      expect(document.getElementById("bakagame-faq-structured-data")).not.toBeNull()
    );
    first.result.unmount();
    renderSeo({ description: "房间", path: "/whoisfaker/room/demo", indexable: false });
    await waitFor(() => {
      expect(document.getElementById("bakagame-structured-data")).toBeNull();
      expect(document.getElementById("bakagame-faq-structured-data")).toBeNull();
    });
  });

  it("未登记路径既不注入结构化数据也不注入 FAQPage", async () => {
    renderSeo({ description: "房间", path: "/cee/room/1234", indexable: false });
    await waitFor(() => {
      expect(document.head.querySelector('script[type="application/ld+json"]')).toBeNull();
    });
  });

  // 社媒卡片只展示描述前两行：标语必须在第一句，漏写等于把分享文案浪费掉。
  it("所有登记页面的描述都以分享标语开头", () => {
    for (const meta of PAGE_META) {
      expect(meta.description.startsWith(SITE_TAGLINE), meta.path).toBe(true);
    }
  });
  it("登记的子页面写入面包屑，切到未登记页面时移除", async () => {
    const first = renderSeo({ path: "/cee" });
    await waitFor(() => {
      const script = document.getElementById("bakagame-breadcrumb-structured-data");
      expect(JSON.parse(script?.textContent ?? "{}")["@type"]).toBe("BreadcrumbList");
    });
    first.result.unmount();
    renderSeo({ description: "房间", path: "/cee/room/1234", indexable: false });
    await waitFor(() =>
      expect(document.getElementById("bakagame-breadcrumb-structured-data")).toBeNull()
    );
  });

  describe("页面标题", () => {
    // 复刻真实启动顺序：静态外壳写好标题与元信息 -> 启动时摘掉带标记的标签 -> 页面分块到位后 Seo 才挂载。
    function mountStaticShell() {
      document.head.innerHTML = `<title>外壳标题</title>
        <meta name="description" content="外壳描述" data-static-seo="1" />
        <link rel="canonical" href="https://example.com/shell" data-static-seo="1" />`;
    }
    const titles = () => [...document.head.querySelectorAll("title")];

    it("摘掉静态元信息之后、Seo 挂载之前，标题仍是外壳写的那个", () => {
      mountStaticShell();
      stripStaticSeo();

      expect(document.head.querySelector('meta[name="description"]')).toBeNull();
      expect(document.title).toBe("外壳标题");
      expect(titles()).toHaveLength(1);
    });

    it("Seo 挂载后标题变成该页标题，head 里始终只有一个 title，且就是外壳那一个", async () => {
      mountStaticShell();
      const shellTitle = document.head.querySelector("title");
      stripStaticSeo();

      renderSeo({ path: "/whoisfaker" });

      // 布局副作用在挂载提交内同步完成：不需要等待。
      expect(document.title).toBe("谁是卧底 Who is Faker - BakaGame");
      expect(titles()).toEqual([shellTitle]);
      await waitFor(() =>
        expect(document.head.querySelectorAll('meta[name="description"]')).toHaveLength(1)
      );
      expect(document.head.querySelectorAll('link[rel="canonical"]')).toHaveLength(1);
    });

    it("同一个 Seo 换页面时标题跟着变，不新增 title", () => {
      mountStaticShell();
      const view = render(<Seo path="/whoisfaker" />);
      view.rerender(<Seo path="/songuessr" />);

      expect(document.title).toBe("听歌猜歌 Songuessr：听歌识曲与听歌识番 - BakaGame");
      expect(titles()).toHaveLength(1);
    });

    it("页面卸载后 meta 与 canonical 被移除，避免与下一页并存", async () => {
      mountStaticShell();
      stripStaticSeo();
      const first = renderSeo({ path: "/whoisfaker" });
      await waitFor(() =>
        expect(document.head.querySelectorAll('link[rel="canonical"]')).toHaveLength(1)
      );

      first.result.unmount();
      expect(document.head.querySelectorAll('link[rel="canonical"]')).toHaveLength(0);
      expect(document.head.querySelectorAll('meta[name="description"]')).toHaveLength(0);

      renderSeo({ path: "/songuessr" });
      await waitFor(() =>
        expect(
          document.head.querySelector('link[rel="canonical"]')?.getAttribute("href")
        ).toContain("/songuessr")
      );
      expect(document.head.querySelectorAll('meta[name="description"]')).toHaveLength(1);
    });
  });
});
