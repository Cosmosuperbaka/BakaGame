import { useEffect, type ReactNode } from "react";

import { initCCBWs } from "@/stores/UseCCBStore";

export function CCBProvider({ children }: { children: ReactNode }) {
  useEffect(() => initCCBWs(), []);

  return <>{children}</>;
}
