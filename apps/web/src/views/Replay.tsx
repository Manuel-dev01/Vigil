/**
 * The browser watchtower, on the Rollup page: read every batch submission and inbox entry from the node,
 * re-execute every batch in a Web Worker (../replay/worker.ts) and judge it as our hosted watchtowers do,
 * then check what the rollup owes against its deposit pool, open any account against the anchored root,
 * and forge a batch locally to watch a fraud proof win. Loaded only when the visitor asks for it.
 *
 * Nothing here can send a transaction: the reads go through the page's GET-only chain client, and the
 * worker has no network code and no key. The tamper demo prints a challenge command; it never runs one.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from "react";
import { CHAIN_ID, KNOWN, NODE_HOST, ROLLUP, errText, qor, short, shortAddr, txUrl } from "../config.ts";
import type { BatchRow, Field, Lookup, ReplayResult } from "../replay/core.ts";
import { ReplayWorker } from "../replay/client.ts";
import type { ForgeAnswer } from "../replay/worker.ts";
import { readReplayInput, type ReadInfo } from "../replay/read.ts";
import { Ext, Mark, type Tone } from "../ui.tsx";
import { Reading } from "./Head.tsx";
import "./replay.css";

const FIELD: Record<Field, string> = {
  prevStateRoot: "parent state root",
  stateRoot: "state root",
  withdrawalsRoot: "withdrawals root",
  dataHash: "data hash",
  inboxAccumulator: "inbox accumulator",
};
const fields = (fs: Field[]): string => fs.map((f) => FIELD[f]).join(" and ");

const Who = ({ addr }: { addr: string | undefined }) =>
  !addr ? <span className="note">—</span> : <span title={addr}>{KNOWN[addr] ?? <code>{shortAddr(addr)}</code>}</span>;

/** "0.5" QOR to uqor; undefined if it is not a QOR amount with at most six decimals. */
function parseQor(s: string): bigint | undefined {
  const m = /^\s*(\d{1,12})(?:\.(\d{1,6}))?\s*$/.exec(s);
  if (!m) return undefined;
  return BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"));
}
const toQorText = (uqor: string): string => qor(uqor).replace(/ QOR$/, "").replace(/,/g, "");

type Phase = { kind: "reading"; step: string } | { kind: "replaying"; info: Omit<ReadInfo, "input"> } | { kind: "done"; info: Omit<ReadInfo, "input">; result: ReplayResult } | { kind: "error"; error: string };

export function ReplayPanel() {
  const worker = useRef<ReplayWorker>(undefined);
  const [phase, setPhase] = useState<Phase>({ kind: "reading", step: "the rollup" });
  const [run, setRun] = useState(0);

  useEffect(() => {
    let w: ReplayWorker | undefined;
    let alive = true;
    void (async () => {
      try {
        // Started first, inside the try: a worker that cannot start, or fails while the node is read,
        // shows here as an error with "Try again", not as a page-level error or an endless wait.
        w = new ReplayWorker();
        worker.current = w;
        setPhase({ kind: "reading", step: "the rollup" });
        const { input, ...info } = await readReplayInput((step) => alive && setPhase({ kind: "reading", step }));
        if (!alive) return;
        setPhase({ kind: "replaying", info });
        const result = await w.run(input);
        if (alive) setPhase({ kind: "done", info, result });
      } catch (e) {
        if (alive) setPhase({ kind: "error", error: errText(e) });
      }
    })();
    return () => {
      alive = false;
      w?.dispose();
      worker.current = undefined;
    };
  }, [run]);

  if (phase.kind === "reading") return <Reading>Reading {phase.step} from {NODE_HOST}…</Reading>;
  if (phase.kind === "replaying") return <Reading>Re-executing {ROLLUP} in this browser…</Reading>;
  if (phase.kind === "error")
    return (
      <div className="err" role="alert">
        <p>The re-execution did not finish: {phase.error}</p>
        <p>
          <button type="button" onClick={() => setRun((n) => n + 1)}>
            Try again
          </button>
        </p>
      </div>
    );
  return <Results info={phase.info} r={phase.result} worker={worker} again={() => setRun((n) => n + 1)} />;
}

