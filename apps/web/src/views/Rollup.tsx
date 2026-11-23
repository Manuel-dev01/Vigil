import { useCallback, useEffect, useState } from "react";
import type { AnchorView, BatchView, InboxView, RollupView as Rollup } from "@qorechain/rdk";
import { KNOWN, ROLLUP, chain, qor, short, shortAddr, txUrl } from "../chain.ts";
import { listen, type Head, type LiveItem } from "../live.ts";

interface Fraud {
  height: number;
  tx: string;
  time: string;
  batchIndex: number;
  challenger: string;
  submitter: string;
  slashed: string;
  reward: string;
}

/** A batch the chain still keeps, or one it has pruned that is known from its surviving anchor. */
interface Row {
  key: string;
  batchIndex: number;
  status: BatchView["status"] | "pruned";
  stateRoot: string;
  batch?: BatchView;
  anchored: boolean;
  /** The block the batch was submitted at (for a pruned batch, its anchor's block: the same transaction). */
  block: number;
}

interface State {
  rollup: Rollup;
  inbox: InboxView;
  batches: BatchView[];
  rows: Row[];
  pruned: number;
  latestIndex: number;
  bond: string;
  frauds: Fraud[];
  loadedAt: number;
}

const attrs = (ev: { attributes?: { key: string; value: string }[] }): Record<string, string> =>
  Object.fromEntries((ev.attributes ?? []).map((a) => [a.key, a.value]));

async function load(): Promise<State> {
  const { rdk } = await chain();
  const rest = rdk.rest;
  const rollup = await rest.getRollup(ROLLUP);
  const [inbox, batches, anchors, bond, fraudTxs] = await Promise.all([
    rest.getInbox(ROLLUP),
    rest.listBatches(ROLLUP),
    rest.getAnchors(rollup.layerId).catch(() => [] as AnchorView[]),
    rest.getSubmitterBond(ROLLUP, rollup.creator).catch(() => ({ amount: "0" })),
    rest.searchTxs(`rdk_fraud_upheld.rollup_id='${ROLLUP}'`).catch(() => [] as Record<string, unknown>[]),
  ]);
  const frauds: Fraud[] = [];
  for (const t of fraudTxs as { height?: string; txhash?: string; timestamp?: string; events?: { type: string; attributes?: { key: string; value: string }[] }[] }[]) {
    for (const ev of t.events ?? []) {
      if (ev.type !== "rdk_fraud_upheld") continue;
      const a = attrs(ev);
      if (a["rollup_id"] !== ROLLUP) continue;
      frauds.push({
        height: Number(t.height ?? 0),
        tx: t.txhash ?? "",
        time: t.timestamp ?? "",
        batchIndex: Number(a["batch_index"] ?? 0),
        challenger: a["challenger"] ?? "",
        submitter: a["submitter"] ?? "",
        slashed: a["slashed"] ?? "0",
        reward: a["challenger_reward"] ?? "0",
      });
    }
  }
  // An anchor belongs to the batch whose index is its layer height (several batches can share a root).
  const anchored = new Set(anchors.map((a) => `${a.layerHeight}:${a.stateRoot.toLowerCase()}`));
  const kept = new Set(batches.map((b) => b.batchIndex));
  const latestIndex = Math.max(-1, ...batches.map((b) => b.batchIndex));
  // The chain deletes finalized batch records after a retention window; their anchors stay.
  const gone = anchors.filter((a) => !kept.has(a.layerHeight) && a.layerHeight < latestIndex);
  const rows: Row[] = [
    ...batches.map((b) => ({
      key: `${b.batchIndex}:${b.stateRoot}`,
      batchIndex: b.batchIndex,
      status: b.status,
      stateRoot: b.stateRoot,
      batch: b,
      anchored: anchored.has(`${b.batchIndex}:${b.stateRoot.toLowerCase()}`),
      block: b.submittedAt,
    })),
    ...gone.map((a) => ({ key: `pruned:${a.layerHeight}`, batchIndex: a.layerHeight, status: "pruned" as const, stateRoot: a.stateRoot, anchored: true, block: a.mainChainHeight })),
  ].sort((a, b) => b.batchIndex - a.batchIndex || b.block - a.block);
  return {
    rollup,
    inbox,
    batches,
    rows,
    pruned: gone.length,
    latestIndex,
    bond: bond.amount,
    frauds: frauds.sort((a, b) => b.height - a.height),
    loadedAt: Date.now(),
  };
}

