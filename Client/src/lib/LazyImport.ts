export const retryLazyImport = <T,>(loader: () => Promise<T>, key: string): Promise<T> =>
  loader().catch((error) => {
    const marker = `bakagame:chunk-retry:${key}`;
    if (sessionStorage.getItem(marker) !== "1") {
      sessionStorage.setItem(marker, "1");
      window.location.reload();
      return new Promise<T>(() => {});
    }
    throw error;
  });
