/** Iterate a changing collection in bounded, deterministic keyset pages. */
export async function* scanById<T extends { id: string }>(
  fetchPage: (after: string | undefined, take: number) => Promise<T[]>,
  pageSize = 100,
): AsyncGenerator<T> {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error('Invalid scan page size');
  let after: string | undefined;
  for (;;) {
    const page = await fetchPage(after, pageSize);
    if (page.length > pageSize) throw new Error('Scan returned too many rows');
    if (page.length === 0) return;
    const lastId = page[page.length - 1].id;
    if (after !== undefined && lastId <= after) throw new Error('Scan cursor did not advance');
    for (const row of page) yield row;
    if (page.length < pageSize) return;
    after = lastId;
  }
}
