import { Component, type ErrorInfo, type ReactNode } from "react";
import { captureClientException } from "@/lib/Sentry";

interface AppErrorBoundaryProps {
  fallback: ReactNode;
  /** 在上报之后调用，用于 DOM 不变量自愈等恢复动作。 */
  onError?: (error: unknown) => void;
  children: ReactNode;
}

interface AppErrorBoundaryState {
  failed: boolean;
}

/**
 * 入口错误边界：渲染异常经遥测门面上报后显示回退界面。
 * 不再用 SDK 自带的边界，入口脚本才不必静态引用整个 SDK；SDK 尚未加载时上报会排队补发。
 */
export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  override state: AppErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    captureClientException(error, { componentStack: info.componentStack ?? undefined });
    this.props.onError?.(error);
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
