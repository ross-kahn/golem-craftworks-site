// Square hands long lists back a page at a time, each with a cursor for the next. This asks for every page in turn.
export async function* paged<T extends { cursor?: string }>(
  get: (cursor?: string) => Promise<T>,
) {
  let cursor: string | undefined;
  do {
    const page = await get(cursor);
    yield page;
    cursor = page.cursor;
  } while (cursor);
}
