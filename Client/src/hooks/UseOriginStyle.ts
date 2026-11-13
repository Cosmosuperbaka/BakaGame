import { useCallback, useState } from "react";
import type { CSSProperties } from "react";
import type { OriginPoint } from "@/lib/motion/Origin";

/**
 * 把来源点换算成浮层自身的 transform-origin。返回的 `measure` 是回调 ref，挂到浮层根节点上（与其它 ref 合并）。
 *
 * 在节点挂上的那一刻测量，而不是在 effect 里读 ref：浮层常渲染在 Portal 里，Portal 首帧不挂子树，
 * 宿主组件的 effect 跑时 ref 还是 null，ref 对象本身又不变，effect 不会重跑，原点就一直停在中心。
 * 回调 ref 只在节点真正出现（或来源换了）时被调用，正好是该测量的时刻。
 *
 * 测量要点：`getBoundingClientRect` 返回的是**已缩放**的盒子，
 * 直接用它的 left/width 会让原点算偏。因此这里用两个与变换无关的量还原真实盒子：
 * 尺寸取 `offsetWidth/offsetHeight`（布局值，不受 transform 影响），
 * 中心取 rect 中心 —— 挂载瞬间 transformOrigin 仍是默认的 50% 50%，
 * 此时缩放不会移动中心点，所以中心是准确的。
 * 浮层关闭即卸载，每次打开都从这一初始状态重新测量。
 */
export function useOriginStyle(origin: OriginPoint | null): {
  style: CSSProperties;
  measure: (node: HTMLElement | null) => void;
} {
  // 记下测量时对应的来源：来源换了或清空时，渲染直接回到中心。
  const [measured, setMeasured] = useState<{ origin: OriginPoint; value: string } | null>(null);

  const measure = useCallback(
    (node: HTMLElement | null) => {
      if (!node || !origin) return;
      const width = node.offsetWidth;
      const height = node.offsetHeight;
      if (width === 0 || height === 0) return;

      const rect = node.getBoundingClientRect();
      const left = rect.left + rect.width / 2 - width / 2;
      const top = rect.top + rect.height / 2 - height / 2;

      // 限制在浮层附近，避免来源远离时原点被推到极端位置。
      const clamp = (value: number) => Math.max(-60, Math.min(160, value));
      const x = clamp(((origin.x - left) / width) * 100);
      const y = clamp(((origin.y - top) / height) * 100);
      setMeasured({ origin, value: `${x.toFixed(2)}% ${y.toFixed(2)}%` });
    },
    [origin]
  );

  const transformOrigin = origin && measured?.origin === origin ? measured.value : "50% 50%";
  return { style: { transformOrigin }, measure };
}
