import { useLayoutEffect, type ReactNode } from "react";
import { useLocation } from "react-router-dom";

/** 故事内点击导航后落到的占位，只在开发工具里出现。 */
export function NavigatedAway() {
  const location = useLocation();
  return <p className="p-6 font-mono text-xs text-muted-foreground">{location.pathname}</p>;
}

/** 主题写在 <html> 上，与应用 `.dark` 主题变量的作用域一致；绘制前切换，截图不会拍到旧主题。 */
export function ThemeScope({ theme, children }: { theme: string; children: ReactNode }) {
  useLayoutEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);
  return <>{children}</>;
}
