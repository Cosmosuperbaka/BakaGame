import { Suspense, useEffect } from "react";
import { Outlet } from "react-router-dom";
import { initCCBWs } from "@/stores/UseCCBStore";
import { CCBToastContainer } from "@/components/Toast";
import { PageLoadingFallback } from "@/components/common/PageLoadingFallback";

export default function CCBLayout() {
  useEffect(() => initCCBWs(), []);
  return <><Suspense fallback={<PageLoadingFallback />}><Outlet /></Suspense><CCBToastContainer /></>;
}
