export interface HttpRequest {
  method: string;
  headers?: Record<string, string>;
  body?: BodyInit | null;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  json<T = unknown>(): Promise<T>;
  text(): Promise<string>;
}

export interface HttpTransport {
  request(url: string, init: HttpRequest): Promise<HttpResponse>;
}

export class FetchHttpTransport implements HttpTransport {
  constructor(private readonly defaultTimeoutMs = 30_000) {}

  async request(url: string, init: HttpRequest): Promise<HttpResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), init.timeoutMs ?? this.defaultTimeoutMs);
    try {
      const requestInit: RequestInit = {
        method: init.method,
        body: init.body ?? null,
        signal: controller.signal,
      };
      if (init.headers) requestInit.headers = init.headers;
      const response = await fetch(url, requestInit);
      return response;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function retryAfterMs(headers: Headers, now = Date.now()): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(24 * 60 * 60 * 1000, Math.ceil(seconds * 1000));
  const date = Date.parse(raw);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, Math.min(24 * 60 * 60 * 1000, date - now));
}
