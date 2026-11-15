import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';

export type Handler = (ctx: RequestContext) => Promise<ResponsePayload> | ResponsePayload;

export interface RequestContext {
  req: http.IncomingMessage;
  url: URL;
  params: Record<string, string>;
  body: unknown;
  query: URLSearchParams;
}

export interface ResponsePayload {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  raw?: Buffer;
}

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = 'bad_request',
  ) {
    super(message);
  }
}

export class Router {
  private readonly routes: Route[] = [];
  private staticDir: string | null = null;

  add(method: string, pattern: string, handler: Handler): this {
    const keys: string[] = [];
    const regex = pattern.replace(/:([A-Za-z0-9_]+)/g, (_match, key: string) => {
      keys.push(key);
      return '([^/]+)';
    });
    this.routes.push({ method, pattern: new RegExp(`^${regex}$`), keys, handler });
    return this;
  }

  get(pattern: string, handler: Handler): this {
    return this.add('GET', pattern, handler);
  }
  post(pattern: string, handler: Handler): this {
    return this.add('POST', pattern, handler);
  }
  patch(pattern: string, handler: Handler): this {
    return this.add('PATCH', pattern, handler);
  }
  delete(pattern: string, handler: Handler): this {
    return this.add('DELETE', pattern, handler);
  }

  staticFiles(dir: string): this {
    this.staticDir = path.resolve(dir);
    return this;
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);
    try {
      for (const route of this.routes) {
        if (route.method !== (req.method ?? 'GET')) continue;
        const match = route.pattern.exec(pathname);
        if (!match) continue;
        const params: Record<string, string> = {};
        route.keys.forEach((key, index) => {
          params[key] = match[index + 1] ?? '';
        });
        const body = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method ?? 'GET')
          ? await readJsonBody(req)
          : undefined;
        const payload = await route.handler({ req, url, params, body, query: url.searchParams });
        send(res, payload);
        return;
      }
      if (this.staticDir && (req.method === 'GET' || req.method === 'HEAD')) {
        if (serveStatic(this.staticDir, pathname, res)) return;
      }
      send(res, { status: 404, body: { error: 'not_found', path: pathname } });
    } catch (error) {
      if (error instanceof ApiError) {
        send(res, { status: error.status, body: { error: error.code, message: error.message } });
        return;
      }
      const message = (error as Error).message;
      send(res, { status: 500, body: { error: 'internal_error', message } });
    }
  }
}

function send(res: http.ServerResponse, payload: ResponsePayload): void {
  const status = payload.status ?? 200;
  if (payload.raw) {
    res.writeHead(status, {
      'content-type': 'application/octet-stream',
      ...(payload.headers ?? {}),
    });
    res.end(payload.raw);
    return;
  }
  const body = payload.body === undefined ? '' : JSON.stringify(payload.body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...(payload.headers ?? {}),
  });
  res.end(body);
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 8 * 1024 * 1024) throw new ApiError(413, '请求体过大', 'payload_too_large');
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, '请求体不是合法 JSON', 'invalid_json');
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(root: string, pathname: string, res: http.ServerResponse): boolean {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(root, relative);
  if (!target.startsWith(root + path.sep)) return false;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const data = fs.readFileSync(target);
  res.writeHead(200, {
    'content-type': MIME[path.extname(target)] ?? 'application/octet-stream',
    'content-length': data.length,
    'cache-control': 'no-cache',
  });
  res.end(data);
  return true;
}

export function json(body: unknown, status = 200): ResponsePayload {
  return { status, body };
}
