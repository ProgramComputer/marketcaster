import type { Page } from "../domain/primitives.js";

export interface PaginationOptions {
  readonly maximumPages?: number;
}

export async function collectCursorPages<T>(
  fetchPage: (cursor?: string) => Promise<Page<T>>,
  options: PaginationOptions = {},
): Promise<readonly T[]> {
  const maximumPages = options.maximumPages ?? 10_000;
  const seenCursors = new Set<string>();
  const items: T[] = [];
  let cursor: string | undefined;

  for (let pageNumber = 0; pageNumber < maximumPages; pageNumber += 1) {
    const page = await fetchPage(cursor);
    items.push(...page.items);

    if (page.eof) return items;
    if (page.nextCursor === undefined || page.nextCursor.length === 0) {
      throw new Error(
        "Pagination was not complete but no next cursor was returned",
      );
    }
    if (seenCursors.has(page.nextCursor)) {
      throw new Error(`Pagination cursor loop detected at ${page.nextCursor}`);
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }

  throw new Error(`Pagination exceeded the ${maximumPages}-page safety limit`);
}

export async function collectOffsetPages<T>(
  fetchPage: (offset: number, limit: number) => Promise<readonly T[]>,
  limit = 100,
  maximumPages = 10_000,
): Promise<readonly T[]> {
  const items: T[] = [];
  for (let pageNumber = 0; pageNumber < maximumPages; pageNumber += 1) {
    const page = await fetchPage(pageNumber * limit, limit);
    items.push(...page);
    if (page.length < limit) return items;
  }
  throw new Error(
    `Offset pagination exceeded the ${maximumPages}-page safety limit`,
  );
}
