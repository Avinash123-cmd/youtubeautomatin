import { Injectable } from '@nestjs/common';
import { prisma } from '@clipforge/database';
import { priceList, round, type PriceList } from '../common/services/usage-cost';

export interface UsageWindow {
  from: Date;
  to: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Default reporting window: the last 30 days, which is what a monthly review looks at. */
const DEFAULT_WINDOW_DAYS = 30;

const KIND_LABELS: Record<string, string> = {
  transcription_seconds: 'Transcription (audio seconds)',
  gemini_tokens: 'AI text analysis (tokens)',
  gemini_vision_tokens: 'AI vision analysis (tokens)',
  render_seconds: 'Rendering (video seconds)',
  storage_bytes: 'Storage (bytes written)',
  publish_calls: 'Platform publish calls',
};

const UNIT_BY_KIND: Record<string, string> = {
  transcription_seconds: 'seconds',
  gemini_tokens: 'tokens',
  gemini_vision_tokens: 'tokens',
  render_seconds: 'seconds',
  storage_bytes: 'bytes',
  publish_calls: 'calls',
};

export interface KindSummary {
  kind: string;
  label: string;
  unit: string;
  quantity: number;
  records: number;
  costUsd: number;
  unpricedRecords: number;
}

export interface UsageSummary {
  workspaceId: string;
  window: { from: string; to: string; days: number };
  totals: {
    costUsd: number;
    records: number;
    unpricedRecords: number;
    tokens: number;
    transcriptionSeconds: number;
    renderSeconds: number;
    publishCalls: number;
    storageBytesWritten: number;
  };
  byKind: KindSummary[];
  /** Storage is a monthly rate over what is currently stored, not a per-upload charge. */
  storage: { bytesStoredNow: number; monthlyCostUsd: number; pricePerGbMonth: number };
  prices: PriceList;
  generatedAt: string;
}

@Injectable()
export class UsageService {
  /** Aggregate spend for a workspace over a window. Read-only; no rows are created here. */
  async summary(workspaceId: string, query: { from?: string; to?: string }): Promise<UsageSummary> {
    const window = resolveWindow(query);
    // Aggregate in PostgreSQL rather than materialising every ledger row in API memory.
    const [groups, bytesStoredNow] = await Promise.all([
      prisma.usageRecord.groupBy({
        by: ['kind'],
        where: { workspaceId, recordedAt: { gte: window.from, lte: window.to } },
        _sum: { quantity: true, costUsd: true },
        _count: { _all: true, costUsd: true },
      }),
      this.bytesCurrentlyStored(workspaceId),
    ]);
    const byKind = new Map<string, KindSummary>(groups.map((group) => [group.kind, {
      kind: group.kind,
      label: KIND_LABELS[group.kind] ?? group.kind,
      unit: UNIT_BY_KIND[group.kind] ?? 'units',
      quantity: round(group._sum.quantity ?? 0),
      records: group._count._all,
      costUsd: round(group._sum.costUsd ?? 0),
      // A null cost means "we did not price this", not a zero-cost record.
      unpricedRecords: group._count._all - group._count.costUsd,
    }]));
    const byKindSorted = [...byKind.values()].sort((a, b) => b.costUsd - a.costUsd || a.kind.localeCompare(b.kind));
    const prices = priceList();
    const bytesWritten = byKind.get('storage_bytes')?.quantity ?? 0;

    return {
      workspaceId,
      window: {
        from: window.from.toISOString(),
        to: window.to.toISOString(),
        days: Math.max(1, Math.round((window.to.getTime() - window.from.getTime()) / DAY_MS)),
      },
      totals: {
        costUsd: round(byKindSorted.reduce((sum, entry) => sum + entry.costUsd, 0)),
        records: byKindSorted.reduce((sum, entry) => sum + entry.records, 0),
        unpricedRecords: byKindSorted.reduce((sum, entry) => sum + entry.unpricedRecords, 0),
        tokens: round(
          (byKind.get('gemini_tokens')?.quantity ?? 0) + (byKind.get('gemini_vision_tokens')?.quantity ?? 0),
        ),
        transcriptionSeconds: round(byKind.get('transcription_seconds')?.quantity ?? 0),
        renderSeconds: round(byKind.get('render_seconds')?.quantity ?? 0),
        publishCalls: round(byKind.get('publish_calls')?.quantity ?? 0),
        storageBytesWritten: round(bytesWritten),
      },
      byKind: byKindSorted,
      storage: {
        bytesStoredNow,
        monthlyCostUsd: round((bytesStoredNow / 1024 ** 3) * prices.storagePerGbMonth),
        pricePerGbMonth: prices.storagePerGbMonth,
      },
      prices,
      generatedAt: new Date().toISOString(),
    };
  }

