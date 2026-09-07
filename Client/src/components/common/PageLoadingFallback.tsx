import { motion } from "framer-motion";
import { Loader2 } from "lucide-react";
import { spinner } from "@/lib/Motion";

export function PageLoadingFallback() {
  return (
    <div
      role="status"
      aria-label="页面加载中"
      className="flex min-h-screen w-full items-center justify-center bg-background text-foreground"
    >
      <motion.div {...spinner}>
        <Loader2 className="h-8 w-8 text-primary" />
      </motion.div>
      <span className="sr-only">页面加载中</span>
    </div>
  );
}

export default PageLoadingFallback;
