import { createHash } from "node:crypto";

/**
 * 上游版本与发布资产摘要固定在这里。GitHub Release 的 API 会给出官方 SHA-256；
 * 下载后先核对长度与摘要，校验不过不落盘。升级字体时同时改版本、URL 与摘要。
 */
export const FONT_RELEASE = Object.freeze({
  version: "1.530",
  tag: "v1.530",
  // raw 是仓库内容，Release 是发布产物；两处都提供同一批官方文件。
  // 国内网络对 github.com 的 Release 重定向经常不可达，因此 raw 优先。
  baseUrls: Object.freeze([
    "https://raw.githubusercontent.com/lxgw/LxgwWenKai/v1.530/fonts/TTF/",
    "https://github.com/lxgw/LxgwWenKai/releases/download/v1.530/",
  ]),
  files: Object.freeze({
    "LXGWWenKai-Regular.ttf": {
      bytes: 25_928_940,
      sha256: "2d73eea94ad808999d90c0000c239a84a33b09d4bc6ab6c5b8bbf1eda8a7fc8b",
    },
    "LXGWWenKai-Medium.ttf": {
      bytes: 25_800_076,
      sha256: "f4b8a34d1f838fe411540cb7c97b1c384ac9738a876c4104500bc42508b2312a",
    },
    "LXGWWenKaiMono-Regular.ttf": {
      bytes: 25_957_300,
      sha256: "895ce1d2fa00d5ca3bec0329d38e3190454f4b5fa7b4733f491c419faf9753a1",
    },
    "LXGWWenKaiMono-Medium.ttf": {
      bytes: 25_864_536,
      sha256: "87edc1b6e2a5a6aae1f91b0a600538f3b2924e0f69c0080b97e50cd6f8763546",
    },
  }),
});

export const FONT_VERSION = FONT_RELEASE.version;
export const FONT_SOURCE_DIRNAME = `lxgw-wenkai-v${FONT_VERSION}`;
export const FONT_LICENSE_SOURCE = "assets/fonts/lxgw-wenkai/OFL.txt";
export const GENERATED_FAMILY_DIR = "lxgw-wenkai";
export const GENERATED_CSS_NAME = "lxgw-wenkai.css";
export const GENERATED_MANIFEST_NAME = "lxgw-wenkai.manifest.json";
export const GENERATED_ASSET_URL_PREFIX = `./assets/fonts/${GENERATED_FAMILY_DIR}/`;

/**
 * 字重只保留实际会用到的两档（400、500）：界面里没有任何 300 及更细的字重，
 * 声明它只会白白多出一半的子集文件与样式规则。WenKai 没有 700，浏览器会在 500 的基础上
 * 合成粗体，因此不要在 CSS 里声明 600/700，否则会拿到一档不存在的字重。
 * 新增细字重用法时先在这里恢复对应档位（连同 FONT_RELEASE 里的源文件摘要）。
 */
export const FAMILIES = Object.freeze([
  {
    id: "sans",
    family: "LXGW WenKai",
    coverage: "cjk",
    weights: [
      { weight: 400, file: "LXGWWenKai-Regular.ttf" },
      { weight: 500, file: "LXGWWenKai-Medium.ttf" },
    ],
  },
  {
    id: "mono",
    family: "LXGW WenKai Mono",
    coverage: "data",
    weights: [
      { weight: 400, file: "LXGWWenKaiMono-Regular.ttf" },
      { weight: 500, file: "LXGWWenKaiMono-Medium.ttf" },
    ],
  },
]);

/**
 * 分片大小按「一个字约 250 字节」折算成下载量：常用字块要大到少发请求，越往后越稀有，
 * 块越小——页面里零星出现一个冷僻字时，只该多下一小片，而不是一整片两千字（约 0.5MB）。
 */
export const CHUNK_SIZES = Object.freeze({
  base: 700,
  common: 400,
  frequent: 250,
  gb2312: 400,
  rest: 2_000,
});
export const COMMON_CHAR_COUNT = 2_000;

/**
 * 无衬线体还要承担拉丁文与符号。只取字体里实际存在、且日常界面会用到的块；
 * 音标、CJK 部首、封闭式 CJK 兼容字等不做覆盖，缺字交给后面的系统字体兜底。
 */
