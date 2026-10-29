import type { Snapshot } from "../server/types.ts";

export const projectHeaders = (state: Snapshot): Record<string, string> =>
  state.workspace
    ? { "X-Project-Id": state.workspace.activeProjectId ?? "none" }
    : {};
