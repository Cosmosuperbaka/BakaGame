import {
  SITE_NAME,
  buildBreadcrumbStructuredData,
  buildFaqStructuredData,
  buildHeadTags,
  findPageMeta,
  type HeadTag,
} from "@/data/PageMeta";

/** 调用方可以显式给出的页面元信息；缺省的字段回落到 `PageMeta` 的登记值。 */
export interface SeoInput {
  /** 站内路径（以 / 开头）；用于生成 canonical 与 og:url，并据此查 PageMeta。 */
  path: string;
  title?: string;
  description?: string;
  image?: string;
  keywords?: string[];
  /** 是否允许搜索引擎索引本页；缺省允许。 */
  indexable?: boolean;
  /** 覆盖登记页的主结构化数据。 */
  structuredData?: Record<string, unknown>;
}

/** 一个页面最终要写进 <head> 的全部内容；结构化数据已序列化，空表示该页没有这一段。 */
export interface ResolvedSeo {
  title: string;
  headTags: HeadTag[];
  structuredDataJson: string | null;
  faqStructuredDataJson: string | null;
  breadcrumbStructuredDataJson: string | null;
}

const toJson = (data: Record<string, unknown> | null | undefined) =>
  data ? JSON.stringify(data) : null;

/**
 * 把调用方传入的元信息与 `PageMeta` 登记值合成最终结果。
 *
 * 独立成纯函数是为了让「缺省回落什么」可以不挂载组件就验证：渲染与写 DOM 留在 `Seo`，
 * 这里只做取值。未登记的路径且没有显式描述时直接抛错，宁可当场报错，
 * 也不要产出空 description 的页面——那等于把页面交给搜索引擎瞎猜。
 */
export function resolveSeo(input: SeoInput): ResolvedSeo {
  const meta = findPageMeta(input.path);
  const description = input.description ?? meta?.description;
  if (!description) {
    throw new Error(`Seo：路径 ${input.path} 未登记在 PageMeta，且未显式传入 description`);
  }

  const title = input.title ?? meta?.title ?? SITE_NAME;
  return {
    title,
    headTags: buildHeadTags({
      path: input.path,
      title,
      description,
      image: input.image ?? meta?.image,
      // 显式换了分享图后，登记页的替代文字就不再描述它，不能沿用。
      imageAlt: input.image ? undefined : meta?.imageAlt,
      keywords: input.keywords ?? meta?.keywords,
      indexable: input.indexable ?? true,
    }),
    structuredDataJson: toJson(input.structuredData ?? meta?.structuredData),
    faqStructuredDataJson: toJson(buildFaqStructuredData(meta?.faq)),
    breadcrumbStructuredDataJson: toJson(buildBreadcrumbStructuredData(meta)),
  };
}
