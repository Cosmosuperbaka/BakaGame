import { useEffect, useState } from "react";
import { ArrowUpRight, RotateCw } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import {
  creditLicenseLabel,
  type CreditDependency,
  type CreditLicenseDocument,
} from "@/lib/Credits";

/** 原文读取的三种落点：加载中、拿到结果（含「包里没有原文」的 null）、失败可重试。 */
type LicenseLoad =
  | { status: "loading" }
  | { status: "ready"; document: CreditLicenseDocument | null }
  | { status: "error" };

/** 包主页与 npm 页面。没有任何许可证原文时也给出，免得用户无路可查。 */
function PackageLinks({ dependency }: { dependency: CreditDependency }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
      {dependency.url ? (
        <a
          href={dependency.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
        >
          项目主页
          <ArrowUpRight className="size-3" aria-hidden="true" />
        </a>
      ) : null}
      <a
        href={`https://www.npmjs.com/package/${dependency.name}`}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
      >
        npm 页面
        <ArrowUpRight className="size-3" aria-hidden="true" />
      </a>
    </div>
  );
}

/**
 * 许可证抽屉的内容。包元数据（版本、License、简介、外链）先渲染，
 * 原文在挂载后按需加载：加载中只占说明行的高度，结果到达后在同一位置展开，不推动已读的信息。
 *
 * `loadLicense` 由页面传模块级缓存函数，必须是稳定引用；变化会重新取一次原文。
 * 组件以依赖名作 `key` 挂载，换包时状态从头开始，不会短暂显示上一个包的原文。
 */
export function LicenseSheet({
  dependency,
  loadLicense,
}: {
  dependency: CreditDependency;
  loadLicense: (packageName: string) => Promise<CreditLicenseDocument | null>;
}) {
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<LicenseLoad>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    loadLicense(dependency.name)
      .then((document) => {
        if (!cancelled) setLoad({ status: "ready", document });
      })
      .catch(() => {
        if (!cancelled) setLoad({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [dependency.name, loadLicense, attempt]);

  const retry = () => {
    setLoad({ status: "loading" });
    setAttempt((value) => value + 1);
  };

  const files = load.status === "ready" && load.document ? load.document.files : [];

  return (
    <div className="space-y-4">
      {/* 元数据先出现：原文后到时不改变这一块的位置。 */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" size="xs" className="font-mono">
            v{dependency.version}
          </Badge>
          <Badge variant="secondary" size="xs">
            {creditLicenseLabel(dependency.license)}
          </Badge>
          {dependency.scope === "development" ? (
            <Badge variant="subtle" size="xs">
              开发依赖
            </Badge>
          ) : null}
        </div>
        {dependency.description ? (
          <p className="text-sm break-words text-muted-foreground">{dependency.description}</p>
        ) : null}
        <PackageLinks dependency={dependency} />
      </div>

      <div className="border-t pt-3">
        <h3 className="text-sm font-semibold">许可证原文</h3>
        {load.status === "loading" ? (
          <p role="status" className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner />
            正在读取许可证原文…
          </p>
        ) : load.status === "error" ? (
          <div role="alert" className="mt-2 space-y-2">
            <p className="text-sm text-destructive">许可证原文加载失败，请检查网络后重试。</p>
            <Button type="button" variant="outline" size="sm" onClick={retry}>
              <RotateCw aria-hidden="true" />
              重试
            </Button>
          </div>
        ) : files.length === 0 ? (
          <div className="mt-2 space-y-2">
            <p className="text-sm">该包未附带许可证原文。</p>
            <p className="text-xs text-muted-foreground">可在项目主页或 npm 页面查看该包的许可证说明。</p>
            <PackageLinks dependency={dependency} />
          </div>
        ) : (
          <div className="mt-2 space-y-4">
            {files.map((file) => (
              <section key={file.name} className="space-y-1.5">
                <h4 className="font-mono text-xs text-muted-foreground">{file.name}</h4>
                {/* 保留文件原始换行；长行折行显示，窄屏也能完整读到，不横向截断法律文本。
                    原文交给抽屉内容区统一滚动，不在每份文件里再套一层滚动区，触屏不会卡在内层。 */}
                <pre className="rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap break-words">
                  {file.text}
                </pre>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
