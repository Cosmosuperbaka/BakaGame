/** 按需生成霞鹜文楷子集并注入 index.css。 */
import { type Plugin } from "vite";
import path from "path";
import fs from "fs";

const FONT_FACE_MARKER = "/* __LXGW_WENKAI_FONT_FACES__ */";
const INDEX_CSS_PATH = path.resolve(import.meta.dirname, "../../src/index.css");

export function generatedFontsPlugin(): Plugin {
  let generated: Promise<{ css: string }> | undefined;
  const ensure = () => {
    if (!generated) {
      generated = import("../build-fonts.mjs")
        .then(({ ensureFonts }) => ensureFonts())
        .catch((error: unknown) => {
          generated = undefined;
          throw error;
        });
    }
    return generated;
  };

  return {
    name: "generated-fonts",
    enforce: "pre",
    async buildStart() {
      await ensure();
    },
    async configureServer() {
      await ensure();
    },
    async load(id) {
      if (id.startsWith("\0")) return null;
      if (path.resolve(id.split("?")[0]) !== INDEX_CSS_PATH) return null;
      const code = await fs.promises.readFile(INDEX_CSS_PATH, "utf8");
      if (!code.includes(FONT_FACE_MARKER)) {
        throw new Error("src/index.css 缺少霞鹜文楷 @font-face 占位注释");
      }
      const { css } = await ensure();
      return code.replace(FONT_FACE_MARKER, css.trim());
    },
  };
}
