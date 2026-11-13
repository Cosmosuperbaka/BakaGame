import { motion } from "framer-motion";
import { useLocation } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Seo } from "@/components/common/Seo";
import { usePageLinkClick, usePageTransitionEnds } from "@/hooks/UsePageTransition";
import { fadeSwap } from "@/lib/motion/NamedMoves";
import { pressable } from "@/lib/motion/Feedback";
import { NOT_FOUND_PAGE } from "@/data/PageMeta";

/**
 * 站内没有的地址：明说页面不存在并给回首页的入口，而不是静默跳回首页——
 * 跳回首页等于对抓取器说「这里有一张首页」，乱码地址会被当成首页的重复页。
 * 三款游戏子路径下打错的地址仍退回各自大厅，那是有意的容错，不走这里。
 */
export default function NotFoundPage() {
  const { pathname } = useLocation();
  const linkClick = usePageLinkClick();
  // 经页面过渡到达时显影已由过渡快照完成；直接打开链接时才自己显影。
  const arriving = usePageTransitionEnds() !== null;
  return (
    <motion.div
      variants={fadeSwap}
      initial={arriving ? false : "initial"}
      animate="animate"
      className="flex h-full min-h-0 flex-col items-center justify-center px-6 py-10"
    >
      <Seo
        path={pathname}
        title={NOT_FOUND_PAGE.title}
        description={NOT_FOUND_PAGE.description}
        indexable={false}
      />
      <main className="flex max-w-sm flex-col items-center text-center">
        <p className="font-mono text-xs text-muted-foreground">404</p>
        <h1 className="mt-2 text-2xl font-bold">页面不存在</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          这个地址没有对应的页面，可能是链接打错了。
        </p>
        <Button asChild variant="outline" size="sm" className="mt-6">
          <motion.a href="/" onClick={linkClick("/")} {...pressable}>
            回到首页
          </motion.a>
        </Button>
      </main>
    </motion.div>
  );
}
