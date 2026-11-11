// Types for the G8 build check (check-no-external-maps.mjs), so the web unit tests can import its matcher.
export declare const RULES: ReadonlyArray<readonly [string, RegExp]>;
export declare const EXEMPT: readonly RegExp[];
export declare const STYLE_KEYS: ReadonlyArray<readonly [string, string, string]>;
export declare function findExternalMapHosts(text: string, options?: { allowedOrigins?: Set<string> }): { rule: string; index: number; excerpt: string }[];
export declare const ALLOWED_MAP_HOSTS: readonly RegExp[];
export declare function styleValueProblem(value: string | undefined): string | null;
export declare function validateStyleEnv(env: Record<string, string | undefined>): string[];
export declare function styleOrigins(env: Record<string, string | undefined>): Set<string>;
export declare function readStyleEnv(webDir: string, processEnv?: Record<string, string | undefined>, mode?: string): Record<string, string | undefined>;
export declare function checkBundleStyleBase(bundleText: string, env: Record<string, string | undefined>): string[];
