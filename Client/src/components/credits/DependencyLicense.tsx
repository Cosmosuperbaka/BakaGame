import { useEffect, useState } from "react";
import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import type { CreditLicenseDocument } from "@/lib/Credits";

/** 原文读取的三种落点：加载中、拿到结果（含「包里没有原文」的 null）、失败可重试。 */
type LicenseLoad =
  | { status: "loading" }
  | { status: "ready"; document: CreditLicenseDocument | null }
  | { status: "error" };

/**
 * 许可证原文的正文。只在折叠区展开时挂载，因此 `loadLicense` 也只在展开后才会被调用——
 * 关闭折叠即卸载，再次展开会重新走一遍加载（加载器按桶缓存，重复展开不会真的重复下载）。
 *
 * 原文可能很长，交给抽屉内容区统一滚动：这里不套内层滚动区，触屏不会卡在内层；
 * 长行折行显示，窄屏也能完整读到法律文本。
 */
export function DependencyLicense({
  packageName,
  loadLicense,
}: {
  packageName: string;
  loadLicense: (packageName: string) => Promise<CreditLicenseDocument | null>;
}) {
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<LicenseLoad>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    loadLicense(packageName)
      .then((document) => {
        if (!cancelled) setLoad({ status: "ready", document });
      })
      .catch(() => {
        if (!cancelled) setLoad({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [packageName, loadLicense, attempt]);

  const retry = () => {
    setLoad({ status: "loading" });
    setAttempt((value) => value + 1);
  };

  const files = load.status === "ready" && load.document ? load.document.files : [];

  if (load.status === "loading") {
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner />
        正在读取许可证原文…
      </p>
    );
  }

  if (load.status === "error") {
    return (
      <div role="alert" className="space-y-2">
        <p className="text-sm text-destructive">许可证原文加载失败，请检查网络后重试。</p>
        <Button type="button" variant="outline" size="sm" onClick={retry}>
          <RotateCw aria-hidden="true" />
          重试
        </Button>
      </div>
    );
  }

  if (files.length === 0) {
    // 抽屉上方已有项目主页与 npm 页面的跳转按钮，这里不再重复链接，只说明原文缺失。
    return <p className="text-sm text-muted-foreground">该包未附带许可证原文。</p>;
  }

  return (
    <div className="space-y-4">
      {files.map((file) => (
        <section key={file.name} className="space-y-1.5">
          <h4 className="font-mono text-xs text-muted-foreground">{file.name}</h4>
          <pre className="rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap break-words">
            {file.text}
          </pre>
        </section>
      ))}
    </div>
  );
}
