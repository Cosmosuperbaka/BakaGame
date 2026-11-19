import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { DisclosureChevron } from "@/components/ui/Collapsible";
import { findPageMeta } from "@/data/PageMeta";
import { collapsible } from "@/lib/motion/Choreography";
import { headerTappable } from "@/lib/motion/Feedback";

/**
 * 大厅底部的「玩法说明」：默认收起，放在房间列表之后，不打断「房间是第一层级」。
 *
 * 文字只从 PageMeta 取，与静态外壳给不执行脚本的抓取器看的是同一份——外壳在首帧前被清空，
 * 执行脚本的抓取器与玩家读到的就是这里。所以收起时正文仍留在 DOM 里，用 `hidden="until-found"` 收起：
 * 不占位、读屏跳过，页内查找命中时浏览器会先展开它（随后触发 beforematch，这里同步成展开态）。
 * 不用 `CollapsibleRegion`：它收起即卸载，正文就从页面上消失了。
 */
export function LobbyGuide({ path }: { path: string }) {
  const meta = findPageMeta(path);
  const [open, setOpen] = useState(false);
  // 收起动画播完才真正藏起来；在那之前保持可见，让高度补间有东西可收。
  const [collapsed, setCollapsed] = useState(true);
  const regionRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const regionId = useId();

  const expand = () => {
    setCollapsed(false);
    setOpen(true);
  };

  // React 的 hidden 只认布尔值，`until-found` 由这里写到 DOM 上。
  useLayoutEffect(() => {
    const region = regionRef.current;
    if (!region) return;
    if (collapsed) region.setAttribute("hidden", "until-found");
    else region.removeAttribute("hidden");
  }, [collapsed]);

  useEffect(() => {
    const region = regionRef.current;
    if (!region) return;
    const onBeforeMatch = () => {
      setCollapsed(false);
      setOpen(true);
    };
    region.addEventListener("beforematch", onBeforeMatch);
    return () => region.removeEventListener("beforematch", onBeforeMatch);
  }, []);

  if (!meta) return null;
  const { shell, faq } = meta;

  return (
    <section aria-labelledby={headingId} className="mt-10 border-t border-border pt-4">
      <h2 id={headingId} className="text-sm">
        <motion.button
          type="button"
          {...headerTappable}
          onClick={() => (open ? setOpen(false) : expand())}
          aria-expanded={open}
          aria-controls={regionId}
          className="-mx-1.5 inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 font-serif font-semibold text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground aria-expanded:text-foreground"
        >
          玩法说明
          <DisclosureChevron open={open} />
        </motion.button>
      </h2>
      <motion.div
        ref={regionRef}
        id={regionId}
        variants={collapsible}
        initial={false}
        animate={open ? "animate" : "exit"}
        onAnimationComplete={(definition) => {
          if (definition === "exit") setCollapsed(true);
        }}
      >
        <div className="max-w-prose space-y-5 pt-3 text-sm leading-6 text-muted-foreground">
          {shell.paragraphs.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
          {(shell.sections ?? []).map((section) => (
            <div key={section.heading}>
              <h3 className="font-semibold text-foreground">{section.heading}</h3>
              {section.paragraphs.map((paragraph) => (
                <p key={paragraph} className="mt-1">
                  {paragraph}
                </p>
              ))}
            </div>
          ))}
          <div>
            <h3 className="font-semibold text-foreground">常见问题</h3>
            <dl className="mt-1 space-y-3">
              {faq.map((item) => (
                <div key={item.q}>
                  <dt className="font-medium text-foreground">{item.q}</dt>
                  <dd className="mt-0.5">{item.a}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </motion.div>
    </section>
  );
}
