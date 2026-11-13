import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { render, waitFor } from "@testing-library/react";
import { HelmetProvider } from "react-helmet-async";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { staticShellPlugin } from "../../scripts/vite-plugins/StaticShell";
import { Seo } from "@/components/common/Seo";
import { PAGE_META, RUNTIME_PAGES, SITE_ORIGIN } from "@/data/PageMeta";

// 用真实的入口 HTML 跑一遍静态外壳插件，产物写进临时目录：断言的是部署出去的文件本身。
let root: string;
const dist = () => path.join(root, "dist");
const readDist = (name: string) => readFileSync(path.join(dist(), name), "utf8");
const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "static-shell-"));
  mkdirSync(dist());
  copyFileSync(
    path.resolve(import.meta.dirname, "../../index.html"),
    path.join(dist(), "index.html")
  );
  const plugin = staticShellPlugin();
  plugin.configResolved({ root, build: { outDir: "dist" } });
  vi.spyOn(console, "log").mockImplementation(() => {});
  await plugin.closeBundle();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** head 里一条标签的身份：同名标签只应出现一次，内容另行比较。 */
const tagKey = (element: Element) =>
  element.tagName === "LINK"
    ? `link:${element.getAttribute("rel")}`
    : `meta:${element.getAttribute("name") ?? element.getAttribute("property")}`;

describe("登记页的静态外壳", () => {
  it("双形态落盘：目录索引与 clean URL 两种主机都能命中", () => {
    for (const meta of PAGE_META) {
      const segment = meta.path.replace(/^\//, "");
      const files = segment === "" ? ["index.html"] : [`${segment}/index.html`, `${segment}.html`];
      for (const file of files) expect(existsSync(path.join(dist(), file)), file).toBe(true);
    }
  });

  // 构建期与运行时各写一份 head 标签时，加一个标签要改两处，漏改只有 E2E 能发现一部分。
  it("静态外壳的 head 标签与运行时 Seo 写入的是同一组、同样的值", async () => {
    for (const meta of PAGE_META) {
      const file = meta.path === "/" ? "index.html" : `${meta.path.slice(1)}.html`;
      const shell = parse(readDist(file));
      const shellTags = new Map(
        [...shell.head.querySelectorAll("[data-static-seo]")].map((element) => [
          tagKey(element),
          element.getAttribute("content") ?? element.getAttribute("href"),
        ])
      );

      document.head.innerHTML = "";
      const view = render(
        createElement(HelmetProvider, { context: {} }, createElement(Seo, { path: meta.path }))
      );
      await waitFor(() =>
        expect(document.head.querySelector('meta[name="robots"]')).not.toBeNull()
      );
      const runtimeTags = new Map(
        [...document.head.querySelectorAll("meta[name], meta[property], link[rel]")].map(
          (element) => [
            tagKey(element),
            element.getAttribute("content") ?? element.getAttribute("href"),
          ]
        )
      );
      view.unmount();

      expect(runtimeTags, meta.path).toEqual(shellTags);
    }
  });
});

describe("分享卡片字段", () => {
  it("写出分享图的宽高与替代文字", () => {
    for (const meta of PAGE_META) {
      const file = meta.path === "/" ? "index.html" : `${meta.path.slice(1)}.html`;
      const head = parse(readDist(file)).head;
      const content = (selector: string) => head.querySelector(selector)?.getAttribute("content");
      expect(content('meta[property="og:image:width"]'), meta.path).toBe("1200");
      expect(content('meta[property="og:image:height"]'), meta.path).toBe("630");
      expect(content('meta[property="og:image:alt"]'), meta.path).toBe(meta.imageAlt);
      expect(content('meta[name="twitter:image:alt"]'), meta.path).toBe(meta.imageAlt);
    }
  });
});

const jsonLd = (file: string, id: string) => {
  const script = parse(readDist(file)).getElementById(id);
  return script ? JSON.parse(script.textContent ?? "") : null;
};

describe("结构化数据", () => {
  it("游戏页与关于页带两级面包屑，首页没有", () => {
    expect(jsonLd("index.html", "bakagame-breadcrumb-structured-data")).toBeNull();
    for (const meta of PAGE_META.filter((item) => item.path !== "/")) {
      const breadcrumb = jsonLd(
        `${meta.path.slice(1)}.html`,
        "bakagame-breadcrumb-structured-data"
      );
      expect(breadcrumb, meta.path).toMatchObject({
        "@type": "BreadcrumbList",
        itemListElement: [
          { position: 1, name: "BakaGame", item: `${SITE_ORIGIN}/` },
          { position: 2, name: meta.shortTitle, item: `${SITE_ORIGIN}${meta.path}` },
        ],
      });
    }
  });

  // 组织实体带 @id，站内其它实体按 id 引用同一个组织；logo 用方形图标，不用横幅动图的首帧。
  it("首页的站点实体引用带 id 的组织实体，logo 是方形图标", () => {
    const site = jsonLd("index.html", "bakagame-structured-data");
    expect(site["@id"]).toBe(`${SITE_ORIGIN}/#website`);
    expect(site.publisher).toMatchObject({
      "@type": "Organization",
      "@id": `${SITE_ORIGIN}/#organization`,
      logo: {
        "@type": "ImageObject",
        url: `${SITE_ORIGIN}/favicon-512.png`,
        width: 512,
        height: 512,
      },
    });
    expect(site.publisher).not.toHaveProperty("slogan");
  });
});

// 平台把未登记的地址兜底到首页外壳时，房间邀请的预览是首页卡片、运行时页在初始 HTML 里是 index，
// 乱码地址是 200 加首页内容（软 404）。每类地址各有一份只带标题、描述与分享字段的外壳。
describe("运行时页与 404 的静态外壳", () => {
  it.each(RUNTIME_PAGES.map((page) => [page.file, page] as const))(
    "%s 只写标题、描述、分享字段与 noindex",
    (file, page) => {
      const doc = parse(readDist(file));
      const content = (selector: string) =>
        doc.head.querySelector(selector)?.getAttribute("content");
      expect(doc.title).toBe(page.title);
      expect(content('meta[name="robots"]')).toBe("noindex,follow");
      expect(content('meta[name="description"]')).toBe(page.description);
      expect(content('meta[property="og:title"]')).toBe(page.title);
      expect(content('meta[property="og:description"]')).toBe(page.description);
      expect(content('meta[property="og:image"]')).toBe(page.image);
      expect(content('meta[name="twitter:card"]')).toBe("summary_large_image");
      expect(doc.head.querySelector('link[rel="canonical"]')).toBeNull();
      expect(doc.head.querySelector('meta[property="og:url"]')).toBeNull();
      expect(doc.head.querySelector('script[type="application/ld+json"]')).toBeNull();
      // 挂载点保持空：正文由客户端渲染，外壳不替房间或运行时页编正文。
      expect(doc.getElementById("root")?.childElementCount).toBe(0);
      // 入口脚本还在：平台改写到这份文件后，应用照常启动。
      expect(doc.querySelector('script[type="module"]')).not.toBeNull();
    }
  );

  // 外壳是构建期产物，本来拿不到房号；这里防的是以后有人想「顺手」把房号或房间名拼进预览。
  it("房间邀请外壳不含房号与房间名的占位", () => {
    for (const page of RUNTIME_PAGES.filter((item) => item.file.endsWith("/room.html"))) {
      const html = readDist(page.file);
      expect(html).not.toMatch(/roomId|roomName|房号：|\{\{|:roomId/);
      expect(page.description).not.toMatch(/\d{4}/);
      expect(page.title).toContain("房间邀请");
    }
  });
});