export const SANS_BASE_RANGES = Object.freeze([
  [0x0020, 0x007e],
  [0x00a0, 0x024f],
  [0x02b0, 0x02ff],
  [0x0300, 0x036f],
  [0x0370, 0x04ff],
  [0x1e00, 0x1eff],
  [0x2000, 0x206f],
  [0x2070, 0x209f],
  [0x20a0, 0x20cf],
  [0x2100, 0x214f],
  [0x2150, 0x218f],
  [0x2190, 0x22ff],
  [0x2300, 0x23ff],
  [0x2460, 0x24ff],
  [0x2500, 0x257f],
  [0x25a0, 0x25ff],
  [0x2600, 0x27bf],
  [0x27f0, 0x2bff],
  [0x3000, 0x303f],
  [0x3040, 0x30ff],
  [0x3100, 0x312f],
  [0x31a0, 0x31bf],
  [0x31f0, 0x31ff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xffef],
]);

/**
 * 等宽体只承载房间号、链接、哈希、时间戳与代码片段，CJK 与假名交给后面的 WenKai。
 * 这里保留代码里常见的制表、箭头、数学与全角符号，避免回退到系统等宽体后宽度跳变。
 */
export const MONO_BASE_RANGES = Object.freeze([
  [0x0020, 0x007e],
  [0x00a0, 0x024f],
  [0x0300, 0x036f],
  [0x0370, 0x04ff],
  [0x2000, 0x206f],
  [0x2070, 0x209f],
  [0x20a0, 0x20cf],
  [0x2100, 0x214f],
  [0x2150, 0x218f],
  [0x2190, 0x22ff],
  [0x2300, 0x23ff],
  [0x2460, 0x24ff],
  [0x2500, 0x257f],
  [0x25a0, 0x25ff],
  [0x27f0, 0x2bff],
  [0xff00, 0xffef],
]);

const CJK_RANGES = Object.freeze([
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xf900, 0xfaff],
  [0x20000, 0x2fa1f],
]);

let gb2312Cache;

/**
 * GB2312 一级与二级汉字。用标准编码区间解码得到，避免把一份来源不明的字表塞进仓库。
 * 运行时自带完整 ICU 才能解出中文；Node 24 起默认满足，缺失时直接报错而不是静默少字。
 */
export function gb2312Codepoints() {
  if (gb2312Cache) return gb2312Cache;
  let decoder;
  try {
    decoder = new TextDecoder("gb2312", { fatal: true });
  } catch {
    throw new Error("当前 Node 缺少 gb2312 TextDecoder，无法生成常用字表");
  }
  const codepoints = [];
  for (let high = 0xb0; high <= 0xf7; high += 1) {
    for (let low = 0xa1; low <= 0xfe; low += 1) {
      try {
        const [character] = decoder.decode(Uint8Array.from([high, low]));
        if (character) codepoints.push(character.codePointAt(0));
      } catch {
        // 区间里存在未分配的码位，跳过即可。
      }
    }
  }
  gb2312Cache = [...new Set(codepoints)];
  if (gb2312Cache.length < 6_000) {
    throw new Error(`GB2312 解码结果异常：只有 ${gb2312Cache.length} 个汉字`);
  }
  return gb2312Cache;
}

export function isCjkCodepoint(codepoint) {
  return CJK_RANGES.some(([start, end]) => codepoint >= start && codepoint <= end);
}

export function codepointsFromRanges(ranges) {
  const codepoints = [];
  for (const [start, end] of ranges) {
    for (let codepoint = start; codepoint <= end; codepoint += 1) {
      codepoints.push(codepoint);
    }
  }
  return codepoints;
}

/** 合并连续码位，输出 Google Fonts 同款的 unicode-range 文本。 */
export function formatUnicodeRange(codepoints) {
  const sorted = [...new Set(codepoints)].sort((left, right) => left - right);
  if (sorted.length === 0) return "";
  const parts = [];
  let start = sorted[0];
  let previous = sorted[0];
  for (const codepoint of sorted.slice(1)) {
    if (codepoint === previous + 1) {
      previous = codepoint;
      continue;
    }
    parts.push(start === previous ? `U+${hex(start)}` : `U+${hex(start)}-${hex(previous)}`);
    start = previous = codepoint;
  }
  parts.push(start === previous ? `U+${hex(start)}` : `U+${hex(start)}-${hex(previous)}`);
  return parts.join(",");
}

function hex(codepoint) {
  return codepoint.toString(16).toUpperCase();
}

