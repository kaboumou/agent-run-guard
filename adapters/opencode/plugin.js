/**
 * Agent Run Guard — adapters/opencode/plugin.js (legacy path)
 * Kept so existing installs and tests keep resolving. Re-exports the
 * version-scoped V1 adapter at ../opencode-v1/plugin.js. New installs
 * should use the dual entrypoint at ../opencode/index.js (V2 primary,
 * V1 legacy via server()).
 */
export * from "../opencode-v1/plugin.js";
export { default } from "../opencode-v1/plugin.js";
