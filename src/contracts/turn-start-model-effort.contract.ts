/** @implements spec/plan/session-sidecar.md — next-turn application (C-2) */
export default {
  post(result: unknown, next: { model?: string | null; effort?: string | null }): true | string {
    const params = result as Record<string, unknown>;
    for (const key of ["model", "effort"] as const) {
      const value = next?.[key];
      if (value ? params[key] !== value : key in params) return `${key} not mapped to turn/start`;
    }
    return true;
  },
};