/** After a run, "Read and re-execute again" waits this long: each run asks the public node about 70 questions. */
const COOLDOWN_MS = 30_000;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function Results({ info, r, worker, again }: { info: Omit<ReadInfo, "input">; r: ReplayResult; worker: RefObject<ReplayWorker | undefined>; again: () => void }) {
  const c = r.counts;
  const settled = c.kept + c.pruned;
  const reproduced = c.keptReproduced + c.prunedReproduced;
  // "Unknown parent" and "entries missing" were not judged: they count as neither reproduced nor wrong.
  const notJudged = c.keptNotJudged + c.prunedNotJudged;
  const wrong = settled - reproduced - notJudged;
  const seedIssue = r.seed !== undefined && (!r.seed.matches || r.seed.anchor === "other root");
  const tone = wrong > 0 ? "bad" : notJudged > 0 || c.keptAnchorOther > 0 || seedIssue || settled === 0 ? "warn" : "ok";
  const rolledBack = r.rows.filter((x) => x.where === "rolled back");
  const wrongBack = rolledBack.filter((x) => x.verdict === "differs");
  const allCaught = wrongBack.length > 0 && wrongBack.every((x) => x.challenge?.wins) && rolledBack.every((x) => x.verdict !== "unknown parent" && x.verdict !== "entries missing");

  // The button that started this run is gone: move focus to the verdict, which also announces it.
  const head = useRef<HTMLDivElement>(null);
  useEffect(() => head.current?.focus(), []);
  const [cooling, setCooling] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setCooling(false), COOLDOWN_MS);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="rp">
      <div className={`verdict ${tone}`} ref={head} tabIndex={-1} aria-live="polite">
        {reproduced} of {settled} batch{settled === 1 ? "" : "es"} reproduced in this browser in {r.ms.toLocaleString()} ms
        {wrong > 0 && `; ${wrong} did not reproduce`}
        {notJudged > 0 && `; ${notJudged} could not be judged here`}.
      </div>
      <p className="rp-sub">
        Each batch was re-executed here from the {r.entries} inbox entries, and its state root, withdrawals root and data hash compared with what {NODE_HOST}{" "}
        reports: the batch list
        {c.pruned > 0 && (
          <>
            , or, for the {c.pruned} whose record the chain has pruned, the batch's own submission and the ML-DSA-87 anchor recorded with it where there is
            one{c.prunedNoAnchor > 0 && <> ({plural(c.prunedNoAnchor, "has none and was", "have none and were")} checked against the submission only)</>}
          </>
        )}
        .{wrong > 0 && <> The table below names every field that differs.</>}
        {c.keptAnchorOther > 0 && (
          <>
            {" "}
            {plural(c.keptAnchorOther, "reproduced batch has", "reproduced batches have")} an ML-DSA-87 anchor that names another root, as {NODE_HOST} reports
            it (marked in the table).
          </>
        )}
        {notJudged > 0 && (
          <>
            {" "}
            A batch marked "unknown parent" builds on a state this replay did not reach, and one marked "entries missing" covers entries past those read; neither
            is counted as reproduced or as wrong.
          </>
        )}
        {r.seed && <Seeded seed={r.seed} />}
        {info.archived > 0 && <> Entries 1 to {info.archived} came from the repository's inbox archive, used because the chain's inbox accumulator confirms them.</>}
      </p>

      <div className="rp-figs">
        <p>
          <span className="rp-n">{r.entries}</span>
          <span className="rp-k">inbox entries re-read</span>
        </p>
        <p>
          <span className="rp-n">{r.rows.length}</span>
          <span className="rp-k">submissions judged</span>
        </p>
        <p>
          <span className="rp-n">{r.ms.toLocaleString()} ms</span>
          <span className="rp-k">re-executing, in a worker</span>
        </p>
        <p>
          <span className="rp-n">{(info.readMs / 1000).toFixed(1)} s</span>
          <span className="rp-k">reading the node</span>
        </p>
      </div>

      {rolledBack.length > 0 && (
        <div className="rp-caught">
          <h3>Rolled back on chain{allCaught ? ", and caught again here" : ""}</h3>
          <ul className="checks">
            {rolledBack.map((b) => (
              <Caught key={b.key} b={b} />
            ))}
          </ul>
          <p className="note">
            {rolledBack.every((b) => b.sequencer && KNOWN[b.sequencer]?.includes("fraud drill")) && (
              <>These came from our own fraud drills (THREAT_MODEL §7), a small sample. </>
            )}
            The chain dropped each wrong batch and the next batch took its index, so verdicts here are keyed by every field a batch published, never by its
            index.
          </p>
        </div>
      )}
      {!r.submissionsRead && (
        <p className="note">
          The node's transaction search for batch submissions failed{info.submissionsError ? ` (${info.submissionsError})` : ""}, so only the batches it still
          lists were judged; batches the chain rolled back or pruned are not shown.
        </p>
      )}

      <div className="cols rp-cols">
        <div>
          <details className="paste rp-all">
            <summary>
              Every submission, in chain order ({r.rows.length})
            </summary>
            <Table rows={r.rows} />
          </details>
          <p className="rp-again">
            <button type="button" onClick={again} disabled={cooling} aria-describedby={cooling ? "rp-cool" : undefined}>
              Read and re-execute again
            </button>
            {cooling && (
              <span id="rp-cool" className="note">
                {" "}
                Available {COOLDOWN_MS / 1000} s after a run, to spare the public node.
              </span>
            )}
          </p>
        </div>
        <aside>
          <SolvencyPanel r={r} />
          <LookupPanel r={r} worker={worker} />
          <ForgePanel r={r} worker={worker} />
        </aside>
      </div>
      <p className="note rp-trust">
        What runs here: the inbox accumulator, every ML-DSA-44 signature inside execution, the state and withdrawals roots, the data hashes, the fraud
        proofs and the chain's rule for deciding them (the RDK's <code>checkQledgerFraud</code>), through the same check our hosted watchtowers use (
        <code>packages/qledger-watchtower/src/check.ts</code>). What it trusts: the batch list, anchors, inbox entries, deposit pool and payments are as{" "}
        {NODE_HOST} reports them, without proofs. An anchor's ML-DSA-87 signature is not checked in this panel; it can be checked on the Verify page.
      </p>
    </div>
  );
}

