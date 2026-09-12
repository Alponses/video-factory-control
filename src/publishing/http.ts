import { Readable } from 'node:stream';

export type HttpRequestBody = BodyInit | Readable | null;

export interface HttpRequest {
  method: string;
  headers?: Record<string, string>;
  body?: HttpRequestBody;
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
      const requestInit: RequestInit & { duplex?: 'half' } = {
        method: init.method,
        signal: controller.signal,
      };
      if (init.headers) requestInit.headers = init.headers;
      if (init.body !== undefined && init.body !== null) {
        if (init.body instanceof Readable) {
          requestInit.body = Readable.toWeb(init.body) as unknown as BodyInit;
          requestInit.duplex = 'half';
        } else {
          requestInit.body = init.body;
        }
      }
      return await fetch(url, requestInit);
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
