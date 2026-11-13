import { createContext, type RefObject } from "react";

/**
 * 气泡外壳把气泡节点的引用交给里面的消息气泡去挂：胶囊交接要量气泡的位置，
 * 靠引用而不是按测试标识去查 DOM，测试标识改名也不会悄悄打断发送动画。
 */
export const BubbleRefContext = createContext<RefObject<HTMLDivElement | null> | null>(null);
