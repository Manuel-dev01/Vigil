/**
 * Find and open the payslips sealed to a seal key in a rollup's inbox.
 * Read-only.
 *
 *   tsx src/cli/inbox.ts --key <seal key file> [--rollup vigil-pay-1]
 *
 * Envelopes are anonymous, so every sealed post is tried; the ones this key
 * cannot open are counted, not shown.
 */
import { openInboxReader } from "@vigil/core/inbox";
import { batchHolding, readInbox } from "../inbox.ts";
import { loadSealKeyFile } from "../keys.ts";
import { isSealedEnvelope, openPayslip } from "../payslip.ts";
import { argValue, chainId, fail, fmtQor, rest } from "./common.ts";

const argv = process.argv.slice(2);
const keyPath = argValue(argv, "--key");
const rollupId = argValue(argv, "--rollup") ?? "vigil-pay-1";
if (!keyPath) fail("usage: inbox.ts --key <seal key file> [--rollup id]");

const { address, keys } = loadSealKeyFile(keyPath);
const [posts, batches] = await Promise.all([readInbox(rest, { chainId, rollupId }, 0, openInboxReader({ chainId, rollupId })), rest.listBatches(rollupId)]);
const sealed = posts.filter((p) => isSealedEnvelope(p.payload));
console.log(`${rollupId}: ${posts.length} inbox posts, ${sealed.length} sealed; opening as ${address}`);
let opened = 0;
for (const p of sealed) {
  let slip;
  try {
    slip = openPayslip({ chainId, rollupId, envelope: p.payload, keys });
  } catch {
    continue;
  }
  opened++;
  const b = batchHolding(batches, p.sequence);
  console.log(`\ninbox entry ${p.sequence} (posted by ${p.poster} at height ${p.height}; ${b ? `batch ${b.batchIndex}, ${b.status}` : "not batched yet"})`);
  console.log(`  ${slip.period} payslip for ${slip.employee} from ${slip.employer}`);
  for (const l of slip.lines) console.log(`    ${l.label.padEnd(24)} ${fmtQor(l.amountUqor).padStart(16)}`);
  console.log(`  net ${fmtQor(slip.payment.amountUqor)}, paid by the transfer posted with data_hash ${slip.payment.postDataHash.slice(0, 16)}…`);
  if (slip.note) console.log(`  note: ${slip.note}`);
}
console.log(`\n${opened} opened, ${sealed.length - opened} sealed to others`);
