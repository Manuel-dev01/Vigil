import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { EXPLORER, REPO, ROLLUP, qor, short, shortAddr, txUrl } from "../chain.ts";
import {
  LOG_SPAN,
  ML_DSA_87_PUBKEY_LEN,
  PQC_VERIFY,
  WEI_PER_UQOR,
  exitAddressFor,
  loadExits,
  nameOf,
  parsePayout,
  qorWei,
  type ExitAddress,
  type ExitView,
  type ExitsState,
  type Member,
  type SigCheck,
  type VaultState,
} from "../exits.ts";
import { listen } from "../live.ts";

const REFRESH_MS = 30_000;
const SOURCE = `${REPO}/blob/main/contracts/src/InstantExitVault.sol`;
const addressUrl = (a: string): string => `${EXPLORER}/address/${a}`;
const blockUrl = (h: number): string => `${EXPLORER}/block/${h}`;

const utc = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const utcFull = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", dateStyle: "full", timeStyle: "long" });
/** A block time (Unix seconds) as "23 Nov, 21:05:37 UTC". */
const stamp = (unix: number): string => `${utc.format(unix * 1000)} UTC`;

/** A span of seconds in words: "47 s", "3 min 6 s", "57 min", "1 h 10 min", "3 days". */
function dur(sec: number): string {
  const s = Math.abs(Math.round(sec));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 10) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  return `${Math.floor(h / 24)} days`;
}

const pct = (bps: number): string => `${(bps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
const errText = (e: unknown): string => String(e instanceof Error ? e.message : e);

/** An account by its known name, or its shortened address; the full address on hover. */
function Who({ addr, also }: { addr: string; also?: string }) {
  const name = nameOf(addr);
  return <span title={also ? `${addr}\n${also}` : addr}>{name ? <strong>{name}</strong> : <code>{shortAddr(addr)}</code>}</span>;
}

type Tone = "ok" | "bad" | "skip" | "wait";
const MARKS: Record<Tone, [string, string]> = { ok: ["✓", "done"], bad: ["✕", "failed"], skip: ["–", "did not happen"], wait: ["○", "pending"] };

function Mark({ tone }: { tone: Tone }) {
  const [glyph, label] = MARKS[tone];
  return (
    <span className={`mark-${tone}`} role="img" aria-label={label}>
      {glyph}
    </span>
  );
}

function Step({ tone, title, when, children, links }: { tone: Tone; title: ReactNode; when?: number | undefined; children?: ReactNode; links?: ReactNode }) {
  return (
    <li>
      <Mark tone={tone} />
      <div>
        <div className="step-head">
          <span className="what">{title}</span>
          {when ? (
            <time className="when" dateTime={new Date(when * 1000).toISOString()} title={utcFull.format(when * 1000)}>
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
  if (m.keyBytes === ML_DSA_87_PUBKEY_LEN)
    return (
      <span className="chip ok" title={`keyOf() returned a ${m.keyBytes}-byte ML-DSA-87 public key: registered on chain, with proof of possession`}>
        ML-DSA-87 key registered and proven
      </span>
    );
  return <span className="chip bad">no usable ML-DSA-87 key</span>;
}

function SigChip({ c }: { c: SigCheck }) {
  if (c.valid === true)
    return (
      <span className="chip ok" title={`QoreChain's pqcVerify precompile answered true (${c.ms} ms)`}>
        pqcVerify: valid
      </span>
    );
  if (c.valid === false) return <span className="chip bad">pqcVerify: invalid</span>;
  return (
    <span className="chip warn" title={c.error}>
      not checked
    </span>
  );
}

function exitStatus(x: ExitView, threshold: number, nowSec: number): { cls: string; label: string } {
  if (x.batch?.status === "rejected") return { cls: "bad", label: "Batch rejected" };
  if (x.fronted) return x.repaid ? { cls: "ok", label: "Paid at once · vault repaid" } : { cls: "warn", label: "Paid at once · repayment pending" };
  if (x.executed) return { cls: "pruned", label: "Not fronted · paid in full after finality" };
  if (x.claim && nowSec > x.claim.deadline) return { cls: "warn", label: "Not fronted · waiting for finality" };
  if (x.validSigners >= threshold) return { cls: "info", label: "Ready to front" };
  return { cls: "warn", label: "Waiting for signatures" };
}