/** The state before the first kept batch, rebuilt from entries alone because the earlier records are pruned and their submissions were not read. */
function Seeded({ seed: s }: { seed: NonNullable<ReplayResult["seed"]> }) {
  const last = s.batchIndex - 1;
  return (
    <>
      {" "}
      The chain no longer lists batch{last === 0 ? " 0" : `es 0 to ${last}`} and their submissions were not read, so they were not judged one by one.
      Instead, inbox entries 1 to {s.entries} were re-executed from the empty ledger, and the state they give {s.matches ? "has" : "does not have"} the
      parent root batch #{s.batchIndex} published
      {s.anchor === "matches" && <>, and batch #{last}'s ML-DSA-87 anchor names it, as {NODE_HOST} reports</>}
      {s.anchor === "other root" && <>, and batch #{last}'s ML-DSA-87 anchor names another root, as {NODE_HOST} reports</>}
      {s.anchor === "none" && <>; batch #{last} has no ML-DSA-87 anchor to compare</>}.
    </>
  );
}

function Caught({ b }: { b: BatchRow }) {
  const [tone, label]: [Tone, string] =
    b.verdict === "differs"
      ? [b.challenge?.wins ? "ok" : "bad", "caught"]
      : b.verdict === "reproduced"
        ? ["skip", "honest"]
        : b.verdict === "descends from a wrong batch"
          ? ["skip", "dropped with it"]
          : ["skip", "not judged"];
  return (
    <li>
      <Mark tone={tone} label={label} />
      <span>
        <span className="what">
          Batch #{b.batchIndex}, block {b.height?.toLocaleString() ?? "?"}
          {b.sequencer && (
            <>
              {" "}
              from <Who addr={b.sequencer} />
            </>
          )}
          :{" "}
          {b.verdict === "differs"
            ? `its ${fields(b.mismatches)} ${b.mismatches.length === 1 ? "disagrees" : "disagree"}`
            : b.verdict === "reproduced"
              ? "re-execution agrees with it; the chain drops every later batch not yet final after a wrong one"
              : b.verdict === "descends from a wrong batch"
                ? "it built on a wrong batch's state root; the chain drops every later batch not yet final after a wrong one"
                : b.verdict}
        </span>
        <br />
        <span className="why">
          {b.verdict === "differs" && b.honest && b.mismatches.includes("stateRoot") && (
            <>
              It published <code>{short(b.published.stateRoot, 8)}</code>; re-execution gives <code>{short(b.honest.stateRoot, 8)}</code>.{" "}
            </>
          )}
          {b.challenge && (
            <>
              A fraud proof built here ({b.challenge.proofBytes} bytes) {b.challenge.wins ? "wins" : "would not win"} by the chain's rule, as the RDK's{" "}
              <code>checkQledgerFraud</code> runs it.{" "}
            </>
          )}
          {b.fraud && (
            <>
              The chain upheld a challenge from <Who addr={b.fraud.challenger} /> at block {b.fraud.height.toLocaleString()} (<Ext href={txUrl(b.fraud.tx)}>tx</Ext>).
            </>
          )}
          {b.tx && (
            <>
              {" "}
              <Ext href={txUrl(b.tx)}>Its submission tx</Ext>.
            </>
          )}
        </span>
      </span>
    </li>
  );
}

function Verdict({ b }: { b: BatchRow }) {
  if (b.verdict === "reproduced") return <span className="chip ok">matches</span>;
  if (b.verdict === "differs") return <span className="chip bad">differs: {fields(b.mismatches)}</span>;
  return <span className="chip warn">{b.verdict}</span>;
}

function Table({ rows }: { rows: BatchRow[] }) {
  return (
    <div className="table-wrap">
      <table className="log-table rp-table">
        <thead>
          <tr>
            <th className="num">#</th>
            <th>Inbox</th>
            <th>On chain</th>
            <th>Re-executed here</th>
            <th>Anchor</th>
            <th>From</th>
            <th className="num">Block</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.key} className={b.where === "rolled back" ? "rp-rb" : undefined}>
              <td className="num idx">{b.batchIndex}</td>
              <td>{b.inboxEnd - b.inboxStart === 1 ? b.inboxEnd : b.inboxEnd > b.inboxStart ? `${b.inboxStart + 1}–${b.inboxEnd}` : "—"}</td>
              <td>
                <span className={`st ${b.where === "rolled back" ? "rejected" : b.status}`}>{b.where === "kept" ? b.status : b.where}</span>
              </td>
              <td>
                <Verdict b={b} />
              </td>
              <td>
                {!b.anchor ? (
                  <span className="anc open">none</span>
                ) : b.anchor.matches ? (
                  <span
                    className="anc lit"
                    title={`The ML-DSA-87 anchor recorded at this layer height in the same block names ${b.anchor.stateRoot}, the root re-executed here, as ${NODE_HOST} reports; check its signature on the Verify page`}
                  >
                    matches
                  </span>
                ) : (
                  <span
                    className="chip bad"
                    title={`The ML-DSA-87 anchor recorded at this layer height in the same block names ${b.anchor.stateRoot}, not the root re-executed here, as ${NODE_HOST} reports`}
                  >
                    other root
                  </span>
                )}
              </td>
              <td>
                <Who addr={b.sequencer} />
              </td>
              <td className="num">{b.tx ? <Ext href={txUrl(b.tx)}>{b.height?.toLocaleString()}</Ext> : (b.height?.toLocaleString() ?? "—")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SolvencyPanel({ r }: { r: ReplayResult }) {
  const s = r.solvency;
  return (
    <section className="panel" aria-labelledby="rp-solv">
      <h2 id="rp-solv">
        Solvency <small>owed, computed here</small>
      </h2>
      {!s ? (
        <p className="empty">Not computed: the latest batch did not reproduce, so there is no honest state to count.</p>
      ) : (
        <>
          <p className="rp-owe">
            L2 owes <strong>{qor(s.owed)}</strong>; the deposit pool holds <strong>{qor(s.pool)}</strong>.
          </p>
          <p>
            {BigInt(s.surplus) === 0n ? (
              <span className="chip ok">covered exactly</span>
            ) : BigInt(s.surplus) > 0n ? (
              <span className="chip ok">covered, {qor(s.surplus)} over</span>
            ) : (
              <span className="chip bad">short by {qor(-BigInt(s.surplus))}</span>
            )}
          </p>
          <dl className="kv">
            <dt>Balances</dt>
            <dd>
              {qor(s.balances)} across {s.accounts} account{s.accounts === 1 ? "" : "s"}
            </dd>
            <dt>Not yet paid</dt>
            <dd>
              {qor(s.unpaid)} in {s.unpaidList.length} withdrawal{s.unpaidList.length === 1 ? "" : "s"}
            </dd>
            <dt>Paid on L1</dt>
            <dd>
              {s.paidWithdrawals} withdrawal{s.paidWithdrawals === 1 ? "" : "s"}, each matched by batch, index, recipient and amount
            </dd>
            <dt>Not batched yet</dt>
            <dd>
              {s.pendingEntries} entr{s.pendingEntries === 1 ? "y" : "ies"}, executed here as the next batch would
            </dd>
          </dl>
          <p className="note" style={{ marginTop: 10 }}>
            Owed is every L2 balance after the last entry plus every withdrawal not yet paid on L1. The pool is the rollup's <code>deposit_pool</code> (deposits
            not yet withdrawn) as {NODE_HOST} reports it, read after the inbox, with payments read after the pool, so a deposit or payment landing during the
            read can only show as a surplus.
          </p>
        </>
      )}
    </section>
  );
}

function LookupPanel({ r, worker }: { r: ReplayResult; worker: RefObject<ReplayWorker | undefined> }) {
  const [id, setId] = useState(r.accounts[0]?.id ?? "");
  const [got, setGot] = useState<Lookup>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    setGot(undefined);
    setBusy(true);
    try {
      const w = worker.current;
      if (!w) throw new Error("the worker has stopped; run the re-execution again");
      setGot(await w.lookup(id));
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };
  if (!r.lookupRoot) return null;
  return (
    <section className="panel" aria-labelledby="rp-look">
      <h2 id="rp-look">
        Look up an account <small>batch #{r.lookupRoot.batchIndex}</small>
      </h2>
      <form className="rp-form" onSubmit={(e) => void submit(e)}>
        <label htmlFor="rp-pick">Accounts after batch #{r.lookupRoot.batchIndex}</label>
        <select id="rp-pick" value={r.accounts.some((a) => a.id === id) ? id : ""} onChange={(e) => e.target.value && setId(e.target.value)}>
          <option value="">Choose one, or paste an id below</option>
          {r.accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {short(a.id, 6)} · {qor(a.balance)}
            </option>
          ))}
        </select>
        <label htmlFor="rp-id">L2 account id (64 hex digits)</label>
        <div className="row">
          <input id="rp-id" type="text" value={id} onChange={(e) => setId(e.target.value)} spellCheck={false} autoComplete="off" />
          <button type="submit" disabled={busy || !id.trim()}>
            Open
          </button>
        </div>
      </form>
      {error && <p className="err">{error}</p>}
      {got && (
        <ul className="checks" aria-live="polite">
          <li>
            <Mark tone="ok" />
            <span>
              <span className="what">
                Balance {qor(got.balance)}, nonce {got.nonce}
              </span>
              <br />
              <span className="why">
                Opened with a witness ({got.siblings} non-empty sibling{got.siblings === 1 ? "" : "s"} on a 256-level path) that hashes to{" "}
                <code>{short(got.root, 8)}</code>, the state root of batch #{got.batchIndex}, which its ML-DSA-87 anchor names, as {NODE_HOST} reports it.{" "}
                <a className="go" href={`#/verify?batch=${got.batchIndex}`}>
                  Verify that anchor's signature
                </a>
              </span>
            </span>
          </li>
        </ul>
      )}
    </section>
  );
}

function ForgePanel({ r, worker }: { r: ReplayResult; worker: RefObject<ReplayWorker | undefined> }) {
  const options = useMemo(
    () =>
      r.rows
        .filter((b) => b.where === "kept" && b.verdict === "reproduced")
        .flatMap((b) => b.transfers.map((t) => ({ value: `${b.key}|${t.sequence}`, b, t }))),
    [r],
  );
  const [pick, setPick] = useState(options[0]?.value ?? "");
  const chosen = options.find((o) => o.value === pick);
  const [amount, setAmount] = useState("");
  const [got, setGot] = useState<ForgeAnswer>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // Default to the sender's whole balance: a sequencer moving more than its user signed for.
    if (chosen) setAmount(toQorText(chosen.t.max !== chosen.t.amount ? chosen.t.max : String(BigInt(chosen.t.amount) - 1n)));
    setGot(undefined);
    setError(undefined);
  }, [pick]); // eslint-disable-line react-hooks/exhaustive-deps

  if (options.length === 0) return null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    setGot(undefined);
    setCopied(false);
    const uqor = parseQor(amount);
    if (!chosen) return;
    if (uqor === undefined) {
      setError("Give an amount in QOR, with at most six decimals.");
      return;
    }
    if (uqor > BigInt(chosen.t.max)) {
      setError(`The sender held ${qor(chosen.t.max)} before this transfer; a forged amount above that cannot be written to the ledger.`);
      return;
    }
    setBusy(true);
    try {
      const w = worker.current;
      if (!w) throw new Error("the worker has stopped; run the re-execution again");
      setGot(await w.forge(chosen.b.key, chosen.t.sequence, uqor));
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };
  const shown = got ? got.command.replace(got.proofHex, `${got.proofHex.slice(0, 40)}…${got.proofHex.slice(-12)}`) : "";
  return (
    <section className="panel" aria-labelledby="rp-forge">
      <h2 id="rp-forge">
        Forge a batch <small>in this page only</small>
      </h2>
      <p className="note">
        Give one transfer another amount, as a dishonest sequencer might, and see what a watchtower does with it. Nothing is signed or sent.
      </p>
      <form className="rp-form" onSubmit={(e) => void submit(e)}>
        <label htmlFor="rp-tx">Transfer</label>
        <select id="rp-tx" value={pick} onChange={(e) => setPick(e.target.value)}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              Batch #{o.b.batchIndex}, entry {o.t.sequence}: {qor(o.t.amount)}
            </option>
          ))}
        </select>
        {chosen && (
          <p className="note">
            Signed with ML-DSA-44 for {qor(chosen.t.amount)} from <code>{short(chosen.t.from, 6)}</code> to <code>{short(chosen.t.to, 6)}</code>; the sender held{" "}
            {qor(chosen.t.max)}.
          </p>
        )}
        <label htmlFor="rp-amt">Forged amount (QOR)</label>
        <div className="row">
          <input id="rp-amt" type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoComplete="off" />
          <button type="submit" className="forge" disabled={busy || !chosen}>
            Forge it
          </button>
        </div>
      </form>
      {error && <p className="err">{error}</p>}
      {got && (
        <div aria-live="polite">
          <ul className="checks">
            <li>
              <Mark tone="bad" label="diverges" />
              <span>
                <span className="what">The forged state root diverges</span>
                <br />
                <span className="why">
                  With {qor(got.forgedAmount)} instead of {qor(got.realAmount)}, batch #{got.batchIndex} would publish <code>{short(got.forgedRoot, 8)}</code>;
                  re-execution gives <code>{short(got.honestRoot, 8)}</code>, the root the chain holds.
                </span>
              </span>
            </li>
            <li>
              <Mark tone={got.wins ? "ok" : "bad"} label={got.wins ? "upheld" : "refused"} />
              <span>
                <span className="what">
                  Fraud proof built here, {(got.proofHex.length / 2).toLocaleString()} bytes: the chain's rule {got.wins ? "upholds" : "refuses"} it against the forgery
                </span>
                <br />
                <span className="why">
                  Built with the RDK's <code>buildQledgerFraudProof</code> from the honest parent state, and decided with the RDK's{" "}
                  <code>checkQledgerFraud</code>, its implementation of the rule the chain applies to a challenge.
                </span>
              </span>
            </li>
            <li>
              <Mark tone={got.winsAgainstReal ? "bad" : "ok"} label={got.winsAgainstReal ? "upheld" : "refused"} />
              <span>
                <span className="what">Against batch #{got.batchIndex} as the chain holds it, the same rule {got.winsAgainstReal ? "upholds" : "refuses"} it</span>
                <br />
                <span className="why">
                  {got.winsAgainstReal
                    ? "Re-execution reproduced that batch, yet the rule upholds the proof against it: this needs a closer look."
                    : "Re-execution reproduces that batch, so a challenge against it cannot win."}
                </span>
              </span>
            </li>
          </ul>
          <p className="note rp-cmd-h">
            The challenge our watchtower would build if batch #{got.batchIndex} on chain were this forgery, printed here and never run. Its gas (
            {got.gas.toLocaleString()}) and fee ({qor(got.feeUqor)}) are our watchtower's estimate for a challenge (<code>Challenger.gasFor</code>: 500,000 plus 40
            per proof byte plus 100,000 per entry, at 0.3 uqor per unit of gas).
          </p>
          <pre className="rp-cmd">
            <code>{shown}</code>
          </pre>
          <div className="row">
            <button
              type="button"
              onClick={() =>
                void navigator.clipboard?.writeText(got.command).then(
                  () => setCopied(true),
                  () => undefined,
                )
              }
            >
              {copied ? "Copied" : "Copy the full command"}
            </button>
          </div>
          <p className="note" style={{ marginTop: 8 }}>
            This page holds no key and has no code that sends a transaction. <code>--generate-only</code> writes an unsigned file, and the ML-DSA-87
            co-signing step is printed as a comment only.
            {!got.winsAgainstReal && (
              <>
                {" "}
                <code>checkQledgerFraud</code> refuses this proof against batch #{got.batchIndex} as the chain holds it
                {chosen?.b.batchIndex === got.batchIndex && chosen.b.status === "finalized" ? (
                  <>
                    ; on {CHAIN_ID} that batch is also final, as {NODE_HOST} reports, and the chain refuses a challenge to a batch that is no longer open before it
                    judges the proof (EVIDENCE 45: code 9).
                  </>
                ) : (
                  "."
                )}
              </>
            )}
          </p>
        </div>
      )}
    </section>
  );
}
