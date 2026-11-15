import type { AppRepo } from '../db/appRepo.js';
import type { Warehouse } from '../db/warehouse.js';
import type { PlatformAdapter, RunPreview, RunSummary, SyncTask } from '../types.js';
import { PreviewEngine, type BuildPreviewOptions } from './preview.js';
import { SyncEngine, type SyncEvent } from './syncEngine.js';
import { RetryService } from './retryService.js';
import { businessDate } from './time.js';

export interface SyncServiceOptions {
  repo: AppRepo;
  warehouse: Warehouse;
  adapter: PlatformAdapter;
  onEvent?: (event: SyncEvent) => void;
}

/**
 * Application-facing facade. Keeps the "preview -> confirm -> execute" flow in
 * one place so the HTTP API and the CLI demo behave identically.
 */
export class SyncService {
  readonly previewEngine: PreviewEngine;
  readonly engine: SyncEngine;
  readonly retryService: RetryService;

  constructor(private readonly options: SyncServiceOptions) {
    this.previewEngine = new PreviewEngine({ repo: options.repo, warehouse: options.warehouse });
    this.engine = new SyncEngine({
      repo: options.repo,
      warehouse: options.warehouse,
      adapter: options.adapter,
      onEvent: options.onEvent,
    });
    this.retryService = new RetryService(
      options.repo,
      options.warehouse,
      options.adapter,
      this.engine.rateLimiters,
    );
  }

  get repo(): AppRepo {
    return this.options.repo;
  }

  /**
   * Builds a preview. Queries each destination for its real remaining quota so
   * the number of deferrals shown to the operator matches what the run will
   * actually do; falls back to the local budget if a platform is unreachable.
   */
  async preview(options: BuildPreviewOptions = {}): Promise<RunPreview> {
    const platformRemaining = await this.fetchPlatformRemaining(
      options.businessDate ?? businessDate(),
    );
    return this.previewEngine.build({ ...options, platformRemaining });
  }

  private async fetchPlatformRemaining(bdate: string): Promise<Map<string, number>> {
    const destinations = this.options.repo.listDestinations().filter((d) => d.enabled);
    const entries = await Promise.all(
      destinations.map(async (destination) => {
        try {
          const usage = await this.options.adapter.getUsage(destination, bdate);
          return [destination.id, usage.remaining] as const;
        } catch {
          return null;
        }
      }),
    );
    return new Map(entries.filter((entry): entry is readonly [string, number] => entry !== null));
  }

  /** Persist a preview without executing; used by the "预览" button. */
  savePreview(preview: RunPreview): void {
    this.repo.insertRun(preview);
  }

  async execute(
    preview: RunPreview,
    options: { confirmed?: boolean; actor?: string } = {},
  ): Promise<RunSummary> {
    if (options.confirmed) {
      this.repo.audit(options.actor ?? 'operator', 'confirm', preview.runId, {
        totals: preview.totals,
        fingerprint: preview.fingerprint,
      });
    }
    // Rebuild the diff at execution time only if the caller explicitly asked
    // for it; by default we honour exactly what the operator confirmed.
    return this.engine.execute(preview, { confirmed: options.confirmed });
  }

  /** Convenience: preview + execute in one shot with threshold enforcement. */
  async runNow(options: BuildPreviewOptions & { confirmed?: boolean; actor?: string } = {}): Promise<{
    preview: RunPreview;
    summary: RunSummary | null;
    requiresConfirmation: boolean;
  }> {
    const preview = await this.preview(options);
    if (preview.requiresConfirmation && !options.confirmed) {
      this.savePreview(preview);
      return { preview, summary: null, requiresConfirmation: true };
    }
    const summary = await this.execute(preview, {
      confirmed: options.confirmed,
      actor: options.actor,
    });
    return { preview, summary, requiresConfirmation: false };
  }

  tasks(): SyncTask[] {
    return this.repo.listTasks();
  }
}
