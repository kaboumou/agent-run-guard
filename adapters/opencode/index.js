/**
 * Agent Run Guard — adapters/opencode/index.js (dual V2 + V1 entrypoint)
 * Official dual shape per https://opencode.ai/v2/docs/build/plugins/migrate-v1:
 * one default export combining the V2 definition (`id` + `setup`) with a
 * V1 object entrypoint (`server()`). The APIs stay separate — nothing is
 * translated between them; each wires the shared core independently.
 *
 * - V2 (primary): `setup(ctx)` via adapters/opencode-v2.
 * - V1 (legacy): `server(ctx)` returns the V1 hooks object via
 *   adapters/opencode-v1. V1 object entrypoints require OpenCode >= 1.18.29.
 *   (Live-proven on 1.18.27 through the classic function entrypoint shape,
 *   which `server()` preserves.)
 */

import v2definition from "../opencode-v2/plugin.js";
import { createOpenCodeHooks } from "../opencode-v1/plugin.js";

export { PLUGIN_ID } from "../opencode-v2/plugin.js";
export { createOpenCodeHooks } from "../opencode-v1/plugin.js";

export default {
  ...v2definition,
  async server(ctx) {
    return createOpenCodeHooks({ ctx });
  },
};
