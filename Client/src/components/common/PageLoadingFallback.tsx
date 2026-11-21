import { Spinner } from "@/components/ui/Spinner";

export function PageLoadingFallback() {
  // data-page-loading 让移动壳桥接分辨「还在加载」与「已经渲染」，见 Mobile/bridge/baka-bridge.js。
  return (
    <div
      data-page-loading=""
      role="status"
      aria-label="页面加载中"
      className="flex min-h-screen w-full items-center justify-center text-foreground"
    >
      <Spinner className="size-8 text-primary" />
      <span className="sr-only">页面加载中</span>
    </div>
  );
}
