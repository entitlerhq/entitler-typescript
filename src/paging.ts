import type { Page, Paged } from "./types.js";

/** A paged list that fetches each page only when iteration reaches it. @internal */
export function paged<T>(fetchPage: (cursor: string | undefined) => Promise<Page<T>>, first?: Page<T>): Paged<T> {
  async function* pages(): AsyncGenerator<Page<T>> {
    let page = first ?? (await fetchPage(undefined));
    yield page;
    while (page.next !== null) {
      page = await fetchPage(page.next);
      yield page;
    }
  }
  return {
    pages,
    async *[Symbol.asyncIterator]() {
      for await (const page of pages()) yield* page.items;
    },
  };
}
