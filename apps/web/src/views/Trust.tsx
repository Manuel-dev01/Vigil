/**
 * Trust: who can do what to vigil-pay-1 and its exits, read live where the chain can say, graded against
 * L2BEAT's Stages framework as a self-assessment, and how to leave if Vigil disappears.
 *
 * Every live value comes from the node over its websocket (governance, the circuit breaker and the rollup
 * module's parameters are REST routes answered through abci_query, see @vigil/chain-ws) or from the EVM
 * endpoint by eth_call. Neither proves its answers, so the page says "as the node reports".
 */
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Abi, type Hex } from "viem";
import deployments from "../../../../deployments/diana.json";
import { chain } from "../chain.ts";
import { CHAIN_ID, NODE_HOST, REPO, ROLLUP, dur, errText, qor, utcStamp, utcTime } from "../config.ts";
import { ethCall } from "../evm.ts";
import { reveal } from "../reveal.ts";
import {
  FRAMEWORK,
  STAGE1_NEEDS,
  authority,
  doc,
  ev,
  exitCard,
  govModuleAddress,
  parseAuthority,
  parseCircuit,
  parseGovVoting,
  parseRdkParams,
  parseRollup,
  qorFromWei,
  rosette,
  stage0,
  stage1,
  stage2,
  tm,
  wedgePath,
  type Item,
  type Level,
  type Ref,
  type Slice,
  type TrustFacts,
  type VaultFacts,
} from "../trust.ts";
import { Ext, Mark, useRefresh, type Tone } from "../ui.tsx";
import { PageHead, Reading, Section, type Sounding } from "./Head.tsx";
import "./trust.css";

const REFRESH_MS = 5 * 60_000;
const VAULT = (deployments as { InstantExitVault?: { address: Hex } }).InstantExitVault?.address;

const vaultAbi = parseAbi([
  "function quorum() view returns (address[])",
  "function threshold() view returns (uint256)",
  "function lp() view returns (address)",
  "function feeBps() view returns (uint16)",
  "function available() view returns (uint256)",
  "function totalOwed() view returns (uint256)",
]) as Abi;

async function call<T>(functionName: string): Promise<T> {
  if (!VAULT) throw new Error("no InstantExitVault deployment");
  const data = encodeFunctionData({ abi: vaultAbi, functionName });
  return decodeFunctionResult({ abi: vaultAbi, functionName, data: await ethCall(VAULT, data) }) as T;
}

async function readVault(): Promise<VaultFacts> {
  const [quorum, threshold, lp, feeBps, available, owed] = await Promise.all([
    call<readonly Hex[]>("quorum"),
    call<bigint>("threshold"),
    call<Hex>("lp"),
    call<number>("feeBps"),
    call<bigint>("available"),
    call<bigint>("totalOwed"),
  ]);
  return { quorum: [...quorum], threshold: Number(threshold), lp, feeBps: Number(feeBps), availableWei: available, totalOwedWei: owed };
}

async function load(): Promise<TrustFacts> {
  const { rest } = await chain();
  const get = async (path: string): Promise<unknown> => {
    const r = await rest(path);
    if (!r.ok) throw new Error(`${path} answered ${r.status}`);
    return r.json();
  };
  const [status, rollup, params, gov, disabled, accounts, auth, gov0, vault] = await Promise.allSettled([
    get("/cosmos/base/node/v1beta1/status"),
    get(`/qorechain/rdk/v1/rollup/${ROLLUP}`).then(parseRollup),
    get("/qorechain/rdk/v1/params").then(parseRdkParams),
    get("/cosmos/gov/v1/params/voting").then(parseGovVoting),
    get("/cosmos/circuit/v1/disable_list"),
    get("/cosmos/circuit/v1/accounts"),
    get("/cosmos/upgrade/v1beta1/authority").then(parseAuthority),
    govModuleAddress(),
    readVault(),
  ]);
  const facts: TrustFacts = { readAt: Date.now(), errors: {} };
  const why = (r: PromiseRejectedResult) => errText(r.reason);
  if (status.status === "fulfilled") {
    const h = Number((status.value as { height?: string }).height);
    if (Number.isFinite(h) && h > 0) facts.height = h;
  } else facts.errors.status = why(status);
  if (rollup.status === "fulfilled") facts.rollup = rollup.value;
  else facts.errors.rollup = why(rollup);
  if (params.status === "fulfilled") facts.params = params.value;
  else facts.errors.params = why(params);
  if (gov.status === "fulfilled") facts.gov = gov.value;
  else facts.errors.gov = why(gov);
  if (disabled.status === "fulfilled" && accounts.status === "fulfilled") {
    try {
      facts.circuit = parseCircuit(disabled.value, accounts.value);
    } catch (e) {
      facts.errors.circuit = errText(e);
    }
  } else facts.errors.circuit = why([disabled, accounts].find((r) => r.status === "rejected") as PromiseRejectedResult);
  if (auth.status === "fulfilled") facts.upgradeAuthority = { address: auth.value, isGov: gov0.status === "fulfilled" && gov0.value === auth.value };
  else facts.errors.authority = why(auth);
  if (vault.status === "fulfilled") facts.vault = vault.value;
  else facts.errors.vault = why(vault);
  return facts;
}

