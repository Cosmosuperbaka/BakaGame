import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HelmetProvider } from "react-helmet-async";
import * as Sentry from "@sentry/react";
import "./index.css";
import App from "./App";
import { initClientSentry } from "./lib/Sentry";
import { setupGlobalImageProtection } from "./lib/ImageProtection";
import { recoverFromDomInvariant } from "./lib/DomRecovery";

initClientSentry();
setupGlobalImageProtection();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HelmetProvider>
      <Sentry.ErrorBoundary
        onError={(error) => {
          recoverFromDomInvariant(error);
        }}
        fallback={
          <div className="flex min-h-screen flex-col items-center justify-center p-6 text-center bg-background text-foreground">
            <h2 className="text-xl font-bold mb-2">哎呀，页面遇到了意料之外的错误</h2>
            <p className="text-sm text-muted-foreground mb-4">异常已自动记录上报，请尝试刷新页面重试。</p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="px-4 py-2 rounded-md bg-primary text-primary-foreground font-medium text-sm hover:opacity-90 transition-opacity"
            >
              刷新页面
            </button>
          </div>
        }
      >
        <App />
      </Sentry.ErrorBoundary>
    </HelmetProvider>
  </StrictMode>
);

