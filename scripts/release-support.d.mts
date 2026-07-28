/**
 * Hand-written declarations for the release-support primitives the canonical parity test
 * imports. `tsconfig.json` sets no `allowJs` and `skipLibCheck: false`, so a `.test.ts` importing
 * the `.mjs` module would otherwise fail `tsc --noEmit` with TS7016.
 *
 * This declares exactly the three exported symbols the parity test needs — not the module's full
 * surface. `sortCanonical` and `isInside` are module-private and deliberately absent.
 */

export declare function canonicalJsonBytes(value: unknown): Uint8Array;
export declare function sha256(bytes: Uint8Array): string;
export declare function assertPortablePath(value: unknown, description?: string): string;
