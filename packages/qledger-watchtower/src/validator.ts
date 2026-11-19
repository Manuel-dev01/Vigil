/**
 * A drop-in `validate` predicate for @qorechain/rdk's `watchBatches` that
 * applies the qledger-v1 rule (re-execution from the inbox), in place of RDK
 * 0.9.0's `transitionRootValidator`, which applies the older transition-root
 * rule and reports every honest qledger-v1 batch as invalid.
 *
 *   watchBatches(rdk, rollupId, {
 *     validate: qledgerValidator(rdk, rollupId),
 *     onInvalid: ({ batch }) => ...challenge with qledgerFraudProofForBatch...
 *   });
 *
 * Shaped for an upstream contribution to qorechain-rdk.
 */
import type { BatchView, RdkClient } from "@qorechain/rdk";
import { InboxArchive } from "./archive.ts";
import type { Challenge } from "./check.ts";
import { RollupTracker, chainSource } from "./tracker.ts";

export interface QledgerValidatorOptions {
  /** JSONL path for the inbox archive (data availability across node pruning). Memory only if omitted. */
  archivePath?: string;
}

export function qledgerTracker(client: RdkClient, rollupId: string, opts: QledgerValidatorOptions = {}): RollupTracker {
  const env = { chainId: client.network.chainId, rollupId };
  return new RollupTracker(env, chainSource(client.rest, env, client.network.endpoints.rest), new InboxArchive(env, opts.archivePath));
}

/**
 * `true` when the batch matches re-execution, `false` when a challenge would win.
 * A batch whose parent state cannot be established yet is reported valid (never
 * a false alarm); it is judged on a later poll.
 */
export function qledgerValidator(client: RdkClient, rollupId: string, opts: QledgerValidatorOptions = {}) {
  const tracker = qledgerTracker(client, rollupId, opts);
  return async (batch: BatchView): Promise<boolean> => {
    await tracker.sync();
    const j = tracker.judgementFor(batch);
    return !(j && (j.kind === "invalid" || j.kind === "descends-from-invalid"));
  };
}

/** The qledger-v1 fraud proof for a batch, decided locally exactly as the chain decides it. */
export async function qledgerFraudProofForBatch(client: RdkClient, rollupId: string, batch: BatchView): Promise<Challenge | undefined> {
  const tracker = qledgerTracker(client, rollupId);
  await tracker.sync();
  const j = tracker.judgementFor(batch);
  if (!j || j.kind !== "invalid") return undefined;
  return tracker.challenge(batch);
}
