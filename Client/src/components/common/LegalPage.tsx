import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { usePageNavigate } from "@/hooks/UsePageTransition";

export interface LegalRelatedPage {
  href: string;
  label: string;
}

interface LegalPageProps {
  title: string;
  updatedAt: string;
  related: LegalRelatedPage;
  children: ReactNode;
}

/** 隐私说明与用户条款共用的整页外壳：返回入口 + 标题 + 可滚动正文。 */
export function LegalPage({ title, updatedAt, related, children }: LegalPageProps) {
  const navigate = usePageNavigate();

  return (
    <div className="h-full min-h-0 overflow-y-auto overscroll-contain">
      <header className="border-b border-border">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-6 py-3 md:py-4">
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 h-8 shrink-0 gap-1.5 px-2 text-muted-foreground"
            onClick={() => void navigate("/")}
          >
            <ArrowLeft aria-hidden="true" />
            <span>返回主页</span>
          </Button>
          <h1 className="text-lg font-bold sm:text-xl">{title}</h1>
        </div>
      </header>

      <article className="mx-auto w-full max-w-3xl px-6 py-6 md:py-8">
        <p className="text-xs text-muted-foreground">最后更新：{updatedAt}</p>
        <div className="mt-5 space-y-6">{children}</div>
        <footer className="mt-10 border-t border-border pt-4 text-xs text-muted-foreground">
          相关页面：
          <a
            href={related.href}
            onClick={(event) => {
              event.preventDefault();
              void navigate(related.href);
            }}
            className="rounded-sm underline underline-offset-4 transition-colors hover:text-foreground"
          >
            {related.label}
          </a>
        </footer>
      </article>
    </div>
  );
}

export function LegalSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="text-base font-semibold">{title}</h2>
      <div className="mt-2 space-y-2 text-sm leading-6">{children}</div>
    </section>
  );
}
