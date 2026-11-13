import { useImperativeHandle, useLayoutEffect, useRef, type Ref, type RefObject } from "react";
import { createPortal } from "react-dom";
import { animate, motion, useMotionValue, type MotionValue, type Transition } from "framer-motion";
import { BubbleRefContext } from "@/components/common/chat/BubbleRef";
import { byAxes, chatThrow, springWithVelocity, spring } from "@/lib/Motion";
import { cn } from "@/lib/Utils";

/** 掷出中的胶囊：气泡接手时读它此刻的位置与速度。 */
export interface ThrowHandle {
  node: HTMLDivElement | null;
  x: MotionValue<number>;
  y: MotionValue<number>;
}

/** 一次发送的胶囊：起点贴着输入框里的文字。 */
export interface SendThrowState {
  key: number;
  text: string;
  anchor: { left: number; top: number; height: number; maxWidth: number };
  /** `fly` 掷出并悬停等回显；`recall` 没发出去，退回输入框把内容还给玩家 */
  phase: "fly" | "recall";
}

/** 回显接手胶囊所需的两样东西：胶囊句柄，与接手后撤掉胶囊的回调。 */
export interface ThrowHandoff {
  capsule: RefObject<ThrowHandle | null>;
  onTake: () => void;
}

const centerOf = (rect: DOMRect) => ({
  x: rect.left + rect.width / 2,
  y: rect.top + rect.height / 2,
});

/** 气泡接手时相对胶囊的尺寸比；量不到尺寸（未布局）时按原大处理。 */
const handoffScale = (from: number, own: number) =>
  own > 0 ? Math.min(chatThrow.scale.max, Math.max(chatThrow.scale.min, from / own)) : 1;

/**
 * 发送的第一段：输入框里的文字凝成一枚胶囊，被掷到输入区右上方等回显。
 * 两轴推力不同：纵向走 `spring.thrust` 先到，横向走更慢的 `spring.push` 后到，轨迹是一道向右上方弯过去的弧；
 * 掷出的冲量（`chatThrow.impulse`）让主轴尺度鼓起、副轴收窄，起止都是原大，形变只来自初速度，按 thrust / wobble 回弹。
 * 收回时按 `spring.recall` 退回输入框、缩成一道缝。挂在 body 上，不被输入区与列表的滚动区裁切。
 */
export function SendThrow({
  ref,
  text,
  anchor,
  phase,
  onRecalled,
}: Omit<SendThrowState, "key"> & { ref: Ref<ThrowHandle>; onRecalled: () => void }) {
  const nodeRef = useRef<HTMLDivElement>(null);
  const vectorRef = useRef({ dx: 0, dy: 0 });
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const scaleX = useMotionValue(1);
  const scaleY = useMotionValue(1);
  useImperativeHandle(ref, () => ({ node: nodeRef.current, x, y }), [x, y]);

  useLayoutEffect(() => {
    const node = nodeRef.current;
    if (!node) return;
    // 落点：升到输入框上方，右缘对齐输入框右缘，靠向自己那一侧的气泡。
    const vector = {
      dx: Math.max(0, anchor.maxWidth - node.offsetWidth),
      dy: -anchor.height * chatThrow.lift,
    };
    vectorRef.current = vector;
    const { impulse, launch } = chatThrow;
    const velocity = byAxes(vector, impulse.along, impulse.across);
    const springs = byAxes<Transition>(vector, spring.thrust, spring.wobble);
    const controls = [
      animate(x, vector.dx, springWithVelocity(spring.push, launch, 0, vector.dx)),
      animate(y, vector.dy, springWithVelocity(spring.thrust, launch, 0, vector.dy)),
      animate(scaleX, 1, { ...springs.scaleX, velocity: velocity.scaleX }),
      animate(scaleY, 1, { ...springs.scaleY, velocity: velocity.scaleY }),
    ];
    return () => controls.forEach((control) => control.stop());
  }, [anchor, x, y, scaleX, scaleY]);

  useLayoutEffect(() => {
    if (phase !== "recall") return;
    const shape = byAxes(vectorRef.current, chatThrow.into.along, chatThrow.into.across);
    const controls = [
      animate(x, 0, spring.recall),
      animate(y, 0, spring.recall),
      animate(scaleX, shape.scaleX, spring.recall),
      animate(scaleY, shape.scaleY, spring.recall),
    ];
    void Promise.all(controls.map((control) => control.finished)).then(onRecalled);
    return () => controls.forEach((control) => control.stop());
  }, [phase, x, y, scaleX, scaleY, onRecalled]);

  return createPortal(
    <motion.div
      ref={nodeRef}
      aria-hidden="true"
      className="pointer-events-none fixed z-popover flex items-center truncate rounded-xl rounded-br-sm bg-primary px-3 text-sm text-primary-foreground shadow-2xs"
      style={{
        left: anchor.left,
        top: anchor.top,
        height: anchor.height,
        maxWidth: anchor.maxWidth,
        x,
        y,
        scaleX,
        scaleY,
      }}
    >
      {text}
    </motion.div>,
    document.body
  );
}

