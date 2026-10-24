export interface GeneratedFontManifest {
  version: number;
  inputHash: string;
  fontVersion: string;
  projectCjkSha256: string;
  cssSha256: string;
  counts: {
    gb2312: number;
    subtlex: number;
    project: number;
    sansTotal: number;
    sansBase: number;
    sansExtended: number;
    sansCommon: number;
    monoBase: number;
  };
  chunks: {
    sans: { base: number; common: number; rest: number };
    mono: { base: number; common: number; rest: number };
  };
  files: Record<string, string>;
  fileBytes: Record<string, number>;
}

export interface GeneratedFonts {
  css: string;
  manifest: GeneratedFontManifest;
}

export function ensureFonts(options?: { force?: boolean }): Promise<GeneratedFonts>;
export function checkFonts(): Promise<void>;