  /** Daily spend series, useful for spotting a runaway job or a pricing change. */
  async daily(workspaceId: string, query: { from?: string; to?: string }) {
    const window = resolveWindow(query);
    // recordedAt is a UTC TIMESTAMP without time zone in the Prisma schema.
    // Convert explicit UTC bounds to the same type independently of the database
    // session timezone; grouping by its date matches the old ISO buckets.
    const groups = await prisma.$queryRaw<Array<{ date: string; kind: string; costUsd: number; records: number }>>`
      SELECT to_char("recordedAt", 'YYYY-MM-DD') AS date, "kind",
             SUM("costUsd")::double precision AS "costUsd", COUNT(*)::double precision AS records
      FROM "UsageRecord"
      WHERE "workspaceId" = ${workspaceId}::uuid
        AND "recordedAt" >= (${window.from.toISOString()}::timestamptz AT TIME ZONE 'UTC')
        AND "recordedAt" <= (${window.to.toISOString()}::timestamptz AT TIME ZONE 'UTC')
        AND "costUsd" IS NOT NULL
      GROUP BY 1, "kind"
      ORDER BY 1, "kind"
    `;
    const buckets = new Map<string, { date: string; costUsd: number; records: number; byKind: Record<string, number> }>();
    for (const group of groups) {
      const bucket = buckets.get(group.date) ?? { date: group.date, costUsd: 0, records: 0, byKind: {} };
      bucket.costUsd = round(bucket.costUsd + group.costUsd);
      bucket.records += group.records;
      bucket.byKind[group.kind] = round(group.costUsd);
      buckets.set(group.date, bucket);
    }
    return {
      workspaceId,
      window: { from: window.from.toISOString(), to: window.to.toISOString() },
      days: [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date)),
    };
  }

  /** Raw ledger, newest first. This is what an operator reconciles against provider invoices. */
  async records(
    workspaceId: string,
    query: { page: number; pageSize: number; kind?: string; jobId?: string; from?: string; to?: string },
  ) {
    const window = resolveWindow(query);
    const where = {
      workspaceId,
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.jobId ? { jobId: query.jobId } : {}),
      recordedAt: { gte: window.from, lte: window.to },
    };
    const [total, rows] = await Promise.all([
      prisma.usageRecord.count({ where }),
      prisma.usageRecord.findMany({
        where,
        orderBy: { recordedAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          kind: true,
          quantity: true,
          unit: true,
          costUsd: true,
          metadata: true,
          recordedAt: true,
          jobId: true,
        },
      }),
    ]);
    return {
      total,
      page: query.page,
      pageSize: query.pageSize,
      items: rows.map((row) => ({ ...row, label: KIND_LABELS[row.kind] ?? row.kind })),
    };
  }

  /**
   * Estimate bytes from the latest storage write per source, plus unattributed legacy writes.
   * This is a ledger estimate; it does not independently check whether objects were later deleted.
   */
  private async bytesCurrentlyStored(workspaceId: string): Promise<number> {
    // DISTINCT ON retains the newest write per attributed source. Unattributed
    // legacy rows each remain distinct, as in the previous in-memory algorithm.
    const [result] = await prisma.$queryRaw<Array<{ bytes: number }>>`
      SELECT COALESCE(SUM(latest."quantity"), 0)::double precision AS bytes
      FROM (
        SELECT DISTINCT ON (COALESCE("metadata"->>'sourceVideoId', 'unattributed:' || "id"::text)) "quantity"
        FROM "UsageRecord"
        WHERE "workspaceId" = ${workspaceId}::uuid AND "kind" = 'storage_bytes'
        ORDER BY COALESCE("metadata"->>'sourceVideoId', 'unattributed:' || "id"::text), "recordedAt" DESC, "id" DESC
      ) AS latest
    `;
    return round(result?.bytes ?? 0);
  }
}

function resolveWindow(query: { from?: string; to?: string }): UsageWindow {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from
    ? new Date(query.from)
    : new Date(to.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS);
  return { from, to };
}
