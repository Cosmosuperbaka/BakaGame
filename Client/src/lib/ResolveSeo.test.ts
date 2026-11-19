import { describe, expect, it } from "vitest";
import { resolveSeo } from "./ResolveSeo";
import { DEFAULT_OG_IMAGE_ALT } from "@/data/pages/Shared";
import { SITE_NAME, SITE_ORIGIN, buildFaqStructuredData, findPageMeta } from "@/data/PageMeta";

const tagContent = (headTags: ReturnType<typeof resolveSeo>["headTags"], key: string) =>
  headTags.find((tag) => tag.attrs.name === key || tag.attrs.property === key)?.attrs.content;

describe("resolveSeo", () => {
  it("登记页面全部取登记值", () => {
    const meta = findPageMeta("/whoisfaker")!;
    const resolved = resolveSeo({ path: "/whoisfaker" });

    expect(resolved.title).toBe(meta.title);
    expect(tagContent(resolved.headTags, "description")).toBe(meta.description);
    expect(tagContent(resolved.headTags, "keywords")).toBe(meta.keywords!.join(", "));
    expect(tagContent(resolved.headTags, "og:image")).toBe(meta.image);
    expect(tagContent(resolved.headTags, "og:image:alt")).toBe(meta.imageAlt);
    expect(JSON.parse(resolved.structuredDataJson!)).toEqual(meta.structuredData);
    expect(JSON.parse(resolved.faqStructuredDataJson!)).toEqual(buildFaqStructuredData(meta.faq));
    expect(JSON.parse(resolved.breadcrumbStructuredDataJson!)["@type"]).toBe("BreadcrumbList");
  });

  it("显式传入的值优先于登记值", () => {
    const resolved = resolveSeo({
      path: "/whoisfaker",
      title: "自定义标题",
      description: "自定义描述",
      keywords: ["甲", "乙"],
      structuredData: { "@type": "Thing" },
    });

    expect(resolved.title).toBe("自定义标题");
    expect(tagContent(resolved.headTags, "description")).toBe("自定义描述");
    expect(tagContent(resolved.headTags, "og:title")).toBe("自定义标题");
    expect(tagContent(resolved.headTags, "keywords")).toBe("甲, 乙");
    expect(resolved.structuredDataJson).toBe('{"@type":"Thing"}');
  });

  it("显式换了分享图时不沿用登记页的替代文字", () => {
    const resolved = resolveSeo({ path: "/whoisfaker", image: "https://example.com/card.jpg" });

    expect(tagContent(resolved.headTags, "og:image")).toBe("https://example.com/card.jpg");
    expect(tagContent(resolved.headTags, "og:image:alt")).toBeUndefined();
  });

  it("缺省允许收录，indexable 为 false 时标 noindex", () => {
    expect(tagContent(resolveSeo({ path: "/" }).headTags, "robots")).toBe("index,follow");
    expect(
      tagContent(
        resolveSeo({ path: "/whoisfaker/room/abc", description: "房间", indexable: false })
          .headTags,
        "robots"
      )
    ).toBe("noindex,follow");
  });

  it("canonical 与 og:url 指向本页路径", () => {
    const { headTags } = resolveSeo({ path: "/cee" });

    expect(headTags.find((tag) => tag.attrs.rel === "canonical")?.attrs.href).toBe(
      `${SITE_ORIGIN}/cee`
    );
    expect(tagContent(headTags, "og:url")).toBe(`${SITE_ORIGIN}/cee`);
  });

  it("未登记路径只带显式描述，标题退回站名，不带任何结构化数据与关键词", () => {
    const resolved = resolveSeo({ path: "/cee/room/1234", description: "房间", indexable: false });

    expect(resolved.title).toBe(SITE_NAME);
    expect(tagContent(resolved.headTags, "description")).toBe("房间");
    expect(tagContent(resolved.headTags, "keywords")).toBeUndefined();
    expect(tagContent(resolved.headTags, "og:image:alt")).toBe(DEFAULT_OG_IMAGE_ALT);
    expect(resolved.structuredDataJson).toBeNull();
    expect(resolved.faqStructuredDataJson).toBeNull();
    expect(resolved.breadcrumbStructuredDataJson).toBeNull();
  });

  it("首页没有面包屑，登记的子页面有", () => {
    expect(resolveSeo({ path: "/" }).breadcrumbStructuredDataJson).toBeNull();
    expect(resolveSeo({ path: "/songuessr" }).breadcrumbStructuredDataJson).not.toBeNull();
  });

  it("未登记路径又没传描述时当场报错", () => {
    expect(() => resolveSeo({ path: "/cee/room/1234" })).toThrow(/未登记在 PageMeta/);
  });
});
