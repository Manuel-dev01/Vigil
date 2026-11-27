import { Suspense, lazy, useEffect, useState } from "react";
import type { AnchorView, BatchView, InboxView, RollupView as Rollup } from "@qorechain/rdk";
import { chain } from "../chain.ts";
import { CHAIN_ID, KNOWN, NODE_HOST, REPO, ROLLUP, qor, short, shortAddr, txUrl, utcStamp, utcTime } from "../config.ts";
import { listen, type Head, type LiveItem } from "../live.ts";
import { reveal } from "../reveal.ts";
import { ErrorBoundary, Ext, ExplorerHint, useRefresh } from "../ui.tsx";
import { BeaconLine } from "./Beacons.tsx";
import { PageHead, Reading, Section, type Sounding } from "./Head.tsx";

const REFRESH_MS = 30_000;

// The browser watchtower and its worker load only when the visitor asks for them.
const ReplayPanel = lazy(() => import("./Replay.tsx").then((m) => ({ default: m.ReplayPanel })));

interface Fraud {
  height: number;
  tx: string;
  time: string;
  batchIndex: number;
  /** The batch the chain now keeps at this index, when it was submitted after the fraud proof (the index was reused). */
  reusedBy?: { block: number; status: string };
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
  // A rejected batch's index is reused: the next batch submitted takes the same number.
  for (const f of frauds) {
    const now = batches.find((b) => b.batchIndex === f.batchIndex);
    if (now && now.submittedAt > f.height) f.reusedBy = { block: now.submittedAt, status: now.status };
  }
  // An anchor belongs to the batch whose index is its layer height (several batches can share a root).
  const anchored = new Set(anchors.map((a) => `${a.layerHeight}:${a.stateRoot.toLowerCase()}`));
  const kept = new Set(batches.map((b) => b.batchIndex));
  const latestIndex = Math.max(-1, ...batches.map((b) => b.batchIndex));
  // The chain may delete finalized batch records after a retention window; their anchors stay.
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

const hms = (ms: number): string => utcTime(ms).replace(" UTC", "");

function FeedItem({ item }: { item: LiveItem }) {
  const t = (
    <time className="lg-t" dateTime={new Date(item.at).toISOString()}>
      {hms(item.at)}
    </time>
  );
  const where = (
    <span className="when">
      block {item.height.toLocaleString()} · <Ext href={txUrl(item.tx)}>tx</Ext>
    </span>
  );
  if (item.kind === "post")
    return (
      <li>
        {t}
        <span>
          Inbox entry <strong>#{item.sequence}</strong> posted ({item.size} B) by <Name addr={item.poster} />
          {where}
        </span>
      </li>
    );
  if (item.kind === "batch")
    return (
      <li className="lit">
        {t}
        <span>
          Batch <strong>#{item.batchIndex}</strong> settled to inbox {item.inboxEnd}, root <code>{short(item.stateRoot, 6)}</code>{" "}
          {item.pqcVerified ? (
            <span className="chip ok" title="The node's event says the chain verified the batch's ML-DSA-87 anchor. Verify its receipt to check the signature in this browser.">
              chain reports anchor verified
            </span>
          ) : (
            <span className="chip warn">not anchored</span>
          )}
          {where}
        </span>
      </li>
    );
  return (
    <li className="bad">
      {t}
      <span>
        <span className="chip bad">Fraud caught</span> batch <strong>#{item.batchIndex}</strong> rejected; challenger <Name addr={item.challenger} /> paid {qor(item.reward)}
        {where}
      </span>
    </li>
  );
}

const COUNT = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];

/** Your browser as a watchtower: re-execute every batch here, on request (Replay.tsx). */
function BrowserWatchtower() {
  const [on, setOn] = useState(false);
  // Inline spacing keeps the first paint's stylesheet as it was; the panel's own styles load with it.
  return (
    <div style={{ marginTop: "var(--s7)" }}>
      <Section title="Re-execute it in this browser" aside="your browser as a watchtower" id="replay">
        <p style={{ maxWidth: "72ch" }}>
          Do what our hosted watchtowers do, here: read every inbox entry and every batch submission from {NODE_HOST}, re-execute each batch with the RDK's
          qledger-v1 executor and our watchtower's check, and compare it with the batch list and anchors as {NODE_HOST} reports them. Then check what the
          rollup owes against its deposit pool, open any account against an anchored root, and forge a batch to watch a fraud proof win. It runs in a Web
          Worker. Nothing is signed or sent.
        </p>
        {on ? (
          // Its own boundary: a chunk that fails to load (say, a stale file after a redeploy) or a render
          // error in the panel stops only this section, not the whole Rollup page.
          <ErrorBoundary resetKey="replay">
            <Suspense fallback={<Reading>Loading the re-execution code…</Reading>}>
              <ReplayPanel />
            </Suspense>
          </ErrorBoundary>
        ) : (
          <button type="button" className="primary" onClick={() => setOn(true)}>
            Re-execute every batch here
          </button>
        )}
      </Section>
    </div>
  );
}