// ------------------------------------------------------------ small pieces

function Refs({ refs }: { refs: Ref[] }) {
  if (!refs.length) return null;
  return (
    <span className="tr-refs">
      {refs.map((r, i) => (
        <Ext key={`${r.label}-${i}`} href={r.href}>
          {r.label}
        </Ext>
      ))}
    </span>
  );
}

const LEVEL_WORD: Record<Level, string> = { good: "low risk", caution: "caution", risk: "high risk", unknown: "not graded" };
const LEVEL_CHIP: Record<Level, string> = { good: "ok", caution: "warn", risk: "bad", unknown: "pruned" };

function Rosette({ slices }: { slices: Slice[] }) {
  const label = `Risk rosette, our own grading: ${slices.map((s) => `${s.name}, ${LEVEL_WORD[s.level]}`).join("; ")}.`;
  return (
    <div className="tr-rosette">
      <svg viewBox="0 0 200 200" role="img" aria-label={label} className="tr-rose">
        {slices.map((s, i) => (
          <path key={s.key} d={wedgePath(i, slices.length, 100, 22, 94)} className={`tr-w tr-${s.level}`} />
        ))}
        {slices.map((s, i) => {
          const a = ((360 / slices.length) * (i + 0.5) - 90) * (Math.PI / 180);
          return (
            <text key={s.key} x={100 + 60 * Math.cos(a)} y={100 + 60 * Math.sin(a)} className="tr-n" textAnchor="middle" dominantBaseline="central" aria-hidden="true">
              {i + 1}
            </text>
          );
        })}
      </svg>
      <ol className="tr-slices">
        {slices.map((s) => (
          <li key={s.key}>
            <p className="tr-sh">
              <span className="tr-name">{s.name}</span> <span className={`chip ${LEVEL_CHIP[s.level]}`}>{LEVEL_WORD[s.level]}</span>
            </p>
            <p className="tr-val">{s.value}</p>
            <p className="note">
              {s.text} <Refs refs={s.refs} />
            </p>
          </li>
        ))}
      </ol>
    </div>
  );
}

const STATUS_TONE: Record<Item["status"], Tone> = { met: "ok", caveat: "wait", "not met": "bad", unknown: "skip" };

