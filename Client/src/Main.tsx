import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HelmetProvider } from "react-helmet-async";
import "./index.css";
import App from "./App";
import { AppErrorBoundary } from "./components/common/AppErrorBoundary";
import { AppErrorFallback } from "./components/common/AppErrorFallback";
import { createAppRouter } from "./AppRouter";
import { installChunkLoadRecovery } from "./lib/ChunkRecovery";
import { initClientSentry } from "./lib/Sentry";
import { setupGlobalImageProtection } from "./lib/ImageProtection";
import { recoverFromDomInvariant } from "./lib/DomRecovery";
import { stripStaticSeo } from "./lib/StaticSeo";
import { installMotionTokens } from "./lib/motion/CssTokens";
import { initTheme } from "./lib/Theme";
import { initSoundEffects } from "./lib/SoundEffects";

// 中文字体样式表：生产构建里 index.html 已非阻塞地加载它，这条导入只让构建把它拆成独立文件
// （开发服务器里则靠它真正载入）；浏览器发现同一份样式表已在页面里就不会重复下载。
void import("./fonts.css");
initClientSentry();
// 页面分块下载失败时先自愈重载一次（只有构建产物会派发该事件）。
installChunkLoadRecovery();
// CSS 动效变量由 lib/motion/ 的令牌生成，须在首次渲染前写入 :root。
installMotionTokens();
// index.html 的首帧脚本已先落位；这里接上系统主题与跨标签页的监听。
initTheme();
// 只挂首次交互的解锁监听，此时不创建 AudioContext。
initSoundEffects();
setupGlobalImageProtection();
// 先摘掉构建期注入的静态 SEO 标签，避免与 Helmet 写入的标签重复（详见 StaticSeo.ts）。
stripStaticSeo();

// 模块级只建一次：放进组件里，StrictMode 的双重调用会多建一个监听 popstate 却无人使用的路由实例。
const router = createAppRouter();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HelmetProvider>
      <AppErrorBoundary onError={recoverFromDomInvariant} fallback={<AppErrorFallback />}>
        <App router={router} />
      </AppErrorBoundary>
    </HelmetProvider>
  </StrictMode>
);