export function RollupView() {
  // Read every 30 s while the tab is visible, after a reconnect and on each live post or batch; one load at a time.
  const { data: state, error, refreshing, refresh } = useRefresh(load, REFRESH_MS);
  const [head, setHead] = useState<Head>();
  const [items, setItems] = useState<LiveItem[]>([]);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
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

  const rollup = state?.rollup;
  const pending = state ? state.batches.filter((b) => b.status === "submitted").length : 0;
  const soundings: Sounding[] = [
    { k: "Chain height", v: head ? head.height.toLocaleString() : undefined, live: true, s: head ? `live · block time ${utcTime(Date.parse(head.time))}` : "waiting for the next block" },
    {
      k: "Status",
      v: rollup?.status,
      tone: rollup?.status === "active" ? "ok" : undefined,
      s: rollup ? `${rollup.sequencing || "sequencer"} · ${rollup.executionVm || rollup.vmType} · ${rollup.proofSystem ?? "fraud"} proofs` : undefined,
    },
    {
      k: "Batches",
      v: state ? state.latestIndex + 1 : undefined,
      s: state ? `${pending ? `${pending} in the challenge window` : "all final"}${state.pruned ? ` · ${state.pruned} pruned, anchors kept` : ""}` : undefined,
    },
    { k: "Inbox", v: state?.inbox.headSequence, s: state ? `entries posted · ${state.inbox.consumedSequence} settled` : undefined },
    { k: "Deposit pool", v: rollup ? qor(rollup.depositPool) : undefined, s: "deposited, not yet withdrawn; withdrawals are paid from it, only from final batches" },
    { k: "Creator's stake", v: rollup ? qor(rollup.escrowBalance) : undefined, s: "staked when the rollup was created, held in escrow by the chain" },
    { k: "Sequencer bond", v: state ? qor(state.bond) : undefined, s: "slashed if a batch is proven wrong" },
  ];

  return (
    <>
      <PageHead
        eyebrow={<>The rollup · live from {CHAIN_ID}</>}
        title={ROLLUP}
        lede={
          <>
            <p>
              A payroll rollup whose contracts have no owner or admin key, and where no step that moves value rests on a classical signature alone. The
              classical keys that remain, such as the one that signs each account's first post-quantum key registration, are listed in the{" "}
              <Ext href={`${REPO}/blob/main/THREAT_MODEL.md#9-quantum-notes`}>threat model</Ext>.
            </p>
            <p>
              Users sign with ML-DSA-44, the creator's sequencer anchors each batch with its ML-DSA-87 signature (a bonded standby sequencer takes over,
              unanchored, if it stops), payslips are sealed with ML-KEM-1024, and independent watchtowers re-execute every batch and challenge fraud on chain.
            </p>
          </>
        }
        soundings={soundings}
      />

      {error && !state && <p className="err">Could not read the chain: {error}. It is asked again every {REFRESH_MS / 1000} s.</p>}
      {error && state && <p className="err">The last refresh failed ({error}); showing what was read at {utcTime(state.loadedAt)}.</p>}
      {!state && !error && <Reading>Reading {ROLLUP} from {NODE_HOST}: the rollup, its batches, anchors, inbox, bond and fraud proofs…</Reading>}

      <BeaconLine
        rows={state?.rows.map((r) => ({ batchIndex: r.batchIndex, status: r.status, anchored: r.anchored, block: r.block, stateRoot: r.stateRoot, submittedTime: r.batch?.submittedTime }))}
        frauds={state?.frauds}
        windowSec={rollup?.challengeWindowSec}
        now={now}
        nameOf={(a) => KNOWN[a] ?? shortAddr(a)}
      />

      {state && state.frauds.length > 0 && (
        <section className="fraud-band" ref={reveal} aria-labelledby="fraud-h">
          <div className="fb-head">
            <p className="fb-eyebrow">Fraud caught on chain · {state.frauds.length} upheld challenge{state.frauds.length === 1 ? "" : "s"}</p>
            <h2 id="fraud-h" className="fb-title">
              {COUNT[state.frauds.length] ?? state.frauds.length} forged batch{state.frauds.length === 1 ? "" : "es"}, <em>proven wrong</em> on chain.
            </h2>
            <p className="note">
              When a fraud proof rejects a batch, the chain drops it and the next batch submitted takes the same index, so a rejected batch's number can appear
              on the beacon line and in the log as a different, later batch.
            </p>
          </div>
          <ol className="fb-list">
            {state.frauds.map((f) => (
              <li key={f.tx}>
                <div className="fb-figs">
                  <p>
                    <span className="fb-n">{qor(f.slashed)}</span>
                    <span className="fb-k">bond slashed</span>
                  </p>
                  <p>
                    <span className="fb-n">{qor(f.reward)}</span>
                    <span className="fb-k">paid to the challenger</span>
                  </p>
                </div>
                <p className="fb-text">
                  Batch <strong>#{f.batchIndex}</strong> by <Name addr={f.submitter} /> was proven wrong; <Name addr={f.challenger} /> challenged it and was paid.
                  {f.reusedBy && (
                    <>
                      {" "}
                      Its index was then reused: batch #{f.batchIndex} in the log was submitted later, at block {f.reusedBy.block.toLocaleString()}, and is{" "}
                      {f.reusedBy.status}.
                    </>
                  )}
                </p>
                <p className="when">
                  {f.time ? utcStamp(Date.parse(f.time)) : ""} · block {f.height.toLocaleString()} · <Ext href={txUrl(f.tx)}>challenge tx</Ext>
                </p>
              </li>
            ))}
          </ol>
        </section>
      )}

      <BrowserWatchtower />

      {state && rollup && (
        <div className="cols">
          <div>
            <Section
              title="Batches"
              aside={
                <>
                  challenge window {rollup.challengeWindowSec ? `${Math.round(rollup.challengeWindowSec / 60)} min` : "n/a"} ·{" "}
                  {refreshing ? "refreshing…" : `read ${utcTime(state.loadedAt)}`}
                </>
              }
            >
              <div className="table-wrap">
                <table className="log-table">
                  <thead>
                    <tr>
                      <th className="num">#</th>
                      <th>Status</th>
                      <th>State root</th>
                      <th>Inbox</th>
                      <th>Anchor</th>
                      <th className="num">Block</th>
                      <th>
                        <span className="sr-only">Receipt</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.rows.map(({ key, batchIndex, status, stateRoot, batch: b, anchored, block }, i) => (
                      <tr key={key} style={{ animationDelay: `${Math.min(i, 30) * 18}ms` }}>
                        <td className="num idx">{batchIndex}</td>
                        <td>
                          <span
                            className={`st ${status}`}
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
                        <td>{anchored ? <span className="anc lit">ML-DSA-87</span> : <span className="anc open">none</span>}</td>
                        <td className="num">{block.toLocaleString()}</td>
                        <td>
                          {anchored ? (
                            <a className="go" href={`#/verify?batch=${batchIndex}`}>
                              Verify receipt
                            </a>
                          ) : (
                            <span className="note" title="Only batches from the creator's sequencer carry an ML-DSA-87 anchor. This one came from the standby or another bonded submitter, so it has no settlement receipt, and never will.">
                              no receipt
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          </div>

          <aside>
            <Section
              title={
                <>
                  <span className="listening" aria-hidden="true" /> Live
                </>
              }
              aside="posts, batches and fraud as they happen · UTC"
            >
              {items.length === 0 ? (
                <p className="empty">Listening to the chain. Nothing new since this page opened.</p>
              ) : (
                <ul className="feed log-feed">
                  {items.map((i) => (
                    <FeedItem key={`${i.kind}:${i.tx}:${i.height}`} item={i} />
                  ))}
                </ul>
              )}
            </Section>
            <Section title="Who runs what">
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
                  Keel, run by the creator, batches within seconds and anchors each batch. A standby Keel with its own bonded key batches any entry that has
                  waited 30 blocks; anyone else who bonds may do the same.
                </dd>
                <dt>Watchtowers</dt>
                <dd>Two of ours (US West and EU West) plus anyone else's. Any bonded account can challenge, and the chain pays the first correct challenger.</dd>
              </dl>
              <p className="note">
                Who can move, stop or change what, read live, and how to leave without us: <a href="#/trust">Trust</a>.
              </p>
              <ExplorerHint />
            </Section>
          </aside>
        </div>
      )}
    </>
  );
}
