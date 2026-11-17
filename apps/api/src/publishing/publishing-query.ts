import { z } from 'zod';
import { paginationSchema } from '@clipforge/validation';

export const publishingJobsQuerySchema = paginationSchema.extend({
  status: z.enum(['PENDING', 'ELIGIBILITY_CHECK', 'QUEUED', 'UPLOADING', 'AWAITING_PLATFORM', 'PUBLISHED', 'FAILED', 'CANCELLED', 'SKIPPED']).optional(),
  scheduledFrom: z.string().datetime({ offset: true }).optional(),
  scheduledTo: z.string().datetime({ offset: true }).optional(),
}).superRefine((query, ctx) => {
  if (!!query.scheduledFrom !== !!query.scheduledTo) {
    ctx.addIssue({ code: 'custom', message: 'Both schedule boundaries are required', path: ['scheduledTo'] });
  }
  if (query.scheduledFrom && query.scheduledTo) {
    const span = Date.parse(query.scheduledTo) - Date.parse(query.scheduledFrom);
    if (span <= 0 || span > 93 * 86400000) ctx.addIssue({ code: 'custom', message: 'Schedule window must be positive and at most 93 days', path: ['scheduledTo'] });
  }
});
