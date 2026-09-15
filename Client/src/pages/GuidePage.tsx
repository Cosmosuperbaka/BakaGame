import { Navigate, Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Seo, SITE_NAME, SITE_ORIGIN } from "@/components/common/Seo";
import { GUIDES, GUIDE_PUBLISHED_DATE, findGuide } from "@/data/Guides";

/**
 * 长尾内容页（/guide/<slug>）。
 *
 * 存在的意义是承接搜索意图：站内两个游戏页只讲「怎么进」，讲不清「怎么玩」，
 * 而「谁是卧底白板怎么玩」这类问题是真实搜索量所在。内容取仓库规则文档，
 * 页面结构与大厅页一致（返回主页 + 站内标题），正文用全站衬线体，不加装饰动效。
 *
 * 结构化数据同时标注 Article 与 FAQPage：前者说明这是站内的一篇正文，
 * 后者让页尾的问答有机会直接进搜索结果。
 */
export default function GuidePage() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const guide = findGuide(slug);

  // 未收录的 slug（含手输乱码）直接回主页，不留空白页；
  // 预渲染与 sitemap 只覆盖已收录的 slug，爬虫不会走到这里。
  if (!guide) return <Navigate to="/" replace />;

  const path = `/guide/${guide.slug}`;
  const relatedGuides = GUIDES.filter((item) => item.slug !== guide.slug);

  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Article",
        headline: guide.title,
        description: guide.description,
        inLanguage: "zh-CN",
        mainEntityOfPage: `${SITE_ORIGIN}${path}`,
        datePublished: GUIDE_PUBLISHED_DATE,
        dateModified: GUIDE_PUBLISHED_DATE,
        author: { "@type": "Organization", name: SITE_NAME },
        publisher: { "@type": "Organization", name: SITE_NAME },
      },
      {
        "@type": "FAQPage",
        mainEntity: guide.faqs.map((faq) => ({
          "@type": "Question",
          name: faq.question,
          acceptedAnswer: { "@type": "Answer", text: faq.answer },
        })),
      },
    ],
  };

  return (
    <div className="scrollbar-hidden flex h-full min-h-0 flex-col overflow-x-hidden overflow-y-auto bg-background">
      <Seo description={guide.description} path={path} structuredData={structuredData} />

      <header className="border-b border-border/40 px-6 pb-4 pt-6 md:pt-8">
        <div className="mx-auto flex max-w-3xl items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 h-8 gap-1.5 px-2 text-muted-foreground"
            onClick={() => navigate("/")}
          >
            <ArrowLeft className="h-4 w-4" />
            <span>返回主页</span>
          </Button>
          <div className="h-4 w-px bg-border/60" />
          <span className="text-sm text-muted-foreground">玩法指南</span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-6 pb-12 pt-6">
        <article className="space-y-7">
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">{guide.title}</h1>
            <p className="text-xs text-muted-foreground">更新于 {GUIDE_PUBLISHED_DATE}</p>
          </div>

          {guide.sections.map((section) => (
            <section key={section.heading} className="space-y-2.5">
              <h2 className="text-lg font-semibold tracking-tight">{section.heading}</h2>
              {section.paragraphs.map((paragraph) => (
                <p key={paragraph} className="break-words text-sm leading-7">
                  {paragraph}
                </p>
              ))}
              {section.items && (
                <ul className="list-disc space-y-1.5 pl-5 text-sm leading-7">
                  {section.items.map((item) => (
                    <li key={item} className="break-words">
                      {item}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}

          <section className="space-y-3">
            <h2 className="text-lg font-semibold tracking-tight">常见问题</h2>
            <dl className="space-y-3">
              {guide.faqs.map((faq) => (
                <div key={faq.question} className="space-y-1">
                  <dt className="text-sm font-semibold">{faq.question}</dt>
                  <dd className="break-words text-sm leading-7">{faq.answer}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="space-y-4 border-t border-border/40 pt-6">
            <Button asChild>
              <Link to={guide.game.path}>
                <span>{guide.game.label}</span>
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
              <span className="select-none text-muted-foreground/60">继续读</span>
              {relatedGuides.map((related) => (
                <Link
                  key={related.slug}
                  to={`/guide/${related.slug}`}
                  className="text-foreground/80 underline-offset-4 transition-colors hover:text-foreground hover:underline"
                >
                  {related.title}
                </Link>
              ))}
            </div>
          </section>
        </article>
      </main>
    </div>
  );
}
