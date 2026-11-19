export interface PreparedPublicWebp {
  publicDir: string;
  assetMap: Record<string, string>;
}

export function preparePublicWebp(): Promise<PreparedPublicWebp>;
export function stickerAssetUrl(relativePath: string, contents: Uint8Array): string;
