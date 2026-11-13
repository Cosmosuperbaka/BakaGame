/** 把 public 图片构建期转制 WebP 并改写引用路径。 */
import { preparePublicWebp } from "../prepare-public-webp.mjs";

export function publicWebpPlugin(prepare = preparePublicWebp) {
  let assetMap: Record<string, string> = {};

  const rewritePaths = (text: string) => {
    let transformed = text;
    for (const [sourcePath, targetPath] of Object.entries(assetMap)) {
      transformed = transformed.replaceAll(sourcePath, targetPath);
    }
    return transformed;
  };

  return {
    name: "public-webp",
    async config() {
      const prepared = await prepare();
      assetMap = prepared.assetMap;
      return { publicDir: prepared.publicDir };
    },
    configureServer(server: {
      middlewares: {
        use: (fn: (req: { url?: string }, _res: unknown, next: () => void) => void) => void;
      };
    }) {
      server.middlewares.use((req, _res, next) => {
        if (req.url) {
          const [pathname, query] = req.url.split("?");
          const target = assetMap[pathname];
          if (target) {
            req.url = target + (query ? `?${query}` : "");
          }
        }
        next();
      });
    },
    transformIndexHtml(html: string) {
      return rewritePaths(html)
        .replace(
          /<link\b([^>]*\brel=["']icon["'][^>]*\bhref=["'][^"']*\.webp["'][^>]*)>/gi,
          (match) => {
            return match.replace(/type=["']image\/[a-z0-9+]+["']/i, 'type="image/webp"');
          }
        )
        .replace(
          /<link\b([^>]*\bhref=["'][^"']*\.webp["'][^>]*\brel=["']icon["'][^>]*)>/gi,
          (match) => {
            return match.replace(/type=["']image\/[a-z0-9+]+["']/i, 'type="image/webp"');
          }
        );
    },
    transform(code: string, id: string) {
      if (id.includes("node_modules") || id.startsWith("\0")) return null;

      if (!Object.keys(assetMap).some((sourcePath) => code.includes(sourcePath))) return null;

      return {
        code: rewritePaths(code),
        map: null,
      };
    },
  };
}
