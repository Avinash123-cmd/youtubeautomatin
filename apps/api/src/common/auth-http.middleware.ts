import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/** Run before CORS and guards so their failures have correlation IDs too. */
export function authHttpMetadata(req: Request & { requestId?: string }, res: Response, next: NextFunction): void {
  const supplied = req.get('x-request-id');
  req.requestId = supplied && /^[a-zA-Z0-9_-]{1,100}$/.test(supplied) ? supplied : randomUUID();
  res.setHeader('x-request-id', req.requestId);
  if (req.path === '/api/auth' || req.path.startsWith('/api/auth/')) {
    // Auth state is never a cache validator, even if a stale client sends '*'.
    delete req.headers['if-none-match'];
    delete req.headers['if-modified-since'];
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
  }
  next();
}
