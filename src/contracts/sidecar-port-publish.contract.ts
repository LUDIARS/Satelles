/** @implements spec/plan/session-sidecar.md — sidecar port publication (C-3) */
export default {
  post(result: unknown): true | string {
    return typeof result === "boolean" ? true : "publishSidecarPort must resolve to a boolean";
  },
};