function Checklist({ items, label }: { items: Item[]; label: string }) {
  return (
    <ul className="checks tr-checks" aria-label={label}>
      {items.map((it) => (
        <li key={it.q}>
          <Mark tone={STATUS_TONE[it.status]} label={it.status === "caveat" ? "met, with a caveat" : it.status} />
          <span>
            <span className="what">{it.q}</span>
            {it.live && <span className="chip pruned tr-live">read live</span>}
            <br />
            <span className="why">
              {it.text} <Refs refs={it.refs} />
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------ the view

export function TrustView() {
  const { data: f, error, refreshing } = useRefresh(load, REFRESH_MS);
  return <TrustPage f={f} error={error} refreshing={refreshing} />;
}

/** The page for one read of the chain (or none yet): kept apart from the loading so it can be rendered in a test. */
export function TrustPage({ f, error, refreshing }: { f: TrustFacts | undefined; error?: string | undefined; refreshing?: boolean }) {
  const slices = f && rosette(f);
  const card = f && exitCard(f);

  const soundings: Sounding[] = [
    {
      k: "Challenge window",
      v: f ? (f.rollup?.challengeWindowSec !== undefined ? dur(f.rollup.challengeWindowSec) : "not read") : undefined,
      tone: f?.rollup?.challengeWindowSec !== undefined && f.rollup.challengeWindowSec < FRAMEWORK.stage1MinChallengeSec ? "warn" : undefined,
      s: "Stage 1 asks at least 5 days",
    },
    {
      k: "Governance vote",
      v: f ? (f.gov ? dur(f.gov.votingPeriodSec) : "not read") : undefined,
      tone: f?.gov && f.gov.votingPeriodSec < FRAMEWORK.stage1MinExitWindowSec ? "bad" : undefined,
      s: f?.gov?.expeditedVotingPeriodSec !== undefined ? `${dur(f.gov.expeditedVotingPeriodSec)} if expedited · Stage 1 asks 7 days to exit` : "Stage 1 asks 7 days to exit",
    },
    {
      k: "Exit quorum",
      v: f ? (f.vault ? `${f.vault.threshold} of ${f.vault.quorum.length}` : "not read") : undefined,
      s: "ML-DSA-87 keys, one operator",
    },
    { k: "Exit liquidity", v: f ? (f.vault ? qorFromWei(f.vault.availableWei) : "not read") : undefined, s: "caps early exits; the contract sets no limit" },
    { k: "Submitter bond", v: f ? (f.params ? qor(f.params.minSubmitterBondUqor) : "not read") : undefined, s: "lets any account batch" },
  ];

  return (
    <>
      <PageHead
        eyebrow={<>Trust · a self-assessment · live from {CHAIN_ID}</>}
        title="Who you trust, and how to leave"
        lede={
          <>
            <p>
              Who can move, stop or change what in {ROLLUP}, read from the chain where it can say, and graded by us against L2BEAT's Stages framework.
              This is our own reading, not an L2BEAT rating, and it claims no stage.
            </p>
            <p>
              Short version: anyone can post, prove fraud and pay out final withdrawals; any bonded account can batch. The weak points are a short
              testnet challenge window, and an L1 governance that can change the rules sooner than Stage 1 allows.
            </p>
          </>
        }
        soundings={soundings}
      />

      {error && !f && <p className="err">Could not read the chain: {error}. It is asked again every {REFRESH_MS / 60_000} min.</p>}
      {!f && !error && <Reading>Reading {ROLLUP}, the rollup module's parameters, governance and the circuit breaker from {NODE_HOST}, and the exit vault from the EVM endpoint…</Reading>}
      {f && Object.keys(f.errors).length > 0 && (
        <p className="err">
          Some reads failed, and the parts that need them say so: {Object.entries(f.errors).map(([k, v]) => `${k} (${v})`).join("; ")}.
        </p>
      )}

      {f && slices && card && (
        <>
          <Section title="Risk rosette" aside={<>our grading · {refreshing ? "refreshing…" : `read ${utcTime(f.readAt)}`}</>}>
            <p className="note">
              The five questions L2BEAT asks of every rollup. Green is low risk, amber needs care, red is a real exposure. The grades are ours.
            </p>
            <Rosette slices={slices} />
          </Section>

          <Section title="Stages checklist" aside={<>self-assessment · {FRAMEWORK.readOn}</>} id="stages">
            <div className="tr-stages">
              <div>
                <h3 className="tr-h3">Stage 0</h3>
                <p className="note">By our reading every Stage 0 question is answered yes, one with a caveat.</p>
                <Checklist items={stage0(f)} label="Stage 0 requirements" />
              </div>
              <div>
                <h3 className="tr-h3">Stage 1: what blocks it</h3>
                <Checklist items={stage1(f)} label="Stage 1 requirements" />
                <h3 className="tr-h3">Stage 2</h3>
                <Checklist items={stage2(f)} label="Stage 2 requirements" />
              </div>
            </div>
            <h3 className="tr-h3">What an RDK rollup needs from QoreChain to reach Stage 1</h3>
            <p className="note">
              QoreChain's rollup module is part of the L1, so changes to it come from the L1's governance, where an Ethereum rollup's would come from whoever
              can upgrade its contracts. These are the changes that would move the answer, and who would make them.
            </p>
            <ul className="tr-needs">
              {STAGE1_NEEDS.map((n) => (
                <li key={n.what}>
                  <span className="tr-who">{n.who}</span>
                  <span>{n.what}</span>
                </li>
              ))}
            </ul>
            <p className="note tr-cite">
              Measured against {FRAMEWORK.name}: <Ext href={FRAMEWORK.page}>the Stages page</Ext> (the site now calls itself ETHBEAT; {FRAMEWORK.formerly}{" "}
              redirects there). It gives no version number; it says "Last updated on {FRAMEWORK.pageUpdated}", and the Stage 1 minimum challenge period was
              cut from 7 to 5 days in <Ext href={FRAMEWORK.stage1Update.url}>a forum post of {FRAMEWORK.stage1Update.date}</Ext>. Read on {FRAMEWORK.readOn}. The
              same checklist, with the values as read that day, is in <Ext href={doc("docs/STAGES.md").href}>docs/STAGES.md</Ext>.
            </p>
          </Section>

          <Section title="Who can do what" aside={<>read live where marked · as the node reports</>} id="authority">
            <ul className="tr-powers">
              {authority(f).map((p) => (
                <li key={p.action}>
                  <p className="tr-act">
                    {p.action}
                    <span className="chip pruned">{p.source}</span>
                  </p>
                  <p className="tr-whoc">
                    {p.who} <Refs refs={p.refs} />
                  </p>
                </li>
              ))}
            </ul>
          </Section>

          <div className="cols tr-cols">
            <div>
              <Section title="Instant exits: the risk card" aside="in L2BEAT's bridge fields">
                <dl className="kv tr-kv">
                  {card.fields.map((x) => (
                    <div key={x.k} className="tr-kvrow">
                      <dt>{x.k}</dt>
                      <dd>
                        {x.v} <Refs refs={x.refs} />
                      </dd>
                    </div>
                  ))}
                </dl>
                <h3 className="tr-h3">Funds can be stolen if…</h3>
                <ul className="tr-list">
                  {card.stolen.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
                <h3 className="tr-h3">An exit is slower, not lost, if…</h3>
                <ul className="tr-list">
                  {card.delayed.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
                <p className="note">
                  More in <Ext href={tm("14").href}>THREAT_MODEL §14</Ext>.
                </p>
              </Section>
            </div>
            <aside>
              <Disappears />
            </aside>
          </div>

          <p className="note tr-foot">
            Read at {utcStamp(f.readAt)}
            {f.height ? `, block ${f.height.toLocaleString("en-GB")}` : ""}, from {NODE_HOST} over its websocket and the EVM endpoint by eth_call. Neither
            proves its answers. Values not marked "read live" come from the contracts' code, the chain's rules or the{" "}
            <Ext href={`${REPO}/blob/main/EVIDENCE.md`}>evidence ledger</Ext>.
          </p>
        </>
      )}
    </>
  );
}

function Disappears() {
  return (
    <section className="sec tr-gone" ref={reveal} aria-labelledby="gone-h">
      <h2 className="sec-h" id="gone-h">
        <span>If Vigil disappears</span>
        <small>what keeps working</small>
      </h2>
      <h3 className="tr-h3">Keeps working</h3>
      <ul className="tr-list">
        <li>
          Posting to the inbox: anyone, from any L1 account. <Refs refs={[ev("68")]} />
        </li>
        <li>
          Batching: any account that bonds the minimum; Keel's code runs as a standby for anyone. <Refs refs={[ev("65–72")]} />
        </li>
        <li>
          Fraud proofs: anyone; another team's watcher won our first drill. <Refs refs={[ev("44")]} />
        </li>
        <li>
          Withdrawals from final batches: anyone can execute them, and they pay the recipient the user signed for. <Refs refs={[ev("72, 93")]} />
        </li>
        <li>
          Old receipts: anchors stay on chain, and the Solidity verifier has no owner. <Refs refs={[ev("60")]} />
        </li>
      </ul>
      <h3 className="tr-h3">Stops</h3>
      <ul className="tr-list">
        <li>
          Anchors, and so settlement receipts for new batches: only the creator's key can anchor. <Refs refs={[tm("13")]} />
        </li>
        <li>Instant exits: the quorum and the relayer are ours. Withdrawals are then paid at finality.</li>
        <li>Our watchtowers, the keep-alive, the alerts, and this hosted page (anyone can build and serve apps/web).</li>
      </ul>
      <p>
        <Ext href={doc("docs/ESCAPE_HATCH.md").href}>Leave without us: the commands</Ext>
      </p>
      <p className="note">
        Read your balance by replaying the chain, post your own withdrawal, batch it yourself if no one else does, and claim it after the window. Each
        command was checked from a fresh clone on 27 Nov 2026 in read-only or dry-run mode; the steps that send a transaction are not yet exercised by
        someone outside the team.
      </p>
    </section>
  );
}
