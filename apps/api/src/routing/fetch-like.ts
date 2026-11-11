/** Injectable `fetch` for engine-neutral HTTP clients (moved out of the branch's Valhalla adapter, doc 17 §4.1 E-11). */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const defaultFetch: FetchLike = (url, init) => fetch(url, init);