function ExitCard({ x, vault, nowSec }: { x: ExitView; vault: VaultState; nowSec: number }) {
  const st = exitStatus(x, vault.threshold, nowSec);
  const b = x.batch;
  const f = x.fronted;
  const amount = x.claim?.amountUqor ?? (f ? (f.paid + f.fee) / WEI_PER_UQOR : undefined);
  const exitName = x.recipientQor1 ? (nameOf(x.recipientQor1) ?? (f ? `exit address of ${nameOf(f.payout) ?? shortAddr(f.payout)}` : undefined)) : undefined;
  const exitLabel = x.recipientQor1 ? (
    <span title={x.recipientQor1}>{exitName ? <strong>{exitName}</strong> : <code>{shortAddr(x.recipientQor1)}</code>}</span>
  ) : (
    <span>the exit address</span>
  );
  const final = b?.status === "finalized" || b?.status === "pruned";
  const finalFrom = b?.finalFrom;
  const signedAt = x.attestations[vault.threshold - 1]?.entry;
  const missing = vault.members.filter((m) => !x.attestations.some((a) => a.member.address === m.address));
  const repaidBy = x.settlements.find((s) => s.stillOwed === 0n) ?? x.settlements.at(-1);

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
            <div className="v">{x.repaid ? qorWei(x.settlements.reduce((n, s) => n + s.repaid, 0n)) : "not yet"}</div>
            <div className="s">{x.repaid ? "by the withdrawal itself, via sweep()" : "after finality, via sweep()"}</div>
          </div>
        </div>
      )}

      <ol className="steps">
        {/* 1. The L2 withdrawal */}
        {x.withdrawal ? (
          <Step
            tone="ok"
            title="Withdrawn on L2"
            when={x.withdrawal.entry.time}
            links={
              <>
                <a href={txUrl(x.withdrawal.entry.tx)}>post tx</a>
                <span>block {x.withdrawal.entry.height.toLocaleString()}</span>
              </>
            }
          >
            {qor(x.withdrawal.amount)} from L2 account <code title={x.withdrawal.account}>{short(x.withdrawal.account, 6)}</code> to {exitLabel}, posted as inbox entry{" "}
            <strong>#{x.withdrawal.entry.sequence}</strong> by <Who addr={x.withdrawal.entry.poster} />.{" "}
            {x.withdrawal.signatureValid ? <span className="chip ok">ML-DSA-44 signature valid</span> : <span className="chip bad">L2 signature does not verify</span>}
          </Step>
        ) : (
          <Step tone="skip" title="Withdrawn on L2">
            {x.claim ? "No inbox entry withdrawing this amount to this exit address was found in the node's transaction index." : "The exit's claim is not in the inbox, so its withdrawal is not shown."}
          </Step>
        )}

        {/* 2. The batch */}
        {b ? (
          <Step
            tone={b.status === "rejected" || b.sameRoot === false ? "bad" : "ok"}
            title={`In batch ${b.index}`}
            when={b.submittedTime}
            links={
              <>
                {b.tx && <a href={txUrl(b.tx)}>batch tx</a>}
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
                <span className="chip pruned">record pruned</span> The chain deletes a finalized batch's record after about 7 days; its anchor{b.anchored ? " still carries the root" : " is not found either"}.{" "}
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
                <span className="chip bad">different root</span> The quorum signed <code>{short(x.claim?.stateRoot ?? "", 6)}</code>, but the batch's root is <code>{short(b.root ?? "", 6)}</code>.
              </>
            )}
            {b.sameRoot === undefined && x.claim && <>The batch's root could not be read to compare with the attested one.</>}
          </Step>
        ) : (
          <Step tone="skip" title={`In batch ${x.batchIndex}`}>
            The batch could not be read from the chain just now.
          </Step>
        )}

        {/* 3. The quorum's signatures */}
        {f && x.attestations.length === 0 ? (
          <Step tone="ok" title="Signed by the quorum">
            The attestations for this exit were not found in the rollup's inbox, so they are not re-checked here. front() pays only after the vault itself has
            verified {vault.threshold} members' ML-DSA-87 signatures with pqcVerify.
          </Step>
        ) : (
          <Step
            tone={x.validSigners >= vault.threshold ? "ok" : x.attestations.some((a) => a.check.valid === false) ? "bad" : "wait"}
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
                  <Mark tone={a.check.valid === true && a.sameClaim ? "ok" : a.check.valid === false ? "bad" : "wait"} />
                  <span>
                    <Who addr={a.member.qor1} also={a.member.address} /> re-executed the batch and signed: inbox entry <strong>#{a.entry.sequence}</strong>
                    {b?.submittedHeight !== undefined && a.entry.height >= b.submittedHeight && <>, {(a.entry.height - b.submittedHeight).toLocaleString()} blocks after the batch</>}
                    {a.entry.poster !== a.member.qor1 && (
                      <>
                        {" "}
                        (posted by <Who addr={a.entry.poster} />)
                      </>
                    )}
                    . <SigChip c={a.check} /> {!a.sameClaim && <span className="chip warn">signed a different claim</span>}{" "}
                    <a href={txUrl(a.entry.tx)}>tx</a>
                    {a.check.error && <span className="note"> ({a.check.error})</span>}
                  </span>
                </li>
              ))}
              {missing.map((m) => (
                <li key={m.address}>
                  <Mark tone="wait" />
                  <span>
                    <Who addr={m.qor1} also={m.address} /> has not attested this exit.
                  </span>
                </li>
              ))}
            </ul>
            {x.claim && (
              <p>
                They signed batch {x.claim.batchIndex}, root <code title={x.claim.stateRoot}>{short(x.claim.stateRoot, 6)}</code>, withdrawal {x.claim.withdrawalIndex},{" "}
                {qor(x.claim.amountUqor)} to <code title={x.recipientQor1}>{shortAddr(x.recipientQor1 ?? "")}</code>, valid until {stamp(x.claim.deadline)}
                {finalFrom && finalFrom > x.claim.deadline ? `, ${dur(finalFrom - x.claim.deadline)} before the batch could be final` : ""}. Each signature is checked here
                by QoreChain's own <code title={PQC_VERIFY}>pqcVerify</code> precompile (ML-DSA-87, a free eth_call), against the member's key as the vault reads it.
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
                <a href={txUrl(f.tx)}>front() tx</a>
                <span>EVM block {f.block.toLocaleString()}</span>
              </>
            }
          >
            The vault paid <strong>{qorWei(f.paid)}</strong> to <Who addr={f.payout} /> and kept a {qorWei(f.fee)} fee ({pct(vault.feeBps)}); the exit address now owed it{" "}
            {qorWei(f.paid + f.fee)}.{" "}
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
            Anyone can call front() with these signatures until {stamp(x.claim.deadline)} (in {dur(x.claim.deadline - nowSec)}), if the vault has {qor((x.claim.amountUqor * BigInt(10_000 - vault.feeBps)) / 10_000n)} free.
          </Step>
        ) : (
          <Step tone="wait" title="Not fronted yet">
            front() needs {vault.threshold} valid signatures; {x.validSigners} so far.
          </Step>
        )}

        {/* 5. Final */}
        {b?.status === "rejected" ? (
          <Step tone="bad" title={`Batch ${x.batchIndex} rejected`}>
            A fraud proof removed the batch, so this withdrawal does not exist on L1.{f ? " The vault's LP bears the loss of a front against a bad batch." : ""}
          </Step>
        ) : final ? (
          <Step
            tone="ok"
            title={`Batch ${x.batchIndex} final`}
            when={b?.finalizedTime}
            links={b?.finalizedHeight ? <a href={blockUrl(b.finalizedHeight)}>block {b.finalizedHeight.toLocaleString()}</a> : undefined}
          >
            {b?.status === "pruned"
              ? "Its record has since been pruned, which the chain does only to finalized batches."
              : `Its challenge window closed with no fraud proof${finalFrom && b?.finalizedTime ? ` (it could be final from ${stamp(finalFrom)})` : ""}.`}
          </Step>
        ) : (
          <Step tone="wait" title={`Batch ${x.batchIndex} final`}>
            {finalFrom
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
                <a href={txUrl(x.executed.tx)}>execute tx</a>
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
          <Step tone={b?.status === "rejected" ? "skip" : "wait"} title="Withdrawal paid on L1">
            {final ? "The batch is final: anyone can now execute the withdrawal, and the chain pays the exit address." : "After finality anyone executes the withdrawal on L1, and the chain pays the exit address."}
          </Step>
        )}

        {/* 7. Repaid */}
        {f &&
          (repaidBy ? (
            <Step
              tone={x.repaid ? "ok" : "wait"}
              title={x.repaid ? "Vault repaid" : "Vault partly repaid"}
              when={repaidBy.time}
              links={
                <>
                  {x.settlements.map((s) => (
                    <a key={s.tx} href={txUrl(s.tx)}>
                      sweep() tx
                    </a>
                  ))}
                  <span>EVM block {repaidBy.block.toLocaleString()}</span>
                </>
              }
            >
              sweep() moved the exit address's money and repaid the vault {qorWei(x.settlements.reduce((n, s) => n + s.repaid, 0n))}; the payout then owed{" "}
              {qorWei(repaidBy.stillOwed)}
              {x.owedNow !== undefined && x.owedNow !== repaidBy.stillOwed ? ` (now ${qorWei(x.owedNow)})` : ""}.{" "}
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
          <a href={SOURCE} target="_blank" rel="noreferrer">
            InstantExitVault.sol
          </a>
        </small>
      </h2>
      <div className="addr-block">
        <code>{v.address}</code>
        <code>{v.qor1}</code>
        <span className="note">
          <a href={addressUrl(v.address)}>explorer</a> · <a href={txUrl(v.deployTx)}>deploy tx</a>, EVM block {v.deployBlock.toLocaleString()}
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
          {v.lpIsCreator ? ", the rollup's creator" : ""}. Only its ML-DSA-87 key can take liquidity out. <KeyChip m={v.lp} />
        </dd>
        {v.funding.length > 0 && (
          <>
            <dt>Funding</dt>
            <dd>
              {v.funding.map((f) =>
                f.wei < 0n ? (
                  <div key={f.tx}>
                    {qorWei(-f.wei)} taken out to <Who addr={f.from} />, signed by the LP · <a href={txUrl(f.tx)}>tx</a>
                  </div>
                ) : (
                  <div key={f.tx}>
                    {qorWei(f.wei)} from <Who addr={f.from} /> by {f.via} · <a href={txUrl(f.tx)}>tx</a>
                  </div>
                ),
              )}
            </dd>
          </>
        )}
      </dl>
      <p className="note" style={{ marginTop: 10 }}>
        No owner and no admin key: every action is either open to anyone (front, sweep) or authorised by an ML-DSA-87 signature the contract checks with pqcVerify,
        against keys it reads live with pqcKeyStatus.
      </p>
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
      setError(`The vault could not be asked: ${errText(e)}`);
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
          {busy ? "Asking…" : "Get exit address"}
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
              Payout{nameOf(result.payoutQor1) ? <>: <strong>{nameOf(result.payoutQor1)}</strong></> : ""}
            </span>
            <code>{result.payoutQor1}</code>
            <code>{result.payout}</code>
          </div>
          <div className="addr-block">
            <span className="note">Its exit address, from the vault's exitAddressOf():</span>
            <code>
              <strong>{result.exitQor1}</strong>
            </code>
            <code>{result.exit}</code>
          </div>
          <dl className="kv">
            <dt>Owes the vault</dt>
            <dd>{qorWei(result.owed)}</dd>
            <dt>Holds now</dt>
            <dd>{qorWei(result.holds)}</dd>
          </dl>
        </>
      )}
    </section>
  );
}