export function chunkCodepoints(codepoints, size) {
  if (!Number.isInteger(size) || size <= 0) throw new Error(`分包大小必须是正整数：${size}`);
  const chunks = [];
  for (let index = 0; index < codepoints.length; index += size) {
    chunks.push(codepoints.slice(index, index + size));
  }
  return chunks;
}

/**
 * 分片按「出现概率」从高到低分层，越稀有的层块越小：
 * base（基础字符，按码位）→ common（词频前 N，按词频）→ frequent（其余有词频的字，按词频）
 * → gb2312（词频表之外的国标汉字）→ rest（完整字符集的剩余，按码位）。
 * 每个字只落在一片里，浏览器按 unicode-range 命中才下载，所以块越小、冷僻字的代价越小。
 * 分片只决定字落在哪个文件，不改任何字形数据；分片不依赖项目源码里出现了哪些字，
 * 新增文案不会使字体缓存失效。
 */
export function buildChunkPlan({
  baseCodepoints,
  extendedCodepoints = [],
  frequencyOrder = [],
  gb2312Order = [],
  chunkSizes = CHUNK_SIZES,
  commonCodepointCount = COMMON_CHAR_COUNT,
}) {
  const sizes = { ...CHUNK_SIZES, ...chunkSizes };
  const base = new Set(baseCodepoints);
  const extended = new Set(extendedCodepoints);
  for (const codepoint of extended) {
    if (base.has(codepoint)) {
      throw new Error(`基础字符与扩展字符重复：U+${hex(codepoint)}`);
    }
  }

  const placed = new Set();
  const takeInOrder = (order, limit = Infinity) => {
    const taken = [];
    for (const codepoint of order) {
      if (!extended.has(codepoint) || placed.has(codepoint)) continue;
      placed.add(codepoint);
      taken.push(codepoint);
      if (taken.length >= limit) break;
    }
    return taken;
  };
  const common = takeInOrder(frequencyOrder, commonCodepointCount);
  const frequent = takeInOrder(frequencyOrder);
  const gb2312 = takeInOrder(gb2312Order);
  const rest = [...extended].filter((codepoint) => !placed.has(codepoint)).sort((a, b) => a - b);

  const sections = [
    { kind: "base", codepoints: [...base].sort((a, b) => a - b), size: sizes.base },
    { kind: "common", codepoints: common, size: sizes.common },
    { kind: "frequent", codepoints: frequent, size: sizes.frequent },
    { kind: "gb2312", codepoints: gb2312, size: sizes.gb2312 },
    { kind: "rest", codepoints: rest, size: sizes.rest },
  ];
  const chunks = [];
  for (const section of sections) {
    for (const cps of chunkCodepoints(section.codepoints, section.size)) {
      chunks.push({ index: chunks.length, kind: section.kind, cps });
    }
  }
  return chunks;
}

export function fontFileName(familyId, weight, index) {
  return `lxgw-wenkai-${familyId}-${weight}-${String(index).padStart(2, "0")}.woff2`;
}

export function fontFaceRule({ family, weight, fileName, codepoints, urlPrefix }) {
  const range = formatUnicodeRange(codepoints);
  if (!range) throw new Error(`${family} ${weight} 的分片没有任何字符`);
  return `@font-face { font-family: "${family}"; font-style: normal; font-weight: ${weight}; font-display: swap; src: url("${urlPrefix ?? GENERATED_ASSET_URL_PREFIX}${fileName}") format("woff2"); unicode-range: ${range}; }`;
}

export function buildFontCss({ sansChunks, monoChunks }) {
  const lines = [
    "/* Generated by Client/scripts/build-fonts.mjs; do not edit. */",
    "/* Font license: /assets/fonts/lxgw-wenkai/OFL.txt */",
  ];
  for (const family of FAMILIES) {
    const chunks = family.id === "sans" ? sansChunks : monoChunks;
    for (const { weight } of family.weights) {
      for (const chunk of chunks) {
        lines.push(
          fontFaceRule({
            family: family.family,
            weight,
            fileName: fontFileName(family.id, weight, chunk.index),
            codepoints: chunk.cps,
          })
        );
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function hashCodepoints(codepoints) {
  return sha256([...new Set(codepoints)].sort((a, b) => a - b).join(","));
}

export function hashText(text) {
  return sha256(Buffer.from(text, "utf8"));
}
