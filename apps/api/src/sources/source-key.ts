/**
 * One storage-key convention for every source kind. Workspace prefix first so a key can never be
 * reused across tenants, source id second so re-ingesting a file overwrites only its own object.
 */
export function sourceObjectKey(workspaceId: string, sourceId: string, fileName: string | null): string {
  const extension = (fileName?.match(/\.[A-Za-z0-9]{1,6}$/)?.[0] ?? '.mp4').toLowerCase();
  const safeExtension = ['.mp4', '.mov', '.webm', '.mkv', '.m4v'].includes(extension) ? extension : '.mp4';
  return `ws/${workspaceId}/sources/${sourceId}/original${safeExtension}`;
}
