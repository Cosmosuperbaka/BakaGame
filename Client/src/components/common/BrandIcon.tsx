import { BRAND_ICON_PATHS, type BrandIconName } from "@/data/BrandIconPaths";
import { cn } from "@/lib/Utils";

interface BrandIconProps {
  name: BrandIconName;
  className?: string;
}

/**
 * 品牌图标：装饰性内联 SVG，颜色跟随文字，尺寸按字号（1em 高、1.25em 宽，基线下沉 0.125em），
 * 与此前 Font Awesome 的默认盒模型一致，调用方只需用字号类定尺寸。
 */
export function BrandIcon({ name, className }: BrandIconProps) {
  const { width, path } = BRAND_ICON_PATHS[name];
  return (
    <svg
      viewBox={`0 0 ${width} 512`}
      role="img"
      aria-hidden="true"
      // 盒尺寸走行内样式：Button 的 `[&_svg]:size-4` 特异性更高，工具类压不过它，
      // 而此前的图标库样式不进层叠层、天然压过它；换实现后尺寸仍只能经字号给。
      style={{ width: "1.25em", height: "1em" }}
      className={cn("inline-block overflow-visible align-[-0.125em]", className)}
    >
      <path fill="currentColor" d={path} />
    </svg>
  );
}
