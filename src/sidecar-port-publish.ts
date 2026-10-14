/**
 * Publish the session sidecar port into Concordia `session.metadata`.
 *
 * Registration happens before the port is bound, so it is PATCHed afterwards
 * (Lictor does the same with `lictor_port`). A distinct key is used on purpose:
 * `lictor_port` makes Concordia treat the session as a Lictor process (force-exit,
 * PTY rename, relictor) which this compatibility subset cannot serve. Concordia
 * resolves `satelles_sidecar_port` only for routes Satelles implements.
 */
import type { ConcordiaClient } from "./concordia-client.js";
import { contract } from './contract-runtime.js'; /* augur-inject:import:ffedf492 */
import augurContract_b7cd539d from './contracts/sidecar-port-publish.contract.js'; /* augur-inject:contract-predicate:00156b15 */

export const SATELLES_SIDECAR_PORT_KEY = "satelles_sidecar_port";

export async function publishSidecarPort(
  concordia: Pick<ConcordiaClient, "patchSession">,
  sessionId: string,
  port: number,
  log: (message: string) => void,
): Promise<boolean> {
  try {
    await concordia.patchSession(sessionId, { metadata: { [SATELLES_SIDECAR_PORT_KEY]: port } });
    return true;
  } catch (error) {
    // best-effort: without the port only runtime switches from Concordia fail;
    // the session itself keeps working.
    log(`sidecar port publish failed: ${(error as Error).message}`);
    return false;
  }
}
// @ts-expect-error augur-inject
publishSidecarPort = contract(publishSidecarPort, { ...augurContract_b7cd539d, contractId: 'C-3', mode: 'observe', sample: 1, where: 'src/sidecar-port-publish.ts:14', rule: 'contract-wrap', id: 'b7cd539d' }); /* augur-inject:contract-wrap:b7cd539d */
