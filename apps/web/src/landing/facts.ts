/**
 * The few live facts the landing page shows, read from the chain after first paint through the same
 * client the app's views use (the main bundle already prefetches it).
 */
import { ROLLUP } from "../config.ts";

export interface Facts {
  /** The newest batch the chain keeps for the rollup. */
  latestIndex: number;
  latestStatus: string;
  /** Settlement anchors recorded for the rollup's layer. */
  anchors: number;
}

export async function loadFacts(): Promise<Facts> {
  const { chain } = await import("../chain.ts");
  const { rdk } = await chain();
  const rollup = await rdk.rest.getRollup(ROLLUP);
  const [batches, anchors] = await Promise.all([rdk.rest.listBatches(ROLLUP), rdk.rest.getAnchors(rollup.layerId).catch(() => [])]);
  const latest = batches.reduce((a, b) => (Number(b.batchIndex) > Number(a.batchIndex) ? b : a), batches[0]!);
  return { latestIndex: Number(latest.batchIndex), latestStatus: String(latest.status), anchors: anchors.length };
}
