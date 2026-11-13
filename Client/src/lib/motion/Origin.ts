import type { Variants } from "framer-motion";
import { spring, ease, duration } from "@/lib/motion/Transitions";

// ==================== 浮层来源锚定 ====================

/** 触发元素在视口中的中心点，用于把浮层的缩放原点对准来源。 */
export interface OriginPoint {
  x: number;
  y: number;
}

/**
 * 从来源点被吸出的浮层。缩放与轻微位移同时发生，
 * 配合 transform-origin 形成窗口自按钮展开的观感；
 * 退出时反向收回同一位置，保证开合互为逆过程。
 */
export const emergeFromOrigin: Variants = {
  initial: { opacity: 0, scale: 0.9 },
  animate: {
    opacity: 1,
    scale: 1,
    transition: {
      ...spring.swift,
      opacity: { duration: duration.quick, ease: ease.out },
    },
  },
  exit: {
    opacity: 0,
    scale: 0.93,
    transition: {
      duration: duration.quick,
      ease: ease.inOut,
      opacity: { duration: duration.instant, ease: ease.inOut },
    },
  },
};