function HowPanel({ s, refreshing }: { s: ExitsState; refreshing: boolean }) {
  const acc = s.inbox.accumulatorOk;
  return (
    <section className="panel">
      <h2>
        How this is read <small>{refreshing ? "refreshing…" : `updated ${new Date(s.loadedAt).toLocaleTimeString()}`}</small>
      </h2>
      <ul className="checks">
        <li>
          <Mark tone={acc === true ? "ok" : acc === false ? "bad" : "wait"} />
          <span>
            <span className="what">
              Inbox: {s.inbox.read} of {s.inbox.head} entries read back
            </span>
            <br />
            <span className="why">
              {acc === true
                ? "Together they reproduce the chain's inbox accumulator, so none is missing or altered. "
                : acc === false
                  ? "They do NOT reproduce the chain's inbox accumulator. "
                  : "The node's index did not return every entry, so the accumulator could not be checked. "}
              {s.inbox.attestations} {s.inbox.attestations === 1 ? "is an exit attestation" : "are exit attestations"} for this vault.
            </span>
          </span>
        </li>
        <li>
          <Mark tone="ok" />
          <span>
            <span className="what">Vault history: eth_getLogs</span>
            <br />
            <span className="why">
              Blocks {s.logs.from.toLocaleString()} to {s.logs.to.toLocaleString()} in {s.logs.requests} requests; the EVM endpoint answers at most {LOG_SPAN.toLocaleString()} blocks
              per request.
            </span>
          </span>
        </li>
        <li>
          <Mark tone="ok" />
          <span>
            <span className="what">Signatures: the chain's pqcVerify precompile</span>
            <br />
            <span className="why">
              Called at <code>{shortAddr(PQC_VERIFY)}</code> with a free eth_call, against each member's key from the vault's keyOf(), which reads pqcKeyStatus.
              An inactive precompile answers with no data, which is reported here as not checked.
            </span>
          </span>
        </li>
      </ul>
      <p className="note" style={{ marginTop: 10 }}>
        Refreshes when the rollup gets a new post or batch, and every {REFRESH_MS / 1000} s while this tab is open.
      </p>
    </section>
  );
}

