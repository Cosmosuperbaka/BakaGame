declare module "@neteasecloudmusicapienhanced/api/util/request" {
  const request: (...args: unknown[]) => Promise<{
    status: number;
    body: Record<string, unknown>;
    cookie?: string[];
  }>;
  export default request;
}

declare module "@neteasecloudmusicapienhanced/api/util/option" {
  const createOption: (query: Record<string, unknown>, crypto?: string, checkToken?: boolean) => unknown;
  export default createOption;
}

declare module "@neteasecloudmusicapienhanced/unblockmusic-utils" {
  export const matchID: (
    id: string | number,
    source?: string | null,
  ) => Promise<{
    code: number;
    message?: string;
    data?: {
      url?: string;
      source?: string;
    } | null;
  }>;
}
