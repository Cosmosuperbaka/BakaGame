import { reserveSessionRecovery } from "@/lib/SessionRecovery";

export const retryLazyImport = <T,>(loader: () => Promise<T>, key: string): Promise<T> =>
  loader().catch((error) => {
    if (reserveSessionRecovery(`bakagame:chunk-retry:${key}`)) {
      window.location.reload();
      return new Promise<T>(() => {});
    }
    throw error;
  });