export function ExitsView() {
  const [state, setState] = useState<ExitsState>();
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(Date.now());
  const lastLoad = useRef(0);

  // One load at a time; a request that arrives meanwhile runs once the current one ends.
  const refresh = useMemo(() => {
    let running = false;
    let again = false;
    const run = (): void => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      setRefreshing(true);
      loadExits()
        .then((s) => {
          setState(s);
          setError(undefined);
          setNow(Date.now());
        })
        .catch((e: unknown) => setError(errText(e)))
        .finally(() => {
          lastLoad.current = Date.now();
          running = false;
          setRefreshing(false);
          if (again) {
            again = false;
            run();
          }
        });
    };
    return run;
  }, []);

  useEffect(() => {
    refresh();
    const l = listen({
      onItem: (i) => {
        if (i.kind === "post" || i.kind === "batch") refresh();
      },
    });
    const visible = () => document.visibilityState === "visible";
    const poll = setInterval(() => {
      if (visible()) refresh();
    }, REFRESH_MS);
    const tick = setInterval(() => setNow(Date.now()), 15_000);
    const onVisibility = () => {
      if (visible() && Date.now() - lastLoad.current > REFRESH_MS) refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      l.stop();
      clearInterval(poll);
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  const v = state?.vault;
  const windowSec = state?.challengeWindowSec;
  const windowText = windowSec === 3600 ? "one-hour" : windowSec ? `${Math.round(windowSec / 60)}-minute` : "";
  const quorumText = !v ? "both watchtowers" : v.threshold === v.members.length ? (v.members.length === 2 ? "both watchtowers" : `all ${v.members.length} watchtowers`) : `${v.threshold} of its ${v.members.length} watchtowers`;
  const nowSec = now / 1000;
  const example = state?.exits.find((x) => x.fronted)?.fronted?.payout;

  return (
    <>
      <h1>Instant exits</h1>
      <p className="lede">
        A withdrawal from {ROLLUP} is normally paid on QoreChain only after its batch has waited out the rollup's {windowText} challenge window. This vault pays it at once,
        when {quorumText} have re-executed the batch and signed for that withdrawal with ML-DSA-87; the vault checks those signatures on-chain with QoreChain's pqcVerify
        precompile, and after finality the withdrawal itself repays the vault. If nobody fronts an exit, the user still gets paid in full after the window.
      </p>

      {!state && !error && <p className="empty">Reading the vault, its logs and the rollup's inbox from the chain…</p>}
      {error && !state && <p className="err">Could not read the instant-exit vault: {error}</p>}

      {state && v && (
        <>
          <div className="grid">
            <div className="stat">
              <div className="k">Liquidity</div>
              <div className="v">{qorWei(v.available)}</div>
              <div className="s">free to front exits now</div>
            </div>
            <div className="stat">
              <div className="k">Owed to the vault</div>
              <div className="v">{qorWei(v.totalOwed)}</div>
              <div className="s">fronted, not yet swept back</div>
            </div>
            <div className="stat">
              <div className="k">Exits fronted</div>
              <div className="v">{v.frontedCount}</div>
              <div className="s">
                {state.exits.length} attested {state.exits.length === 1 ? "exit" : "exits"} in the inbox
              </div>
            </div>
            <div className="stat">
              <div className="k">Fees earned</div>
              <div className="v">{qorWei(v.feesEarned)}</div>
              <div className="s">{pct(v.feeBps)} of each fronted exit</div>
            </div>
            <div className="stat">
              <div className="k">Quorum</div>
              <div className="v">
                {v.threshold} of {v.members.length}
              </div>
              <div className="s">watchtowers sign with ML-DSA-87</div>
            </div>
            <div className="stat">
              <div className="k">Without the vault</div>
              <div className="v">{windowSec ? dur(windowSec) : "—"}</div>
              <div className="s">a withdrawal waits for finality</div>
            </div>
          </div>

          {error && <p className="err">The last refresh failed ({error}); showing what was read at {new Date(state.loadedAt).toLocaleTimeString()}.</p>}

          <div className="cols">
            <div>
              {state.exits.length === 0 ? (
                <section className="panel">
                  <h2>Exits</h2>
                  <p className="empty">No watchtower has attested an exit for this vault yet, and none has been fronted.</p>
                </section>
              ) : (
                state.exits.map((x) => <ExitCard key={x.id} x={x} vault={v} nowSec={nowSec} />)
              )}
            </div>
            <aside>
              <VaultPanel s={state} />
              <ExitAddressTool example={example} />
              <HowPanel s={state} refreshing={refreshing} />
            </aside>
          </div>
        </>
      )}
    </>
  );
}
