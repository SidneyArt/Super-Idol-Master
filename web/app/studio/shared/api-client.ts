export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8787";

type Fetch = (
  input: string | URL | globalThis.Request,
  init?: RequestInit,
) => Promise<Response>;

export class ApiError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

export type ApiClient = {
  get<T>(path: string, init?: RequestInit): Promise<T>;
  request<T>(path: string, init?: RequestInit): Promise<T>;
};

export function createApiClient(options: {
  baseUrl?: string;
  fetch?: Fetch;
} = {}): ApiClient {
  const baseUrl = options.baseUrl ?? API_BASE;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const reads = new Map<string, Promise<unknown>>();

  async function execute<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    const payload = await response.json().catch(() => null) as {
      error?: string;
    } | null;
    if (!response.ok) {
      throw new ApiError(
        payload?.error || `请求失败（${response.status}）`,
        response.status,
        payload,
      );
    }
    return payload as T;
  }

  function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const method = (init.method || "GET").toUpperCase();
    if (method !== "GET" || init.signal) return execute<T>(path, init);

    const key = `${method}:${path}`;
    const pending = reads.get(key) as Promise<T> | undefined;
    if (pending) return pending;

    const promise = execute<T>(path, init).finally(() => {
      if (reads.get(key) === promise) reads.delete(key);
    });
    reads.set(key, promise);
    return promise;
  }

  return {
    get: <T>(path: string, init?: RequestInit) => request<T>(path, init),
    request,
  };
}

export const apiClient = createApiClient();

export function api<T>(path: string, init?: RequestInit): Promise<T> {
  return apiClient.request<T>(path, init);
}
