import { reserveSessionRecovery } from "@/lib/SessionRecovery";

function isRecoverableChunkLoadError(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  return /^(Failed to fetch dynamically imported module(?::|$)|error loading dynamically imported module(?::|$)|Importing a module script failed\.?$)/i.test(error.message);
}

export const retryLazyImport = <T,>(loader: () => Promise<T>, key: string): Promise<T> =>
  loader().catch((error) => {
    if (isRecoverableChunkLoadError(error) && reserveSessionRecovery(`bakagame:chunk-retry:${key}`)) {
      window.location.reload();
    }
    throw error;
  });
