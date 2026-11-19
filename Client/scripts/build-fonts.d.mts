export interface GeneratedFontManifest {
  version: number;
  inputHash: string;
  fontVersion: string;
  cssSha256: string;
  counts: {
    gb2312: number;
    subtlex: number;
    sansTotal: number;
    sansBase: number;
    sansExtended: number;
    sansCommon: number;
    monoBase: number;
  };
  chunks: {
    sans: Record<string, number>;
    mono: Record<string, number>;
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
