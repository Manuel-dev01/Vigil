import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { EVM_HOST, NODE_HOST, REPO, ROLLUP, accountUrl, blockUrl, dur, errText, qor, short, shortAddr, stamp, txUrl, utcFull, utcTime } from "../config.ts";
import {
  EXITS_PAGE,
  LOG_SPAN,
  ML_DSA_87_PUBKEY_LEN,
  PQC_VERIFY,
  WEI_PER_UQOR,
  exitAddressFor,
  loadExits,
  nameOf,
  parsePayout,
  qorWei,
  type AttestationView,
  type ExitAddress,
  type ExitView,
  type ExitsState,
  type Member,
  type VaultState,
} from "../exits.ts";
import { listen } from "../live.ts";
import { CopyHash, Ext, ExplorerHint, Mark, useRefresh, type Tone } from "../ui.tsx";
import { PageHead, Reading, type Sounding } from "./Head.tsx";
import { Race, raceTimes } from "./Race.tsx";

const REFRESH_MS = 30_000;
const SOURCE = `${REPO}/blob/main/contracts/src/InstantExitVault.sol`;

const pct = (bps: number): string => `${(bps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;

/** An account by its known name, or its shortened address; the full address on hover. */
function Who({ addr, also }: { addr: string; also?: string }) {
  const name = nameOf(addr);
  return <span title={also ? `${addr}\n${also}` : addr}>{name ? <strong>{name}</strong> : <code>{shortAddr(addr)}</code>}</span>;
}

function Step({ tone, label, title, when, children, links }: { tone: Tone; label?: string; title: ReactNode; when?: number | undefined; children?: ReactNode; links?: ReactNode }) {
  return (
    <li>
      <Mark tone={tone} label={label ?? { ok: "done", bad: "failed", skip: "did not happen", wait: "pending" }[tone]} />
      <div>
        <div className="step-head">
          <span className="what">{title}</span>
          {when ? (
            <time className="when" dateTime={new Date(when * 1000).toISOString()} title={utcFull(when * 1000)}>
              {stamp(when)}
            </time>
          ) : null}
        </div>
        {children && <div className="step-body">{children}</div>}
        {links && <div className="evidence">{links}</div>}
      </div>
    </li>
  );
}

function KeyChip({ m }: { m: Member }) {
  if (m.key === undefined) return <span className="chip warn">key could not be read</span>;
  if (m.keyBytes !== ML_DSA_87_PUBKEY_LEN) return <span className="chip bad">no usable ML-DSA-87 key</span>;
  const pin = m.pin;
  return (
    <>
      <span className="chip ok" title={`keyOf() returned a ${m.keyBytes}-byte ML-DSA-87 public key: registered on chain, with proof of possession (as ${EVM_HOST} reports)`}>
        ML-DSA-87 key registered and proven
      </span>
      {pin?.status === "match" && (
        <span className="chip ok" title={`SHA-256 ${pin.sha256}, as pinned in this page's source`}>
          matches pinned key
        </span>
      )}
      {pin?.status === "mismatch" && (
        <span className="chip bad" title={`The chain reports SHA-256 ${pin.sha256}; the page pins ${pin.pinned}`}>
          differs from pinned key
        </span>
      )}
      {pin?.status === "unpinned" && <span className="chip warn">no key pinned for it</span>}
    </>
  );
}

function SigChips({ a }: { a: AttestationView }) {
  return (
    <>
      {a.local ? (
        <span className="chip ok" title="Verified in this browser with ML-DSA-87 (FIPS 204, @noble/post-quantum) against the member's key">
          ML-DSA-87 ✓ in browser
        </span>
      ) : (
        <span className="chip warn" title="The member's key could not be read, or differs from the one pinned in this page, so the signature was not checked here">
          not checked in browser
        </span>
      )}{" "}
      {a.pqc.valid === true ? (
        <span className="chip ok" title={`QoreChain's pqcVerify precompile answered true (${a.pqc.ms} ms, an eth_call to ${EVM_HOST})`}>
          pqcVerify ✓
        </span>
      ) : a.pqc.valid === false ? (
        <span className="chip bad" title={`QoreChain's pqcVerify precompile answered false (an eth_call to ${EVM_HOST})`}>
          pqcVerify: invalid
        </span>
      ) : (
        <span className="chip warn" title={a.pqc.error}>
          pqcVerify not answered
        </span>
      )}
    </>
  );
}

