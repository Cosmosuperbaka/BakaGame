import type { Decorator, Preview } from "@storybook/react-vite";
import { MotionConfig, MotionGlobalConfig } from "framer-motion";
import { HelmetProvider } from "react-helmet-async";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { resetAllStores } from "@/stories/StorePresets";
import { NavigatedAway, ThemeScope } from "./StoryShell";
import { installMotionTokens } from "@/lib/Motion";
import "@/index.css";
import "./Preview.css";

// 与应用入口一致：CSS 动效变量由 Motion.ts 的令牌生成。
installMotionTokens();

/** 故事所需的路由：`route` 为初始地址，`path` 为匹配模式（供 useParams 取值）。 */
interface StoryRouteParameters {
  route?: string;
  path?: string;
}

const withRouter: Decorator = (Story, context) => {
  const { route = "/", path } = (context.parameters.router ?? {}) as StoryRouteParameters;
  return (
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route path={path ?? route} element={<Story />} />
        <Route path="*" element={<NavigatedAway />} />
      </Routes>
    </MemoryRouter>
  );
};

const withEnvironment: Decorator = (Story, context) => (
  <ThemeScope theme={String(context.globals.theme)}>
    {context.parameters.layout === "fullscreen" ? (
      <div className="h-dvh w-full">
        <Story />
      </div>
    ) : (
      <Story />
    )}
  </ThemeScope>
);

const withProviders: Decorator = (Story) => (
  <HelmetProvider>
    <MotionConfig reducedMotion="user">
      <TooltipProvider>
        <Story />
      </TooltipProvider>
    </MotionConfig>
  </HelmetProvider>
);

const preview: Preview = {
  // 数组靠前的装饰器在内层：路由最贴近故事，公共 Provider 在最外层。
  decorators: [withRouter, withEnvironment, withProviders],
  // 截图时关闭 framer-motion 过渡，直接落到终态；交互调试时保留动效。
  // Store 在故事自身的 beforeEach 之前先回到初始状态，避免上一个故事的数据残留。
  beforeEach: ({ globals }) => {
    resetAllStores();
    MotionGlobalConfig.skipAnimations = globals.motion === "off";
    return () => {
      MotionGlobalConfig.skipAnimations = false;
    };
  },
  initialGlobals: { theme: "light", motion: "on" },
  globalTypes: {
    theme: {
      description: "主题",
      toolbar: {
        title: "主题",
        icon: "mirror",
        items: [
          { value: "light", title: "亮色" },
          { value: "dark", title: "暗色" },
        ],
        dynamicTitle: true,
      },
    },
    motion: {
      description: "动效",
      toolbar: {
        title: "动效",
        icon: "lightning",
        items: [
          { value: "on", title: "播放动效" },
          { value: "off", title: "直接落到终态" },
        ],
        dynamicTitle: true,
      },
    },
  },
  parameters: {
    layout: "padded",
    backgrounds: { disable: true },
    controls: { expanded: true },
    viewport: {
      options: {
        mobile: { name: "手机 390", styles: { width: "390px", height: "844px" }, type: "mobile" },
        tablet: { name: "平板 900", styles: { width: "900px", height: "800px" }, type: "tablet" },
        desktop: { name: "桌面 1440", styles: { width: "1440px", height: "900px" }, type: "desktop" },
      },
    },
  },
};

export default preview;
