export type FontFamilyId = "sans" | "mono";
export type FontCoverage = "cjk" | "data";
export type FontChunkKind = "base" | "common" | "rest";

export interface FontWeightSource {
  weight: number;
  file: string;
}

export interface FontFamilyDefinition {
  id: FontFamilyId;
  family: string;
  coverage: FontCoverage;
  weights: readonly FontWeightSource[];
}

export interface FontChunk {
  index: number;
  kind: FontChunkKind;
  cps: number[];
}

export interface ChunkPlanOptions {
  baseCodepoints: readonly number[];
  cjkCodepoints?: readonly number[];
  frequencyOrder?: readonly number[];
  chunkSizes?: { base: number; common: number; rest: number };
  commonCharCount?: number;
}

export interface FontReleaseFile {
  bytes: number;
  sha256: string;
}

export interface FontRelease {
  version: string;
  tag: string;
  baseUrls: readonly string[];
  files: Readonly<Record<string, FontReleaseFile>>;
}

export const FONT_RELEASE: FontRelease;
export const FONT_VERSION: string;
export const FONT_SOURCE_DIRNAME: string;
export const FONT_LICENSE_SOURCE: string;
export const GENERATED_FAMILY_DIR: string;
export const GENERATED_CSS_NAME: string;
export const GENERATED_MANIFEST_NAME: string;
export const GENERATED_ASSET_URL_PREFIX: string;
export const PROJECT_CJK_ROOT: string;
export const FAMILIES: readonly FontFamilyDefinition[];
export const CHUNK_SIZES: { base: number; common: number; rest: number };
export const COMMON_CHAR_COUNT: number;
export const SANS_BASE_RANGES: readonly (readonly [number, number])[];
export const MONO_BASE_RANGES: readonly (readonly [number, number])[];

export function gb2312Codepoints(): number[];
export function isCjkCodepoint(codepoint: number): boolean;
export function codepointsFromRanges(ranges: readonly (readonly [number, number])[]): number[];
export function formatUnicodeRange(codepoints: readonly number[]): string;
export function chunkCodepoints(codepoints: readonly number[], size: number): number[][];
export function buildChunkPlan(options: ChunkPlanOptions): FontChunk[];
export function fontFileName(familyId: FontFamilyId, weight: number, index: number): string;
export function fontFaceRule(input: {
  family: string;
  weight: number;
  fileName: string;
  codepoints: readonly number[];
  urlPrefix?: string;
}): string;
export function buildFontCss(input: {
  sansChunks: readonly FontChunk[];
  monoChunks: readonly FontChunk[];
}): string;
export function collectProjectCjk(sourceDir: string): Promise<number[]>;
export function sha256(buffer: Buffer): string;
export function hashCodepoints(codepoints: readonly number[]): string;
export function hashText(text: string): string;
