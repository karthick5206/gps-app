// Types for the G8 build check (check-no-external-maps.mjs), so the web unit tests can import its matcher.
export declare const RULES: ReadonlyArray<readonly [string, RegExp]>;
export declare const EXEMPT: readonly RegExp[];
export declare function findExternalMapHosts(text: string): { rule: string; index: number; excerpt: string }[];