function Name({ addr }: { addr: string }) {
  const known = KNOWN[addr];
  return (
    <span title={addr}>
      {known ? <strong>{known}</strong> : <span className="mono">{shortAddr(addr)}</span>}
    </span>
  );
}

function finalizesIn(b: BatchView, windowSec: number | undefined, now: number): string {
  if (b.status !== "submitted" || !windowSec || !b.submittedTime) return "";
  const left = b.submittedTime + windowSec - Math.floor(now / 1000);
  if (left <= 0) return "due now";
  const m = Math.floor(left / 60);
  return `final in ${m >= 1 ? `${m} min` : `${left} s`}`;
}

function FeedItem({ item }: { item: LiveItem }) {
  const when = new Date(item.at).toLocaleTimeString();
  if (item.kind === "post")
    return (
      <li>
        <span>
          Inbox entry <strong>#{item.sequence}</strong> posted ({item.size} B) by <Name addr={item.poster} />
        </span>
        <span className="when">
          {when} · block {item.height.toLocaleString()} · <a href={txUrl(item.tx)}>tx</a>
        </span>
      </li>
    );
  if (item.kind === "batch")
    return (
      <li>
        <span>
          Batch <strong>#{item.batchIndex}</strong> settled to inbox {item.inboxEnd}, root <code>{short(item.stateRoot, 6)}</code>{" "}
          {item.pqcVerified ? <span className="chip ok">ML-DSA-87 anchor verified</span> : <span className="chip warn">not anchored</span>}
        </span>
        <span className="when">
          {when} · block {item.height.toLocaleString()} · <a href={txUrl(item.tx)}>tx</a>
        </span>
      </li>
    );
  return (
    <li>
      <span>
        <span className="chip bad">Fraud caught</span> batch <strong>#{item.batchIndex}</strong> rejected; challenger <Name addr={item.challenger} /> paid {qor(item.reward)}
      </span>
      <span className="when">
        {when} · block {item.height.toLocaleString()} · <a href={txUrl(item.tx)}>tx</a>
      </span>
    </li>
  );
}

