/**
 * Windows パス → WSL (`/mnt/<drive>/...`) パス変換。
 *
 * Satelles の `cwd` は常に絶対 Windows パスで渡ってくる前提。UNC・相対パス・
 * 既に POSIX 形式のパスは対応範囲外としてエラーにする (spec/plan/2026-08-15
 * -wsl-codex-runtime.md 参照)。
 */

const DRIVE_ABSOLUTE_RE = /^([A-Za-z]):[\\/](.*)$/u;

export class WslPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WslPathError";
  }
}

export function windowsPathToWslPath(winPath: string): string {
  const match = DRIVE_ABSOLUTE_RE.exec(winPath);
  if (!match) {
    throw new WslPathError(
      `unsupported path for WSL conversion (expected absolute drive path like "E:\\..."): ${winPath}`,
    );
  }
  const drive = match[1] ?? "";
  const rest = match[2] ?? "";
  const driveLower = drive.toLowerCase();
  const posixRest = rest
    .split(/[\\/]+/u)
    .filter((segment) => segment.length > 0)
    .join("/");
  return posixRest ? `/mnt/${driveLower}/${posixRest}` : `/mnt/${driveLower}`;
}

/**
 * Codex app-server が理解できる cwd を runtime ごとに返す。
 *
 * WSL runtime では `thread/start` だけでなく、各 `turn/start` の cwd と
 * writable root も Linux 側で評価されるため、すべて同じ変換を通す。
 */
export function codexRuntimeCwd(runtime: "native" | "wsl" | undefined, cwd: string): string {
  return runtime === "wsl" ? windowsPathToWslPath(cwd) : cwd;
}
