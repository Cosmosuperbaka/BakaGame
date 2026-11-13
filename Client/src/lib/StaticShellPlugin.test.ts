import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { render, waitFor } from "@testing-library/react";
import { HelmetProvider } from "react-helmet-async";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { staticShellPlugin } from "../../scripts/vite-plugins/StaticShell";
import { Seo } from "@/components/common/Seo";
import { PAGE_META } from "@/data/PageMeta";

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
