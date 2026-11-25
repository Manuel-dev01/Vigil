/**
 * Seal a payslip to its recipients and post it to the rollup's inbox from the
 * employer's L1 account. Simulates by default; only --broadcast sends.
 *
 *   tsx src/cli/payslip.ts --env <employer .env> --payslip <payslip.json> --to <qor1…>[,<qor1…>…]
 *                          [--rollup vigil-pay-1] [--broadcast]
 *
 * Before sealing it checks that:
 * - the payslip's employer is the posting account;
 * - the payment it explains is already in the inbox: a validly signed qledger
 *   transfer whose accounts and amount match the payslip;
 * - every recipient's card verifies against the chain (registered ML-DSA-87
 *   key and registered ML-KEM-1024 key).
 */
import { existsSync, readFileSync } from "node:fs";
import { bytesToHex, postRollupDataMsg, postedDataHash } from "@qorechain/rdk";
import { fetchPqcStatus, isRegisteredPqcKey } from "@qorechain/sdk";
import { HybridSender } from "@vigil/keel/chain";
import { cardPath, loadCard, recipientFromChain } from "../card.ts";
import { openInboxReader } from "@vigil/core/inbox";
import { readInbox, transferOf } from "../inbox.ts";
import { loadAccount } from "../keys.ts";
import { checkPayslip, sealPayslip, type Payslip } from "../payslip.ts";
import { argValue, chainId, fail, fmtQor, repoRoot, rest, restUrl } from "./common.ts";

const argv = process.argv.slice(2);
const envPath = argValue(argv, "--env");
const slipPath = argValue(argv, "--payslip");
const to = argValue(argv, "--to")?.split(",").filter(Boolean);
const rollupId = argValue(argv, "--rollup") ?? "vigil-pay-1";
if (!envPath || !slipPath || !to?.length) fail("usage: payslip.ts --env <employer .env> --payslip <json> --to <qor1…>[,…] [--rollup id] [--broadcast]");
const env = { chainId, rollupId };

const payslip = checkPayslip(JSON.parse(readFileSync(slipPath, "utf8")) as Payslip);
const account = await loadAccount(envPath);
if (payslip.rollupId !== rollupId) fail(`the payslip is for ${payslip.rollupId}, not ${rollupId}`);
if (payslip.employer !== account.cosmos) fail(`the payslip's employer is ${payslip.employer}, but the poster is ${account.cosmos}`);
if (!to.includes(payslip.employee)) fail(`the employee ${payslip.employee} must be one of the recipients`);

// The payment must already be in the inbox, and must be the transfer the payslip describes.
const posts = await readInbox(rest, env, 0, openInboxReader(env));
const paid = posts.find((p) => p.dataHash === payslip.payment.postDataHash);
if (!paid) fail(`no inbox post of ${rollupId} has data_hash ${payslip.payment.postDataHash}; post the payment first`);
const transfer = transferOf(paid.payload, env);
const want = payslip.payment;
if (!transfer || transfer.fromAccount !== want.fromAccount || transfer.toAccount !== want.toAccount || transfer.amountUqor !== want.amountUqor) {
  fail(`inbox entry ${paid.sequence} is not the transfer the payslip describes (${transfer ? `${transfer.fromAccount.slice(0, 8)}… → ${transfer.toAccount.slice(0, 8)}…, ${transfer.amountUqor} uqor` : "not a signed transfer"})`);
}

const recipients = [];
for (const address of to) {
  const path = cardPath(repoRoot, address);
  if (!existsSync(path)) fail(`no card for ${address} at ${path}`);
  recipients.push(await recipientFromChain(restUrl, chainId, address, loadCard(path)));
}
const envelope = sealPayslip({ chainId, payslip, recipients });

const sender = new HybridSender(account);
const [pqc, windowOpen] = await Promise.all([fetchPqcStatus({ rest: restUrl, address: account.cosmos }), sender.evmWindowOpen()]);
if (!pqc.registered || isRegisteredPqcKey(pqc, account.pqc.publicKey) !== true) fail("the poster's ML-DSA-87 key in this .env is not its registered key");
if (windowOpen) fail("the poster has an open EVM window; this key must stay hybrid-only");

const msg = postRollupDataMsg({ poster: account.cosmos, rollupId, data: envelope });
const sim = await sender.simulate([msg]);
console.log(`payment        inbox entry ${paid.sequence}: ${fmtQor(transfer.amountUqor)} ${transfer.fromAccount.slice(0, 8)}… → ${transfer.toAccount.slice(0, 8)}…`);
console.log(`recipients     ${to.length} (cards verified against the chain), anonymous envelope`);
console.log(`envelope       ${envelope.length} bytes, data_hash ${bytesToHex(postedDataHash(envelope)).toLowerCase()}`);
console.log(`poster         ${account.cosmos}`);
console.log(`simulate       ${sim.ok ? `ok, gas ${sim.gasUsed}` : `failed: ${sim.error}`}`);
if (!sim.ok || sim.gasUsed === undefined || !argv.includes("--broadcast")) process.exit(sim.ok ? 0 : 1);
const res = await sender.send([msg], sim.gasUsed);
const posted = res.events.find((e) => e.type === "rdk_data_posted");
const seq = posted?.attributes.find((a) => a.key === "sequence")?.value;
console.log(`posted         tx ${res.transactionHash} at height ${res.height} (fee ${res.feeUqor} uqor), inbox entry ${seq}`);
