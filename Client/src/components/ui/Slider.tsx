import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";
import { cn } from "@/lib/Utils";

/**
 * 轨道粗细与滑块外观默认取设置面板的口径；顶栏音量这类紧凑场景经 `trackClassName` / `thumbClassName`
 * 换成细轨道、悬停变粗，调用处只改尺寸与显隐，不改颜色。
 */
const Slider = React.forwardRef<
  React.ComponentRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root> & { trackClassName?: string; thumbClassName?: string }
>(({
  className, trackClassName, thumbClassName,
  "aria-label": ariaLabel, "aria-labelledby": ariaLabelledBy, "aria-describedby": ariaDescribedBy, "aria-valuetext": ariaValueText,
  ...props
}, ref) => (
  <SliderPrimitive.Root
    ref={ref}
    aria-label={ariaLabel}
    className={cn(
      // Radix 用 data-disabled 标记禁用（不触发 :disabled），并自行拦截指针与键盘；这里只让整条轨道一起变淡。
      "relative flex w-full touch-none select-none items-center data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
      className
    )}
    {...props}
  >
    <SliderPrimitive.Track className={cn("relative h-1.5 w-full grow overflow-hidden rounded-full bg-muted", trackClassName)}>
      <SliderPrimitive.Range className="absolute h-full bg-primary" />
    </SliderPrimitive.Track>
    {/* 读屏与按名查找落在拇指（role="slider"）上：命名、说明与取值文字都转交给它，根节点只是布局容器。 */}
    <SliderPrimitive.Thumb
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-describedby={ariaDescribedBy}
      aria-valuetext={ariaValueText}
      className={cn(
        "block h-4 w-4 rounded-full border-2 border-background bg-primary shadow-sm",
        "transition-colors focus-visible:outline-offset-2",
        thumbClassName
      )}
    />
  </SliderPrimitive.Root>
));
Slider.displayName = SliderPrimitive.Root.displayName;

export { Slider };