/**
 * 发送的第二段：回显的气泡从胶囊手里接过这条消息。
 * 先藏两帧（`visibility`，不经过透明度）等列表滚到底，再量出胶囊此刻的位置与尺寸，
 * 把气泡摆到胶囊上、继承胶囊的速度，按 thrust / wobble 飞进自己的落点；气泡显形与胶囊撤掉在同一帧。
 */
function useThrowHandoff(
  ref: RefObject<HTMLDivElement | null>,
  bubbleRef: RefObject<HTMLDivElement | null>,
  handoff: ThrowHandoff | undefined
) {
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !handoff) return;
    node.style.visibility = "hidden";
    let frame = 0;
    let stop: (() => void) | undefined;
    const reset = () => {
      node.style.visibility = "";
      node.style.transform = "";
      node.style.transformOrigin = "";
    };
    const take = () => {
      const capsule = handoff.capsule.current;
      const bubble = bubbleRef.current;
      if (!capsule?.node || !bubble) {
        node.style.visibility = "";
        return;
      }
      const shell = node.getBoundingClientRect();
      const own = bubble.getBoundingClientRect();
      const from = capsule.node.getBoundingClientRect();
      const ownCenter = centerOf(own);
      const fromCenter = centerOf(from);
      const vector = { dx: fromCenter.x - ownCenter.x, dy: fromCenter.y - ownCenter.y };
      const startScaleX = handoffScale(from.width, own.width);
      const startScaleY = handoffScale(from.height, own.height);
      // 以气泡中心为缩放原点：气泡与胶囊重合，名字随气泡一起被带过来。
      node.style.transformOrigin = `${ownCenter.x - shell.left}px ${ownCenter.y - shell.top}px`;
      const springs = byAxes<Transition>(vector, spring.thrust, spring.wobble);
      const controls = animate(
        node,
        {
          x: [vector.dx, 0],
          y: [vector.dy, 0],
          scaleX: [startScaleX, 1],
          scaleY: [startScaleY, 1],
        },
        {
          x: { ...spring.thrust, velocity: capsule.x.getVelocity() },
          y: { ...spring.thrust, velocity: capsule.y.getVelocity() },
          scaleX: springs.scaleX,
          scaleY: springs.scaleY,
        }
      );
      stop = () => controls.stop();
      void controls.finished.then(reset);
      // animate 在下一帧才写上第一帧；排在它之后再交接，气泡不会在落点上闪现一帧。
      frame = requestAnimationFrame(() => {
        node.style.visibility = "";
        capsule.node!.style.visibility = "hidden";
        handoff.onTake();
      });
    };
    // 两帧：第一帧里自动滚到底（UseAutoScrollToBottom 的 rAF 排在这之后），第二帧量到的才是落点。
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(take);
    });
    return () => {
      cancelAnimationFrame(frame);
      stop?.();
      reset();
    };
  }, [ref, bubbleRef, handoff]);
}

/** 气泡外壳：贴合内容宽度，接手胶囊时整体被带过来。 */
export function MessageShell({
  handoff,
  isMe,
  children,
}: {
  handoff?: ThrowHandoff;
  isMe: boolean;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  useThrowHandoff(ref, bubbleRef, handoff);
  return (
    <div
      ref={ref}
      className={cn("flex min-w-0 max-w-[85%] flex-col", isMe ? "items-end" : "items-start")}
    >
      <BubbleRefContext.Provider value={bubbleRef}>{children}</BubbleRefContext.Provider>
    </div>
  );
}
