/**
 * 根目录站点图标与站点清单。
 *
 * 全站图片管线只产 webp，而百度与部分抓取器只认根目录的 `/favicon.ico`，谷歌要求图标边长是 48 的倍数，
 * 手机「添加到主屏」认触摸图标与清单。这些文件都从同一张源图生成，构建时写进产物根目录，
 * 开发服务器按同样的内容即时返回；不放进 public/，免得被图片管线转成 webp、改写引用。
 *
 * 清单只写站内相对路径，不写任何绝对地址；底色取 index.css 的页面底色令牌，不另抄一份色值。
 */
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { SITE_NAME } from "../../src/data/PageMeta.ts";

const clientDir = path.resolve(import.meta.dirname, "../..");
const SOURCE_ICON = path.join(clientDir, "public/assets/favicon.png");
const THEME_CSS = path.join(clientDir, "src/index.css");

/** 浏览器标签页与搜索结果用的边长（48 的倍数），以及装进 favicon.ico 的几档。 */
const PNG_SIZES = [48, 192, 512] as const;
const ICO_SIZES = [16, 32, 48] as const;
const TOUCH_ICON_SIZE = 180;

/** 读出 `:root` 里某个 oklch 令牌并换成 sRGB 十六进制：清单只认 CSS 颜色字面量里最通用的写法。 */
export function readLightToken(css: string, token: string): string {
  const rootBlock = css.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
  const value = rootBlock.match(new RegExp(`${token}:\\s*oklch\\(([^)]+)\\)`))?.[1];
  if (!value) throw new Error(`站点图标：index.css 的 :root 里找不到 ${token}`);
  const [l, c, h] = value.trim().split(/\s+/).map(Number);
  return oklchToHex(l, c, h);
}

function oklchToHex(l: number, c: number, hueDegrees: number): string {
  const hue = (hueDegrees * Math.PI) / 180;
  const a = c * Math.cos(hue);
  const b = c * Math.sin(hue);
  const lms = [
    (l + 0.3963377774 * a + 0.2158037573 * b) ** 3,
    (l - 0.1055613458 * a - 0.0638541728 * b) ** 3,
    (l - 0.0894841775 * a - 1.291485548 * b) ** 3,
  ];
  const linear = [
    4.0767416621 * lms[0] - 3.3077115913 * lms[1] + 0.2309699292 * lms[2],
    -1.2684380046 * lms[0] + 2.6097574011 * lms[1] - 0.3413193965 * lms[2],
    -0.0041960863 * lms[0] - 0.7034186147 * lms[1] + 1.707614701 * lms[2],
  ];
  return `#${linear
    .map((channel) => {
      const clamped = Math.min(1, Math.max(0, channel));
      const gamma = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
      return Math.round(gamma * 255)
        .toString(16)
        .padStart(2, "0");
    })
    .join("")}`;
}

/** 把几张 PNG 原样装进 ICO 容器：现代浏览器与抓取器都认 PNG 内嵌的 ICO。 */
function packIco(images: { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const entries = images.map(({ size, png }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size, 0);
    entry.writeUInt8(size, 1);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images.map(({ png }) => png)]);
}

/** 生成全部站点图标与清单：文件名（产物根目录下）→ 内容。 */
export async function renderSiteIcons(): Promise<Map<string, Buffer>> {
  const background = readLightToken(fs.readFileSync(THEME_CSS, "utf8"), "--background");
  // 源图是近正方形的头像：居中裁成正方形，不留白边。
  const square = (size: number) =>
    sharp(SOURCE_ICON).resize(size, size, { fit: "cover" }).png().toBuffer();

  const files = new Map<string, Buffer>();
  for (const size of PNG_SIZES) files.set(`favicon-${size}.png`, await square(size));
  files.set(
    "favicon.ico",
    packIco(await Promise.all(ICO_SIZES.map(async (size) => ({ size, png: await square(size) }))))
  );
  // iOS 把透明区域铺成黑底：触摸图标压在页面底色上并去掉透明通道。
  files.set(
    "apple-touch-icon.png",
    await sharp(SOURCE_ICON)
      .resize(TOUCH_ICON_SIZE, TOUCH_ICON_SIZE, { fit: "cover" })
      .flatten({ background })
      .removeAlpha()
      .png()
      .toBuffer()
  );
  const manifest = {
    name: SITE_NAME,
    short_name: SITE_NAME,
    lang: "zh-CN",
    start_url: "/",
    scope: "/",
    // 从主屏打开仍走浏览器：房间邀请靠分享链接，独立窗口没有地址栏，也没有 iOS 的返回手势入口。
    display: "browser",
    background_color: background,
    theme_color: background,
    icons: [192, 512].map((size) => ({
      src: `/favicon-${size}.png`,
      sizes: `${size}x${size}`,
      type: "image/png",
    })),
  };
  files.set("site.webmanifest", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  return files;
}

const CONTENT_TYPES: Record<string, string> = {
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

export function siteIconsPlugin() {
  let distDir = path.resolve(clientDir, "dist");
  let rendered: Promise<Map<string, Buffer>> | null = null;
  const render = () => (rendered ??= renderSiteIcons());
  return {
    name: "site-icons",
    configResolved(config: { root: string; build: { outDir: string } }) {
      distDir = path.resolve(config.root, config.build.outDir);
    },
    // 开发服务器没有产物目录：同样的文件按需生成一次，从内存返回。
    configureServer(server: {
      middlewares: {
        use: (
          fn: (
            req: { url?: string },
            res: { setHeader: (name: string, value: string) => void; end: (body: Buffer) => void },
            next: () => void
          ) => void
        ) => void;
      };
    }) {
      server.middlewares.use((req, res, next) => {
        const name = req.url?.split("?")[0].replace(/^\//, "") ?? "";
        if (!/^(favicon[\w-]*\.(ico|png)|apple-touch-icon\.png|site\.webmanifest)$/.test(name)) {
          next();
          return;
        }
        void render().then((files) => {
          const body = files.get(name);
          if (!body) {
            next();
            return;
          }
          res.setHeader("Content-Type", CONTENT_TYPES[path.extname(name)]);
          res.end(body);
        }, next);
      });
    },
    async closeBundle() {
      const files = await render();
      for (const [name, body] of files) fs.writeFileSync(path.join(distDir, name), body);
      console.log(`站点图标生成完成：${[...files.keys()].join("、")}`);
    },
  };
}
