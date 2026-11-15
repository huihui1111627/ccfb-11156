export type PlatformType = 'sms' | 'wecom' | 'ads';

export type HashAlgorithm = 'sha256' | 'md5';

export interface HashPolicy {
  algorithm: HashAlgorithm;
  /** Prefix salt. Empty string means no salt. */
  salt: string;
  uppercase: boolean;
}

export interface DestinationConfig {
  batchSize: number;
  requestsPerSecond: number;
  dailyQuota: number;
  maxRetries: number;
  maxHttpRetries: number;
  retryBackoffMs: number;
  requestTimeoutMs: number;
  hash: HashPolicy;
  /** SMS platforms dedupe actual texts per phone across all audiences per day. */
  smsDailyDedupe: boolean;
}

export interface Destination {
  id: string;
  name: string;
  platform: PlatformType;
  baseUrl: string;
  enabled: boolean;
  config: DestinationConfig;
  createdAt: string;
  updatedAt: string;
}

export interface SyncTask {
  id: string;
  name: string;
  segmentId: string;
  destinationId: string;
  audienceId: string;
  enabled: boolean;
  confirmThreshold: number;
  createdAt: string;
  updatedAt: string;
}

export interface WarehouseMember {
  userId: string;
  phone: string;
  name: string;
  suppressed: boolean;
  suppressedReason: string | null;
}

export interface TaskDiff {
  taskId: string;
  taskName: string;
  destinationId: string;
  destinationName: string;
  platform: PlatformType;
  segmentId: string;
  segmentName: string;
  audienceId: string;
  adds: string[];
  removes: string[];
  /** Segment members held back because they are opted out / blacklisted. */
  blocked: string[];
  /** Subset of adds that will not trigger a new SMS because the phone already got one today. */
  smsDeduped: string[];
  /** Subset of adds that cannot be sent today because the destination quota is exhausted. */
  deferred: string[];
  unchanged: number;
  totalMembers: number;
  quotaRemaining: number;
  threshold: number;
  affected: number;
  requiresConfirmation: boolean;
  warnings: string[];
}

export interface RunPreview {
  runId: string;
  businessDate: string;
  createdAt: string;
  tasks: TaskDiff[];
  totals: {
    adds: number;
    removes: number;
    blocked: number;
    smsDeduped: number;
    deferred: number;
    affected: number;
  };
  requiresConfirmation: boolean;
  fingerprint: string;
  status: RunStatus;
}

export type RunStatus =
  | 'previewed'
  | 'awaiting_confirmation'
  | 'running'
  | 'completed'
  | 'partial'
  | 'failed';

export interface TaskRunStats {
  taskId: string;
  adds: number;
  removes: number;
  addSuccess: number;
  removeSuccess: number;
  failed: number;
  deferred: number;
  deduped: number;
  error?: string;
}

export interface RunSummary {
  runId: string;
  businessDate: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string;
  tasks: TaskRunStats[];
  totals: {
    addSuccess: number;
    removeSuccess: number;
    failed: number;
    deferred: number;
    deduped: number;
    requests: number;
  };
}

export type SyncAction = 'add' | 'remove';
export type LogStatus = 'success' | 'failed' | 'deferred';

export interface SendLogRow {
  id: number;
  runId: string;
  taskId: string;
  destinationId: string;
  segmentId: string;
  userId: string;
  action: SyncAction;
  phoneHash: string | null;
  status: LogStatus;
  deduped: number;
  errorCode: string | null;
  errorMessage: string | null;
  attemptNo: number;
  batchId: string;
  latencyMs: number;
  businessDate: string;
  createdAt: string;
}

export interface FailureRow {
  id: number;
  destinationId: string;
  taskId: string;
  segmentId: string;
  userId: string;
  action: SyncAction;
  errorCode: string | null;
  errorMessage: string | null;
  attempts: number;
  status: 'open' | 'resolved';
  runId: string;
  lastAttemptAt: string;
  resolvedAt: string | null;
  resolveNote: string | null;
}

export interface DailyStatRow {
  destinationId: string;
  destinationName: string;
  platform: PlatformType;
  businessDate: string;
  attempts: number;
  success: number;
  failed: number;
  deferred: number;
  deduped: number;
  blocked: number;
  successRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  /** Number of latency samples feeding avgLatencyMs / p95LatencyMs. */
  latencySamples: number;
}

export interface ItemResult {
  userId: string;
  ok: boolean;
  errorCode?: string;
  errorMessage?: string;
  /**
   * Whether this add consumed platform quota. A platform may accept an add
   * without billing (e.g. the member was already present); the engine uses
   * this to keep local quota accounting exact. Defaults to true when absent.
   */
  billed?: boolean;
  /** Whether this add actually triggered an SMS. Defaults to true when absent. */
  texted?: boolean;
}

export interface BatchRequest {
  audienceId: string;
  action: SyncAction;
  businessDate: string;
  batchId: string;
  contacts: Array<{
    userId: string;
    phoneHash?: string;
    sendSms?: boolean;
  }>;
}

export interface BatchResponse {
  results: ItemResult[];
  quota: { limit: number; used: number; remaining: number };
  acceptedAdds: number;
  httpStatus: number;
  latencyMs: number;
}

export interface PlatformAdapter {
  sendBatch(destination: Destination, req: BatchRequest): Promise<BatchResponse>;
  getUsage(
    destination: Destination,
    businessDate: string,
  ): Promise<{ limit: number; used: number; remaining: number }>;
  health(destination: Destination): Promise<{ ok: boolean; latencyMs: number; error?: string }>;
  mockState(destination: Destination): Promise<unknown>;
  updateMockConfig(destination: Destination, patch: Record<string, unknown>): Promise<unknown>;
}