function exitStatus(x: ExitView, threshold: number, nowSec: number): { cls: string; label: string } {
  if (x.error) return { cls: "warn", label: "Could not be read" };
  if (x.batch?.status === "rejected") return { cls: "bad", label: "Batch rejected" };
  if (x.batch?.status === "replaced") return { cls: "bad", label: "Batch replaced" };
  const repaid = !!x.repayment?.completedBy;
  if (x.fronted) return repaid ? { cls: "ok", label: "Paid at once · vault repaid" } : { cls: "warn", label: "Paid at once · repayment pending" };
  if (x.executed) return { cls: "pruned", label: "Not fronted · paid in full after finality" };
  if (x.claim && nowSec > x.claim.deadline) return { cls: "warn", label: "Not fronted · waiting for finality" };
  if (x.validSigners >= threshold) return { cls: "info", label: "Ready to front" };
  return { cls: "warn", label: "Waiting for signatures" };
}

function ExitCard({ x, vault, nowSec, open }: { x: ExitView; vault: VaultState; nowSec: number; open: boolean }) {
  const st = exitStatus(x, vault.threshold, nowSec);
  if (x.error) {
    return (
      <section className="panel exit">
        <h2>
          <span>
            Batch {x.batchIndex}, withdrawal {x.withdrawalIndex}
          </span>
          <span className={`chip ${st.cls}`}>{st.label}</span>
        </h2>
        <p className="err">This exit could not be read just now: {x.error}. The page asks again on the next refresh.</p>
      </section>
    );
  }
  const b = x.batch;
  const f = x.fronted;
  const r = x.repayment;
  const amount = x.claim?.amountUqor ?? (f ? (f.paid + f.fee) / WEI_PER_UQOR : undefined);
  const exitName = x.recipientQor1 ? (nameOf(x.recipientQor1) ?? (f ? `exit address of ${nameOf(f.payout) ?? shortAddr(f.payout)}` : undefined)) : undefined;
  const exitLabel = x.recipientQor1 ? (
    <span title={x.recipientQor1}>{exitName ? <strong>{exitName}</strong> : <code>{shortAddr(x.recipientQor1)}</code>}</span>
  ) : (
    <span>the exit address</span>
  );
  const final = !!b?.final;
  const finalFrom = b?.finalFrom;
  const shown = x.attestations.filter((a) => a.sameClaim);
  const counted = shown.filter((a) => a.local === true && a.pqc.valid !== false);
  const signedAt = counted[vault.threshold - 1]?.entry;
  const missing = vault.members.filter((m) => !shown.some((a) => a.member.address === m.address));
  const lastShare = r?.shares.at(-1);
  const repaidBy = r?.completedBy ?? lastShare?.settle;

  return (
    <section className="panel exit">
      <h2>
        <span>
          Batch {x.batchIndex}, withdrawal {x.withdrawalIndex}
        </span>
        <span className={`chip ${st.cls}`}>{st.label}</span>
      </h2>
      <p className="note">
        {amount !== undefined && <>{qor(amount)} to </>}
        {exitLabel} · exit id <code title={x.id}>{short(x.id, 6)}</code>
      </p>

      {f && (
        <div className="mini">
          <div className="stat">
            <div className="k">Paid to the user</div>
            <div className="v">{qorWei(f.paid)}</div>
            <div className="s">{x.withdrawal ? `${dur(f.time - x.withdrawal.entry.time)} after the L2 withdrawal` : `to ${nameOf(f.payout) ?? shortAddr(f.payout)}`}</div>
          </div>
          <div className="stat">
            <div className="k">Ahead of finality</div>
            <div className="v">{finalFrom ? (finalFrom > f.time ? dur(finalFrom - f.time) : "none") : "—"}</div>
            <div className="s">before batch {x.batchIndex} could be final</div>
          </div>
          <div className="stat">
            <div className="k">Vault repaid</div>
            <div className="v">{r && r.repaid > 0n ? qorWei(r.repaid) : "not yet"}</div>
            <div className="s">{r?.completedBy ? "for this exit, by its own withdrawal, via sweep()" : r && r.repaid > 0n ? `of ${qorWei(r.owed)} owed for this exit` : "after finality, via sweep()"}</div>
          </div>
        </div>
      )}

      <details className="evidence-log" open={open}>
        <summary>
          <span>The evidence, step by step</span>
          <span className="note">withdrawal, batch, signatures, payment, finality, repayment</span>
        </summary>
      <ol className="steps">
        {/* 1. The L2 withdrawal */}
        {x.withdrawal ? (
          <Step
            tone="ok"
            title="Withdrawn on L2"
            when={x.withdrawal.entry.time}
            links={
              <>
                <Ext href={txUrl(x.withdrawal.entry.tx)}>post tx</Ext>
                <span>block {x.withdrawal.entry.height.toLocaleString()}</span>
              </>
            }
          >
            {qor(x.withdrawal.amount)} from L2 account <code title={x.withdrawal.account}>{short(x.withdrawal.account, 6)}</code> to {exitLabel}, posted as inbox entry{" "}
            <strong>#{x.withdrawal.entry.sequence}</strong> by <Who addr={x.withdrawal.entry.poster} />.{" "}
            {x.withdrawal.signatureValid ? <span className="chip ok">ML-DSA-44 signature valid in browser</span> : <span className="chip bad">L2 signature does not verify</span>}
          </Step>
        ) : (
          <Step tone="skip" label="not found" title="Withdrawn on L2">
            {x.recipientQor1 ? "No inbox entry withdrawing this amount to this exit address was found in the node's transaction index." : "The exit's claim is not in the inbox, so its withdrawal is not shown."}
          </Step>
        )}

        {/* 2. The batch */}
        {b ? (
          <Step
            tone={b.status === "rejected" || b.status === "replaced" || b.sameRoot === false ? "bad" : b.status === "missing" ? "wait" : "ok"}
            title={`In batch ${b.index}`}
            when={b.submittedTime}
            links={
              <>
                {b.tx && <Ext href={txUrl(b.tx)}>batch tx</Ext>}
                {b.submittedHeight !== undefined && <span>block {b.submittedHeight.toLocaleString()}</span>}
                {b.anchored && <a href={`#/verify?batch=${b.index}`}>verify its receipt</a>}
              </>
            }
          >
            {b.inboxEnd !== undefined && b.inboxStart !== undefined && b.inboxEnd > b.inboxStart && (
              <>
                Settles inbox {b.inboxEnd - b.inboxStart === 1 ? `entry ${b.inboxEnd}` : `entries ${b.inboxStart + 1} to ${b.inboxEnd}`} as withdrawal {x.withdrawalIndex}.{" "}
              </>
            )}
            {b.status === "pruned" ? (
              <>
                <span className="chip pruned">record pruned</span> {b.missing?.reason}.{" "}
              </>
            ) : b.status === "missing" ? (
              <>
                <span className="chip warn">record missing</span> {b.missing?.reason}, so it is not treated as final.{" "}
              </>
            ) : b.status === "replaced" ? (
              <>
                <span className="chip bad">replaced</span> The chain's batch {b.index} now has another root: the batch the quorum signed was rejected and its index
                reused.{" "}
              </>
            ) : (
              <>
                <span className={`chip ${b.status}`}>{b.status}</span>{" "}
              </>
            )}
            {b.sameRoot === true && (
              <>
                The attested state root <code title={b.root}>{short(b.root ?? "", 6)}</code> is the batch's root.
              </>
            )}
            {b.sameRoot === false && (
              <>
                The quorum signed <code>{short(x.claim?.stateRoot ?? "", 6)}</code>, but the batch's root is <code>{short(b.root ?? "", 6)}</code>.
              </>
            )}
            {b.sameRoot === undefined && x.claim && <>The batch's root could not be read to compare with the attested one.</>}
          </Step>
        ) : (
          <Step tone="skip" label="not read" title={`In batch ${x.batchIndex}`}>
            The batch could not be read from the chain just now.
          </Step>
        )}

        {/* 3. The quorum's signatures */}
        {f && x.attestations.length === 0 ? (
          <Step tone="skip" label="not checked here" title="Signed by the quorum (not checked here)">
            The attestations for this exit were not found in the rollup's inbox, so this page did not check them. front() pays only after the vault itself has
            verified {vault.threshold} members' ML-DSA-87 signatures with pqcVerify.
          </Step>
        ) : (
          <Step
            tone={x.validSigners >= vault.threshold ? "ok" : shown.some((a) => a.pqc.valid === false) ? "bad" : "wait"}
            title={
              x.validSigners >= vault.threshold && x.validSigners === vault.members.length && vault.members.length === 2
                ? "Signed by both watchtowers"
                : `Signed by ${x.validSigners} of ${vault.members.length} watchtowers (${vault.threshold} needed)`
            }
            when={x.validSigners >= vault.threshold ? signedAt?.time : undefined}
          >
            <ul className="sigs">
              {x.attestations.map((a) => (
                <li key={`${a.member.address}:${a.entry.sequence}`}>
                  <Mark tone={a.local === true && a.pqc.valid !== false ? (a.sameClaim ? "ok" : "wait") : a.pqc.valid === false ? "bad" : "wait"} />
                  <span>
                    <Who addr={a.member.qor1} also={a.member.address} /> signed (watchtowers sign after re-executing the batch): inbox entry{" "}
                    <strong>#{a.entry.sequence}</strong>
                    {b?.submittedHeight !== undefined && a.entry.height >= b.submittedHeight && <>, {(a.entry.height - b.submittedHeight).toLocaleString()} blocks after the batch</>}
                    , posted by the member itself. <SigChips a={a} /> {!a.sameClaim && <span className="chip warn">signed a different claim</span>}{" "}
                    <Ext href={txUrl(a.entry.tx)}>tx</Ext>
                    {a.pqc.error && <span className="note"> ({a.pqc.error})</span>}
                  </span>
                </li>
              ))}
              {missing.map((m) => (
                <li key={m.address}>
                  <Mark tone="wait" label="no attestation" />
                  <span>
                    <Who addr={m.qor1} also={m.address} /> has no accepted attestation for this exit.
                  </span>
                </li>
              ))}
            </ul>
            {x.claim && (
              <p>
                They signed batch {x.claim.batchIndex}, root <code title={x.claim.stateRoot}>{short(x.claim.stateRoot, 6)}</code>, withdrawal {x.claim.withdrawalIndex},{" "}
                {qor(x.claim.amountUqor)} to <code title={x.recipientQor1}>{shortAddr(x.recipientQor1 ?? "")}</code>, valid until {stamp(x.claim.deadline)}
                {finalFrom && finalFrom > x.claim.deadline ? `, ${dur(finalFrom - x.claim.deadline)} before the batch could be final` : ""}. Each signature is checked twice:
                in this browser with ML-DSA-87 (FIPS 204) against the member's key, whose SHA-256 is pinned in this page; and by QoreChain's{" "}
                <code title={PQC_VERIFY}>pqcVerify</code> precompile through a free eth_call to {EVM_HOST}, which is what the vault itself relies on.
              </p>
            )}
            {x.messageCheck && (
              <p className="inline-check">
                <Mark tone={"error" in x.messageCheck ? "wait" : x.messageCheck.same ? "ok" : "bad"} />
                <span>
                  {"error" in x.messageCheck
                    ? `The vault's exitMessage() could not be read: ${x.messageCheck.error}`
                    : x.messageCheck.same
                      ? `The exit message rebuilt in this browser (${x.messageCheck.bytes} bytes) is byte for byte the vault's own exitMessage() for this exit and payout.`
                      : "The exit message rebuilt in this browser differs from the vault's exitMessage(): the signatures above were checked over the page's copy."}
                </span>
              </p>
            )}
          </Step>
        )}

        {/* 4. Fronted, or not */}
        {f ? (
          <Step
            tone="ok"
            title="Paid at once by the vault"
            when={f.time}
            links={
              <>
                <CopyHash label="front() tx" value={f.tx} />
                <span>EVM block {f.block.toLocaleString()}</span>
              </>
            }
          >
            The vault paid <strong>{qorWei(f.paid)}</strong> to <Who addr={f.payout} /> and kept a {qorWei(f.fee)} fee ({pct(vault.feeBps)}); the exit address now owed it{" "}
            {qorWei(f.paid + f.fee)} for this exit.{" "}
            {finalFrom && (
              <>
                That was <strong>{finalFrom > f.time ? `${dur(finalFrom - f.time)} before` : `${dur(f.time - finalFrom)} after`}</strong> batch {x.batchIndex} could be final
                {b?.submittedHeight !== undefined ? ` (${(f.block - b.submittedHeight).toLocaleString()} blocks after the batch)` : ""}.{" "}
              </>
            )}
            {f.from && (
              <>
                Sent by <Who addr={f.from} />; anyone may send front(), and the money can only go to the payout.
              </>
            )}
          </Step>
        ) : x.executed || (x.claim && nowSec > x.claim.deadline) ? (
          <Step tone="skip" title="Not fronted">
            {x.claim ? `The deadline (${stamp(x.claim.deadline)}) passed with nobody fronting it, ` : "Nobody fronted it, "}
            {x.executed ? "so the withdrawal waited for finality and was paid in full instead." : "so the withdrawal waits for finality and is then paid in full."}
          </Step>
        ) : x.validSigners >= vault.threshold && x.claim ? (
          <Step tone="wait" title="Ready to be fronted">
            Anyone can call front() with these signatures until {stamp(x.claim.deadline)} (in {dur(x.claim.deadline - nowSec)}), if the vault has{" "}
            {qor((x.claim.amountUqor * BigInt(10_000 - vault.feeBps)) / 10_000n)} free.
          </Step>
        ) : (
          <Step tone="wait" title="Not fronted yet">
            front() needs {vault.threshold} valid signatures; {x.validSigners} so far.
          </Step>
        )}

        {/* 5. Final */}
        {b?.status === "rejected" || b?.status === "replaced" ? (
          <Step tone="bad" title={`Batch ${x.batchIndex} rejected`}>
            A fraud proof removed the batch the quorum signed, so this withdrawal does not exist on L1.{f ? " The vault's LP bears the loss of a front against a bad batch." : ""}
          </Step>
        ) : final ? (
          <Step
            tone="ok"
            title={`Batch ${x.batchIndex} final`}
            when={b?.finalizedTime}
            links={b?.finalizedHeight ? <Ext href={blockUrl(b.finalizedHeight)}>block {b.finalizedHeight.toLocaleString()}</Ext> : undefined}
          >
            {b?.status === "pruned"
              ? `Its record has since been pruned: ${b.missing?.reason ?? "the chain prunes only finalized batches"}.`
              : `Its challenge window closed with no fraud proof${finalFrom && b?.finalizedTime ? ` (it could be final from ${stamp(finalFrom)})` : ""}.`}
          </Step>
        ) : (
          <Step tone="wait" title={`Batch ${x.batchIndex} final`}>
            {b?.status === "missing" || (b?.status === "pruned" && !b.final)
              ? `Not confirmed: ${b.missing?.reason ?? "the batch record is missing"}.`
              : finalFrom
                ? finalFrom > nowSec
                  ? `Its challenge window closes at ${stamp(finalFrom)}, in ${dur(finalFrom - nowSec)}.`
                  : `Its challenge window closed at ${stamp(finalFrom)}; the chain finalizes it with the next block that checks.`
                : "Final once its challenge window closes with no fraud proof."}
          </Step>
        )}

        {/* 6. Paid on L1 */}
        {x.executed ? (
          <Step
            tone="ok"
            title="Withdrawal paid on L1"
            when={x.executed.time}
            links={
              <>
                <Ext href={txUrl(x.executed.tx)}>execute tx</Ext>
                <span>block {x.executed.height.toLocaleString()}</span>
              </>
            }
          >
            The chain paid {qor(x.executed.amount)} to {exitLabel}.{" "}
            {x.executed.submitter && (
              <>
                MsgExecuteWithdrawal sent by <Who addr={x.executed.submitter} /> (anyone may).{" "}
              </>
            )}
            {!f && "Nothing is owed to the vault, so sweep(payout) forwards all of it to the payout."}
          </Step>
        ) : (
          <Step tone={b?.status === "rejected" || b?.status === "replaced" ? "skip" : "wait"} title="Withdrawal paid on L1">
            {final ? "The batch is final: anyone can now execute the withdrawal, and the chain pays the exit address." : "After finality anyone executes the withdrawal on L1, and the chain pays the exit address."}
          </Step>
        )}

        {/* 7. Repaid */}
        {f &&
          (r && lastShare && repaidBy ? (
            <Step
              tone={r.completedBy ? "ok" : "wait"}
              title={r.completedBy ? "Vault repaid" : "Vault partly repaid"}
              when={repaidBy.time}
              links={
                <>
                  {r.shares.map((s) => (
                    <CopyHash key={`${s.settle.tx}:${s.settle.logIndex}`} label="sweep() tx" value={s.settle.tx} />
                  ))}
                  <span>EVM block {repaidBy.block.toLocaleString()}</span>
                </>
              }
            >
              sweep() moved the exit address's money and repaid the vault {qorWei(r.repaid)} for this exit
              {r.completedBy ? "" : `, of the ${qorWei(r.owed)} it owed`}
              {r.shares.length > 1 ? ` (over ${r.shares.length} sweeps)` : ""}. The vault keeps one balance per payout and repayments go to its exits oldest first.
              After that sweep, <Who addr={f.payout} /> owed the vault {qorWei(lastShare.settle.stillOwed)} for all its exits
              {x.owedNow !== undefined && x.owedNow !== lastShare.settle.stillOwed ? ` (now ${qorWei(x.owedNow)})` : ""}.{" "}
              {repaidBy.from && (
                <>
                  Sent by <Who addr={repaidBy.from} />.
                </>
              )}
            </Step>
          ) : (
            <Step tone="wait" title="Vault repaid">
              Once the chain pays the exit address, sweep(payout) repays the vault first and forwards anything left to the payout. Anyone may call it.
            </Step>
          ))}
      </ol>
      </details>
    </section>
  );
}

function VaultPanel({ s }: { s: ExitsState }) {
  const v = s.vault;
  return (
    <section className="panel">
      <h2>
        The vault{" "}
        <small>
          <Ext href={SOURCE}>InstantExitVault.sol</Ext>
        </small>
      </h2>
      <div className="addr-block">
        <code>{v.address}</code>
        <code>{v.qor1}</code>
        <span className="note">
          <Ext href={accountUrl(v.qor1)}>explorer</Ext> · <CopyHash label="deploy tx" value={v.deployTx} />, EVM block {v.deployBlock.toLocaleString()}
        </span>
      </div>
      <dl className="kv">
        <dt>Fronts for</dt>
        <dd>
          <code>{v.rollupId}</code> on <code>{v.chainId}</code> (EVM chain {v.evmChainId}), read from the contract
        </dd>
        <dt>Quorum</dt>
        <dd>
          <strong>
            {v.threshold} of {v.members.length}
          </strong>{" "}
          must sign each exit
          <ul className="plain">
            {v.members.map((m) => (
              <li key={m.address}>
                <Who addr={m.qor1} also={m.address} />
                <span className="member-meta">
                  <code>{short(m.address, 6)}</code> <KeyChip m={m} />
                </span>
              </li>
            ))}
          </ul>
        </dd>
        <dt>Fee</dt>
        <dd>
          {pct(v.feeBps)} ({v.feeBps} bps) of each fronted exit, kept by the vault
        </dd>
        <dt>LP</dt>
        <dd>
          <Who addr={v.lp.qor1} also={v.lp.address} />
          {v.lpIsCreator ? ", the rollup's creator" : ""}. Only its ML-DSA-87 key can take liquidity out.{" "}
          <span className="member-meta">
            <KeyChip m={v.lp} />
          </span>
        </dd>
        {v.funding.length > 0 && (
          <>
            <dt>Funding</dt>
            <dd>
              {v.funding.map((f) => {
                const tx = f.tx.startsWith("0x") ? <CopyHash label="tx" value={f.tx} /> : <Ext href={txUrl(f.tx)}>tx</Ext>;
                return f.wei < 0n ? (
                  <div key={f.tx}>
                    {qorWei(-f.wei)} taken out to <Who addr={f.from} />, signed by the LP · {tx}
                  </div>
                ) : (
                  <div key={f.tx}>
                    {qorWei(f.wei)} from <Who addr={f.from} /> by {f.via} · {tx}
                  </div>
                );
              })}
            </dd>
          </>
        )}
      </dl>
      <p className="note" style={{ marginTop: 10 }}>
        No owner and no admin key: every action is either open to anyone (front, sweep) or authorised by an ML-DSA-87 signature the contract checks with pqcVerify,
        against keys it reads live with pqcKeyStatus.
      </p>
      <ExplorerHint />
    </section>
  );
}

function ExitAddressTool({ example }: { example: string | undefined }) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExitAddress>();
  const [error, setError] = useState<string>();

  async function lookUp(value: string) {
    const p = parsePayout(value);
    setResult(undefined);
    if (!p.ok) {
      setError(p.error);
      return;
    }
    setError(undefined);
    setBusy(true);
    try {
      setResult(await exitAddressFor(p.address));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void lookUp(input);
  };

  return (
    <section className="panel">
      <h2>Find an exit address</h2>
      <p className="note">
        Withdraw on L2 to this address. A relayer (or anyone) can then front it, and if nobody does, the full amount reaches the payout after finality via sweep.
      </p>
      <form className="row" onSubmit={submit} style={{ marginTop: 8 }}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Payout: qor1… or 0x…"
          aria-label="Payout address, qor1 or 0x"
          spellCheck={false}
          autoComplete="off"
        />
        <button className="primary" disabled={busy || !input.trim()}>
          {busy ? "Deriving…" : "Get exit address"}
        </button>
      </form>
      {example && !result && (
        <p className="note" style={{ marginTop: 6 }}>
          Or{" "}
          <button
            className="link"
            type="button"
            onClick={() => {
              setInput(example);
              void lookUp(example);
            }}
          >
            use the payout of the latest fronted exit
          </button>
          .
        </p>
      )}
      {error && (
        <p className="err" style={{ marginTop: 8 }}>
          {error}
        </p>
      )}
      {result && (
        <>
          <div className="addr-block">
            <span className="note">
              Payout
              {nameOf(result.payoutQor1) ? (
                <>
                  : <strong>{nameOf(result.payoutQor1)}</strong>
                </>
              ) : (
                ""
              )}
            </span>
            <code>{result.payoutQor1}</code>
            <code>{result.payout}</code>
          </div>
          <div className="addr-block">
            <span className="note">
              Its exit address, derived in this browser (CREATE2 over the ExitAddress code pinned in the page){" "}
              {result.vaultAgrees ? (
                <span className="chip ok" title="The vault's exitAddressOf() returned the same address">
                  the vault's exitAddressOf() agrees
                </span>
              ) : (
                <span className="chip warn" title={result.vaultError}>
                  not confirmed: the vault could not be asked
                </span>
              )}
            </span>
            <code>
              <strong>{result.exitQor1}</strong>
            </code>
            <code>{result.exit}</code>
          </div>
          <dl className="kv">
            <dt>Owes the vault</dt>
            <dd>{result.owed === undefined ? "could not be read" : qorWei(result.owed)}</dd>
            <dt>Holds now</dt>
            <dd>{result.holds === undefined ? "could not be read" : qorWei(result.holds)}</dd>
          </dl>
        </>
      )}
    </section>
  );
}

function HowPanel({ s, refreshing }: { s: ExitsState; refreshing: boolean }) {
  const acc = s.inbox.accumulatorOk;
  const c = s.checks;
  const sigCount = c.local.verified + c.local.unchecked;
  const rows: { tone: Tone; label: string; what: ReactNode; why: ReactNode }[] = [
    {
      tone: acc === true ? "ok" : acc === false ? "bad" : "wait",
      label: acc === true ? "passed" : acc === false ? "failed" : "not checked",
      what: `Inbox: ${s.inbox.read} of ${s.inbox.head} entries read back from ${NODE_HOST}`,
      why: (
        <>
          {acc === true
            ? "Together they reproduce the chain's inbox accumulator, so none is missing or altered. "
            : acc === false
              ? "They do NOT reproduce the chain's inbox accumulator. "
              : "The node's index did not return every entry, so the accumulator could not be checked. "}
          {s.inbox.fetched === s.inbox.read
            ? "All were read this time; later refreshes read only entries posted since."
            : s.inbox.fetched
              ? `${s.inbox.fetched} new this refresh; earlier entries are kept, not read again.`
              : "Nothing new this refresh; earlier entries are kept, not read again."}
        </>
      ),
    },
    {
      tone: "ok",
      label: "screened",
      what: `Attestations: ${s.inbox.accepted} accepted`,
      why: (
        <>
          Only posts for this vault, by a quorum member, posted by that member's own address, with a signature that verifies in this browser.{" "}
          {s.inbox.rejected.length === 0
            ? "No look-alike post was rejected."
            : `Ignored: ${s.inbox.rejected.map((r) => `${r.count} ${r.reason} (${r.example})`).join("; ")}.`}
        </>
      ),
    },
    {
      tone: c.keys.mismatch ? "bad" : c.keys.unread ? "wait" : "ok",
      label: c.keys.mismatch ? "failed" : c.keys.unread ? "not checked" : "passed",
      what: "Keys: compared with the ones pinned in this page",
      why: `${c.keys.match} of ${c.keys.match + c.keys.mismatch + c.keys.unread} member and LP keys, as the vault reads them (keyOf, pqcKeyStatus), have the SHA-256 pinned in the page's source${c.keys.mismatch ? `; ${c.keys.mismatch} differ` : ""}${c.keys.unread ? `; ${c.keys.unread} could not be read` : ""}.`,
    },
    {
      tone: sigCount === 0 ? "skip" : c.local.unchecked ? "wait" : "ok",
      label: sigCount === 0 ? "nothing to check" : c.local.unchecked ? "partly checked" : "passed",
      what: "Signatures in this browser: ML-DSA-87",
      why:
        sigCount === 0
          ? "No attestation on the exits shown."
          : `${c.local.verified} of ${sigCount} verified here with @noble/post-quantum (FIPS 204, empty context) over the exit message rebuilt in the page${c.local.unchecked ? `; ${c.local.unchecked} could not be checked (the key was not read, or differs from the pinned one)` : ""}.`,
    },
    {
      tone: sigCount === 0 ? "skip" : c.pqc.invalid ? "bad" : c.pqc.unanswered ? "wait" : "ok",
      label: sigCount === 0 ? "nothing to check" : c.pqc.invalid ? "failed" : c.pqc.unanswered ? "partly answered" : "passed",
      what: "Signatures on chain: the pqcVerify precompile",
      why: (
        <>
          {sigCount === 0 ? "No attestation on the exits shown. " : `${c.pqc.valid} of ${sigCount} answered valid${c.pqc.invalid ? `, ${c.pqc.invalid} invalid` : ""}${c.pqc.unanswered ? `, ${c.pqc.unanswered} not answered` : ""}. `}
          Asked at <code>{shortAddr(PQC_VERIFY)}</code> with a free eth_call to {EVM_HOST} (the node's operator; the answer is not proven). This is what the vault itself
          relies on.
        </>
      ),
    },
    {
      tone: s.logs.gaps.length ? "wait" : "ok",
      label: s.logs.gaps.length ? "incomplete" : "passed",
      what: "Vault history: eth_getLogs",
      why: s.logs.gaps.length
        ? `Blocks ${s.logs.gaps.map(([a, b]) => `${a.toLocaleString()}–${b.toLocaleString()}`).join(", ")} could not be read after ${3} tries each; they are asked again on the next refresh, and anything shown from them may be missing.`
        : `Blocks ${s.logs.from.toLocaleString()} to ${s.logs.to.toLocaleString()} read (${s.logs.requests} request${s.logs.requests === 1 ? "" : "s"} this refresh, ${s.logs.totalRequests} since the page opened; at most ${LOG_SPAN.toLocaleString()} blocks per request). Each refresh reads only new blocks.`,
    },
  ];
  return (
    <section className="panel">
      <h2>
        How this is read <small>{refreshing ? "refreshing…" : `updated ${utcTime(s.loadedAt)}`}</small>
      </h2>
      <ul className="checks">
        {rows.map((r, i) => (
          <li key={i}>
            <Mark tone={r.tone} label={r.label} />
            <span>
              <span className="what">{r.what}</span>
              <br />
              <span className="why">{r.why}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="note" style={{ marginTop: 10 }}>
        Refreshes when the rollup gets a new post or batch, after a reconnect, and every {REFRESH_MS / 1000} s while this tab is open.
      </p>
    </section>
  );
}

export function ExitsView() {
  const [limit, setLimit] = useState(EXITS_PAGE);
  const { data: state, error, refreshing, refresh } = useRefresh(() => loadExits(limit), REFRESH_MS);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const l = listen({
      onItem: (i) => {
        if (i.kind === "post" || i.kind === "batch") refresh();
      },
    });
    const tick = setInterval(() => setNow(Date.now()), 15_000);
    return () => {
      l.stop();
      clearInterval(tick);
    };
  }, [refresh]);

  useEffect(() => {
    if (state) setNow(Date.now());
  }, [state]);

  // "Show more" raised the limit: read again with it.
  useEffect(() => {
    if (limit > EXITS_PAGE) refresh();
  }, [limit, refresh]);

  const v = state?.vault;
  const windowSec = state?.challengeWindowSec;
  const windowText = windowSec === 3600 ? "one-hour" : windowSec ? `${Math.round(windowSec / 60)}-minute` : "";
  const quorumText = !v ? "both watchtowers" : v.threshold === v.members.length ? (v.members.length === 2 ? "both watchtowers" : `all ${v.members.length} watchtowers`) : `${v.threshold} of its ${v.members.length} watchtowers`;
  const nowSec = now / 1000;
  const example = state?.exits.find((x) => x.fronted)?.fronted?.payout;

  const lead = state?.exits.find((x) => v && raceTimes(x, v.threshold));
  const soundings: Sounding[] = [
    { k: "Liquidity", v: v ? qorWei(v.available) : undefined, s: "free to front exits now" },
    { k: "Owed to the vault", v: v ? qorWei(v.totalOwed) : undefined, s: "fronted, not yet swept back" },
    { k: "Exits fronted", v: v ? v.frontedCount : undefined, s: state ? `${state.totalExits} attested or fronted ${state.totalExits === 1 ? "exit" : "exits"}` : undefined },
    { k: "Fees earned", v: v ? qorWei(v.feesEarned) : undefined, s: v ? `${pct(v.feeBps)} of each fronted exit` : undefined },
    { k: "Quorum", v: v ? `${v.threshold} of ${v.members.length}` : undefined, s: "watchtowers sign with ML-DSA-87" },
    { k: "Without the vault", v: state ? (windowSec ? dur(windowSec) : "—") : undefined, s: "a withdrawal waits for finality" },
  ];

  return (
    <>
      <PageHead
        eyebrow={<>Instant exits · a vault on QoreChain's EVM</>}
        title="Instant exits"
        lede={
          <>
            <p>
              A withdrawal from {ROLLUP} is normally paid on QoreChain only after its batch has waited out the rollup's {windowText} challenge window.
            </p>
            <p>
              This vault pays it at once, when {quorumText} have re-executed the batch and signed for that withdrawal with ML-DSA-87; the vault checks those
              signatures on-chain with QoreChain's pqcVerify precompile, and after finality the withdrawal itself repays the vault. If nobody fronts an exit,
              the user still gets paid in full after the window.
            </p>
          </>
        }
        soundings={soundings}
      />

      {!state && !error && <Reading>Reading the vault, its logs and the rollup's inbox from {NODE_HOST} and {EVM_HOST}…</Reading>}
      {error && !state && <p className="err">Could not read the instant-exit vault: {error}. It is asked again every {REFRESH_MS / 1000} s.</p>}
      {error && state && (
        <p className="err">
          The last refresh failed ({error}); showing what was read at {utcTime(state.loadedAt)}.
        </p>
      )}

      {(!state || lead) && (
        <Race
          x={lead}
          t={lead && v ? raceTimes(lead, v.threshold) : undefined}
          nowSec={nowSec}
          title={
            lead ? (
              <>
                <b>The latest fronted exit</b> · batch {lead.batchIndex}, withdrawal {lead.withdrawalIndex}
              </>
            ) : (
              <b>The latest fronted exit</b>
            )
          }
        />
      )}

      {state && v && (
        <div className="cols">
          <div>
            {state.exits.length === 0 ? (
              <section className="panel">
                <h2>Exits</h2>
                <p className="empty">No watchtower has attested an exit for this vault yet, and none has been fronted.</p>
              </section>
            ) : (
              state.exits.map((x, i) => <ExitCard key={x.id} x={x} vault={v} nowSec={nowSec} open={i === 0} />)
            )}
            {state.totalExits > state.exits.length && (
              <p className="row" style={{ marginTop: 12 }}>
                <button type="button" disabled={refreshing} onClick={() => setLimit((n) => n + EXITS_PAGE)}>
                  {refreshing ? "Reading…" : `Show ${Math.min(EXITS_PAGE, state.totalExits - state.exits.length)} more`}
                </button>
                <span className="note">
                  Newest {state.exits.length} of {state.totalExits} exits shown.
                </span>
              </p>
            )}
          </div>
          <aside>
            <VaultPanel s={state} />
            <ExitAddressTool example={example} />
            <HowPanel s={state} refreshing={refreshing} />
          </aside>
        </div>
      )}
    </>
  );
}
