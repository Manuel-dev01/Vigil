/**
 * Kit-gap check (read-only): run RDK 0.9.0's `transitionRootValidator` (what
 * `qorollup watchtower --canonical` and `watchBatches` use) on every live batch
 * of the qledger-v1 rollups, and compare with qledger re-execution (Spike A).
 *
 * `watchBatches` only validates batches that are still pending, so the CLI is
 * silent on finalized ones. Calling the validator directly shows what it would
 * report on an honest qledger batch inside its challenge window.
 *
 *   pnpm --filter @vigil/scripts exec tsx kit-gap-check.ts [rollupId ...]
 */
import "./lib/net.ts";
import { VERSION, createRdkClient, transitionRootValidator } from "@qorechain/rdk";

const rdk = createRdkClient({ network: "testnet" });
const ids = process.argv.slice(2);
const rollups = ids.length > 0 ? ids : (await rdk.rest.listRollups()).filter((r) => r.executionVm === "qledger-v1").map((r) => r.rollupId);

console.log(`@qorechain/rdk ${VERSION}; rollups: ${rollups.join(", ")}`);
let flagged = 0;
let total = 0;
for (const id of rollups) {
  const validate = transitionRootValidator(rdk, id);
  for (const b of await rdk.rest.listBatches(id)) {
    if (b.status === "rejected") continue;
    total++;
    const ok = await validate(b);
    if (!ok) flagged++;
    console.log(`${id} batch ${b.batchIndex} (${b.status}): transitionRootValidator says ${ok ? "valid" : "INVALID"}`);
  }
}
console.log(`${flagged} of ${total} honest batches flagged invalid by the transition-root rule`);