export function RollupView() {
  const [state, setState] = useState<State>();
  const [error, setError] = useState<string>();
  const [head, setHead] = useState<Head>();
  const [items, setItems] = useState<LiveItem[]>([]);
  const [now, setNow] = useState(Date.now());

  const refresh = useCallback(() => {
    load()
      .then((s) => {
        setState(s);
        setError(undefined);
      })
      .catch((e: unknown) => setError(String(e instanceof Error ? e.message : e)));
  }, []);

  useEffect(() => {
    refresh();
    const l = listen({
      onHead: setHead,
      onItem: (i) => {
        setItems((xs) => [i, ...xs].slice(0, 30));
        refresh();
      },
    });
    setItems(l.recent);
    if (l.head) setHead(l.head);
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => {
      l.stop();
      clearInterval(t);
    };
  }, [refresh]);

  if (error && !state) return <p className="err">Could not read the chain: {error}</p>;
  if (!state) return <p className="empty">Reading {ROLLUP} from the chain…</p>;
  const { rollup, inbox, batches, rows, pruned, latestIndex, bond, frauds } = state;
  const pending = batches.filter((b) => b.status === "submitted").length;

  return (
    <>
      <h1>{ROLLUP}</h1>
      <p className="lede">
        A payroll rollup with no admin and no classical authority. Users sign with ML-DSA-44, the creator's sequencer anchors each batch with its ML-DSA-87
        signature (a bonded standby sequencer takes over, unanchored, if it stops), payslips are sealed with ML-KEM-1024, and independent watchtowers re-execute every batch and challenge fraud on chain.
      </p>

      <div className="grid">
        <div className="stat">
          <div className="k">Status</div>
          <div className="v">{rollup.status}</div>
          <div className="s">
            {rollup.sequencing || "sequencer"} · {rollup.executionVm || rollup.vmType} · {rollup.proofSystem ?? "fraud"} proofs
          </div>
        </div>
        <div className="stat">
          <div className="k">Chain height</div>
          <div className="v">{head ? head.height.toLocaleString() : "…"}</div>
          <div className="s">{head ? `live, ${new Date(head.time).toLocaleTimeString()}` : "waiting for the next block"}</div>
        </div>
        <div className="stat">
          <div className="k">Batches</div>
          <div className="v">{latestIndex + 1}</div>
          <div className="s">
            {pending ? `${pending} in the challenge window` : "all final"}
            {pruned ? ` · ${pruned} pruned, anchors kept` : ""}
          </div>
        </div>
        <div className="stat">
          <div className="k">Inbox</div>
          <div className="v">{inbox.headSequence}</div>
          <div className="s">entries posted · {inbox.consumedSequence} settled</div>
        </div>
        <div className="stat">
          <div className="k">Withdrawal pool</div>
          <div className="v">{qor(rollup.escrowBalance)}</div>
          <div className="s">held by the chain, paid only from final batches</div>
        </div>
        <div className="stat">
          <div className="k">Sequencer bond</div>
          <div className="v">{qor(bond)}</div>
          <div className="s">slashed if a batch is proven wrong</div>
        </div>
      </div>

      <div className="cols">
        <div>
          <section className="panel">
            <h2>
              Batches <small>challenge window {rollup.challengeWindowSec ? `${Math.round(rollup.challengeWindowSec / 60)} min` : "n/a"}</small>
            </h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th className="num">#</th>
                    <th>Status</th>
                    <th>State root</th>
                    <th>Inbox</th>
                    <th>Anchor</th>
                    <th className="num">Block</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ key, batchIndex, status, stateRoot, batch: b, anchored, block }) => (
                    <tr key={key}>
                      <td className="num">{batchIndex}</td>
                      <td>
                        <span
                          className={`chip ${status}`}
                          title={status === "pruned" ? "The chain deleted this finalized batch's record after its retention window. Its anchor remains, so its receipt still verifies." : undefined}
                        >
                          {status}
                        </span>{" "}
                        {b && <span className="note">{finalizesIn(b, rollup.challengeWindowSec, now)}</span>}
                      </td>
                      <td>
                        <code title={stateRoot}>{short(stateRoot, 6)}</code>
                      </td>
                      <td>{!b ? "—" : b.inboxEnd - b.inboxStart === 1 ? b.inboxEnd : b.inboxEnd > b.inboxStart ? `${b.inboxStart + 1}–${b.inboxEnd}` : "—"}</td>
                      <td>{anchored ? <span className="chip ok">ML-DSA-87</span> : <span className="chip warn">none</span>}</td>
                      <td className="num">{block.toLocaleString()}</td>
                      <td>
                        {anchored ? (
                          <a href={`#/verify?batch=${batchIndex}`}>Verify receipt</a>
                        ) : (
                          <span className="note" title="Only batches from the creator's sequencer carry an ML-DSA-87 anchor. This one came from the standby or another bonded submitter, so it has no settlement receipt.">
                            no receipt
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel">
            <h2>
              Fraud caught on chain <small>{frauds.length} upheld challenge{frauds.length === 1 ? "" : "s"}</small>
            </h2>
            {frauds.length === 0 ? (
              <p className="empty">No fraud challenge has been upheld on this rollup.</p>
            ) : (
              <ul className="feed">
                {frauds.map((f) => (
                  <li key={f.tx}>
                    <span>
                      Batch <strong>#{f.batchIndex}</strong> by <Name addr={f.submitter} /> was proven wrong. {qor(f.slashed)} bond slashed; {qor(f.reward)} paid to{" "}
                      <Name addr={f.challenger} />.
                    </span>
                    <span className="when">
                      {f.time ? new Date(f.time).toUTCString() : ""} · block {f.height.toLocaleString()} · <a href={txUrl(f.tx)}>challenge tx</a>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <aside>
          <section className="panel">
            <h2>
              Live <small>new posts, batches and fraud, as they happen</small>
            </h2>
            {items.length === 0 ? (
              <p className="empty">Listening to the chain. Nothing new since this page opened.</p>
            ) : (
              <ul className="feed">
                {items.map((i) => (
                  <FeedItem key={`${i.kind}:${i.tx}:${i.height}`} item={i} />
                ))}
              </ul>
            )}
          </section>
          <section className="panel">
            <h2>Who runs what</h2>
            <dl className="kv">
              <dt>Creator</dt>
              <dd>
                <Name addr={rollup.creator} />
              </dd>
              <dt>Layer</dt>
              <dd>
                <code>{rollup.layerId}</code>, created at block {rollup.createdHeight.toLocaleString()}
              </dd>
              <dt>Sequencers</dt>
              <dd>
                Keel, run by the creator, batches within seconds and anchors each batch. A standby Keel with its own bonded key batches
                any entry that has waited 30 blocks; anyone else who bonds may do the same.
              </dd>
              <dt>Watchtowers</dt>
              <dd>
                Two of ours (US West and EU West) plus anyone else's. Any bonded account can challenge, and the chain pays the first correct challenger.
              </dd>
            </dl>
          </section>
        </aside>
      </div>
    </>
  );
}
