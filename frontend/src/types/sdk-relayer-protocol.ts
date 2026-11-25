/**
 * Typecheck-only view of `@opaquecash/stellar/relayer-protocol` (#1088).
 *
 * Vite and Vitest alias `@opaquecash/stellar` to `../sdk/src`, so at runtime the
 * frontend uses the SDK sources directly. `tsc` maps the subpath here instead of to
 * the SDK's full `relayer-protocol/index.ts`, because that index re-exports
 * `gateway.ts`, which type-imports `prove/pool` and drags the whole SDK (and its
 * own unrelated type errors) into the frontend's stricter compiler settings.
 *
 * The frontend only uses the wire-format, box and message helpers below; add a re-export here if it
 * starts importing more of the subpath. Remove this shim once the SDK builds and the
 * frontend can resolve the subpath through the SDK's published `.d.ts` files.
 */
export * from "../../../sdk/src/relayer-protocol/bytes";
export * from "../../../sdk/src/relayer-protocol/payload";
export * from "../../../sdk/src/relayer-protocol/box";
export * from "../../../sdk/src/relayer-protocol/messages";
