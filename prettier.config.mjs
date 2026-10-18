/** @type {import("prettier").Config} */
export default {
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  semi: true,
  singleQuote: false,
  jsxSingleQuote: false,
  trailingComma: "es5",
  arrowParens: "always",
  bracketSpacing: true,
  bracketSameLine: false,
  // 仓库内既有 CRLF（Windows 工作区）也有 LF（CI 检出），auto 会保留每个文件原本的行尾，
  // 不制造整文件级 diff。不要改成 "lf" 或 "crlf"。
  endOfLine: "auto",
  proseWrap: "preserve",
};
