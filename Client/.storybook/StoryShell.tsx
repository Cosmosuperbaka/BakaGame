import { useLayoutEffect, type ReactNode } from "react";
import { useLocation } from "react-router";
import { setThemeId } from "@/lib/Theme";
import { isThemeId } from "@/themes/Registry";

/** 故事内点击导航后落到的占位，只在开发工具里出现。 */
export function NavigatedAway() {
  const location = useLocation();
  return <p className="p-6 font-mono text-xs text-muted-foreground">{location.pathname}</p>;
}

/**
 * 主题与明暗都写在 <html> 上，与应用的 `data-theme` 和 `.dark` 作用域一致；
 * 绘制前切换，截图不会拍到旧主题。主题同时写进应用的主题状态，设置弹窗里选中的就是工具栏那一款。
 */
export function ThemeScope({
  theme,
  scheme,
  children,
}: {
  theme: string;
  scheme: string;
  children: ReactNode;
}) {
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (isThemeId(theme)) setThemeId(theme);
    root.dataset.theme = theme;
    root.classList.toggle("dark", scheme === "dark");
    root.style.colorScheme = scheme === "dark" ? "dark" : "light";
  }, [theme, scheme]);
  return <>{children}</>;
}
