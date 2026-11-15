import type { Db } from './sqlite.js';
import type { WarehouseMember } from '../types.js';
import { initWarehouseSchema } from './schema.js';

export interface WarehouseSegment {
  id: string;
  name: string;
  description: string;
  memberCount: number;
  updatedAt: string;
}

function asRows<T>(rows: unknown[]): T[] {
  return rows as T[];
}

export class Warehouse {
  constructor(readonly db: Db) {
    initWarehouseSchema(db);
  }

  listSegments(): WarehouseSegment[] {
    return asRows<WarehouseSegment>(
      this.db
        .prepare(
          `SELECT s.id, s.name, s.description, s.updated_at AS updatedAt,
                  (SELECT COUNT(*) FROM segment_members m WHERE m.segment_id = s.id) AS memberCount
           FROM segments s ORDER BY s.id`,
        )
        .all(),
    );
  }

  getSegment(segmentId: string): WarehouseSegment | undefined {
    return asRows<WarehouseSegment>(
      this.db
        .prepare(
          `SELECT s.id, s.name, s.description, s.updated_at AS updatedAt,
                  (SELECT COUNT(*) FROM segment_members m WHERE m.segment_id = s.id) AS memberCount
           FROM segments s WHERE s.id = ?`,
        )
        .all(segmentId),
    )[0];
  }

  /** Segment members joined with suppression flags. */
  listMembers(segmentId: string): WarehouseMember[] {
    return asRows<WarehouseMember>(
      this.db
        .prepare(
          `SELECT u.user_id AS userId, u.phone, u.name,
                  CASE WHEN u.opted_out = 1 OR u.blacklisted = 1 THEN 1 ELSE 0 END AS suppressed,
                  CASE WHEN u.blacklisted = 1 THEN 'blacklisted'
                       WHEN u.opted_out = 1 THEN 'opted_out'
                       ELSE NULL END AS suppressedReason
           FROM segment_members m
           JOIN users u ON u.user_id = m.user_id
           WHERE m.segment_id = ?
           ORDER BY u.user_id`,
        )
        .all(segmentId),
    ).map((row) => ({
      ...row,
      suppressed: Boolean(row.suppressed),
      suppressedReason: row.suppressedReason ?? null,
    }));
  }

  getUsers(userIds: string[]): Map<string, WarehouseMember> {
    const result = new Map<string, WarehouseMember>();
    const unique = [...new Set(userIds)].filter((id) => typeof id === 'string' && id.length > 0);
    const chunkSize = 400;
    for (let i = 0; i < unique.length; i += chunkSize) {
      const chunk = unique.slice(i, i + chunkSize);
      if (!chunk.length) continue;
      const placeholders = chunk.map(() => '?').join(',');
      const rows = asRows<WarehouseMember>(
        this.db
          .prepare(
            `SELECT user_id AS userId, phone, name,
                    CASE WHEN opted_out = 1 OR blacklisted = 1 THEN 1 ELSE 0 END AS suppressed,
                    CASE WHEN blacklisted = 1 THEN 'blacklisted'
                         WHEN opted_out = 1 THEN 'opted_out' ELSE NULL END AS suppressedReason
             FROM users WHERE user_id IN (${placeholders})`,
          )
          .all(...chunk),
      );
      for (const row of rows) {
        result.set(row.userId, { ...row, suppressed: Boolean(row.suppressed) });
      }
    }
    return result;
  }

  /** All suppressed ids, cached per call site. */
  listSuppressed(): { userIds: Set<string>; phones: Set<string> } {
    const rows = asRows<{ userId: string; phone: string }>(
      this.db
        .prepare('SELECT user_id AS userId, phone FROM users WHERE opted_out = 1 OR blacklisted = 1')
        .all(),
    );
    return {
      userIds: new Set(rows.map((r) => r.userId)),
      phones: new Set(rows.map((r) => r.phone)),
    };
  }

  segmentIdsForUser(userId: string): string[] {
    return asRows<{ segmentId: string }>(
      this.db.prepare('SELECT segment_id AS segmentId FROM segment_members WHERE user_id = ?').all(userId),
    ).map((r) => r.segmentId);
  }

  isSegmentMember(segmentId: string, userId: string): boolean {
    const row = this.db
      .prepare('SELECT 1 AS x FROM segment_members WHERE segment_id = ? AND user_id = ?')
      .get(segmentId, userId);
    return Boolean(row);
  }

  countUsers(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c);
  }
}
