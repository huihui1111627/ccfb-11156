import type {
  BatchRequest,
  BatchResponse,
  Destination,
  ItemResult,
  PlatformAdapter,
} from '../types.js';

export class PlatformHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
    readonly retryable: boolean,
    readonly retryAfterMs = 0,
  ) {
    super(message);
    this.name = 'PlatformHttpError';
  }
}

/** HTTP adapter: one instance serves all destinations, keyed by baseUrl. */
export class HttpPlatformAdapter implements PlatformAdapter {
  private async request(
    destination: Destination,
    path: string,
    init: RequestInit,
  ): Promise<{ status: number; body: unknown; latencyMs: number }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), destination.config.requestTimeoutMs);
    const started = Date.now();
    try {
      const response = await fetch(`${destination.baseUrl.replace(/\/$/, '')}${path}`, {
        ...init,
        signal: controller.signal,
        headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      });
      const latencyMs = Date.now() - started;
      const text = await response.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      return { status: response.status, body, latencyMs };
    } finally {
      clearTimeout(timer);
    }
  }

  async sendBatch(destination: Destination, req: BatchRequest): Promise<BatchResponse> {
    const { status, body, latencyMs } = await this.request(
      destination,
      `/v1/audience/${encodeURIComponent(req.audienceId)}/members`,
      {
        method: 'POST',
        body: JSON.stringify({
          action: req.action,
          businessDate: req.businessDate,
          batchId: req.batchId,
          contacts: req.contacts,
        }),
      },
    );
    if (status === 429) {
      const retryAfterMs = Number((body as { retryAfterMs?: number } | null)?.retryAfterMs ?? 1000);
      throw new PlatformHttpError('平台限速 429', status, body, true, retryAfterMs);
    }
    if (status === 413) {
      throw new PlatformHttpError('批次超过平台上限 413', status, body, false);
    }
    if (status >= 500) {
      throw new PlatformHttpError(`平台 5xx: ${status}`, status, body, true);
    }
    if (status >= 400) {
      throw new PlatformHttpError(`平台错误: ${status}`, status, body, false);
    }
    const parsed = body as {
      results?: ItemResult[];
      quota?: { limit: number; used: number; remaining: number };
      acceptedAdds?: number;
    } | null;
    return {
      results: parsed?.results ?? [],
      quota: parsed?.quota ?? {
        limit: destination.config.dailyQuota,
        used: 0,
        remaining: destination.config.dailyQuota,
      },
      acceptedAdds: parsed?.acceptedAdds ?? 0,
      httpStatus: status,
      latencyMs,
    };
  }

  async getUsage(
    destination: Destination,
    businessDate: string,
  ): Promise<{ limit: number; used: number; remaining: number }> {
    const { status, body } = await this.request(
      destination,
      `/v1/usage?date=${encodeURIComponent(businessDate)}`,
      { method: 'GET' },
    );
    if (status >= 400) throw new PlatformHttpError(`查询配额失败: ${status}`, status, body, status >= 500);
    return body as { limit: number; used: number; remaining: number };
  }

  async health(destination: Destination): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const started = Date.now();
    try {
      const { status } = await this.request(destination, '/health', { method: 'GET' });
      return { ok: status === 200, latencyMs: Date.now() - started };
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - started, error: (error as Error).message };
    }
  }

  async mockState(destination: Destination): Promise<unknown> {
    const { status, body } = await this.request(destination, '/mock/state', { method: 'GET' });
    if (status >= 400) throw new PlatformHttpError(`读取 mock 状态失败: ${status}`, status, body, false);
    return body;
  }

  async updateMockConfig(destination: Destination, patch: Record<string, unknown>): Promise<unknown> {
    const { status, body } = await this.request(destination, '/mock/config', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    if (status >= 400) throw new PlatformHttpError(`更新 mock 配置失败: ${status}`, status, body, false);
    return body;
  }
}
