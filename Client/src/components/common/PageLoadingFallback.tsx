import { Spinner } from "@/components/ui/Spinner";

export function PageLoadingFallback() {
  return (
    <div
      role="status"
      aria-label="页面加载中"
      className="flex min-h-screen w-full items-center justify-center bg-background text-foreground"
    >
      <Spinner className="size-8 text-primary" />
      <span className="sr-only">页面加载中</span>
    </div>
  );
}

export default PageLoadingFallback;
