/**
 * "Every instant exit": one row per exit the vault fronted, with the times the race above draws for the
 * latest one (the same reads: the inbox post, the batch record, the vault's Fronted and Settled logs),
 * plus the gas front() used, from its receipt. The summary row is computed in ledger.ts, the same code
 * scripts/exit/metrics.ts runs to write docs/exits-metrics.json.
 */
import { REPO, dur, qor, stamp } from "../config.ts";
import { qorWei, type ExitView } from "../exits.ts";
import { SMALL_SAMPLE, ledgerRows, ledgerSummary, type LedgerExit, type LedgerRow, type Spread } from "../ledger.ts";
import { ledgerExitOf } from "../ledger-exit.ts";
import { CopyHash } from "../ui.tsx";
import "./ledger.css";

const secs = (s: number | undefined): string => (s === undefined ? "—" : dur(s));
const spreadText = (s: Spread | undefined, worst: "max" | "min" = "max"): string =>
  !s ? "—" : s.n === 1 ? dur(s.median) : `median ${dur(s.median)} · ${worst} ${dur(s[worst])}`;

function Repaid({ r }: { r: LedgerRow }) {
  if (r.outcome === "lost") return <span className="chip bad">LP loss: batch {r.batchStatus}</span>;
  if (r.outcome === "overdue") return <span className="chip warn">overdue</span>;
  if (r.outcome === "pending") return <span className="chip pending">after finality</span>;
  return (
    <span title={r.repaidAt ? `${stamp(r.repaidAt)}${r.repaidAfterFinalSec !== undefined ? `, ${dur(r.repaidAfterFinalSec)} after the batch could be final` : ""}` : undefined}>
      after {secs(r.repaidAfterSec)}
    </span>
  );
}

export function Ledger({ exits, nowSec, total }: { exits: ExitView[]; nowSec: number; total: number }) {
  const rows = ledgerRows(
    exits.map(ledgerExitOf).filter((e): e is LedgerExit => !!e),
    nowSec,
  );
  const s = ledgerSummary(rows);
  const paidLater = exits.filter((x) => !x.fronted && !x.error && x.executed).length;
  const small = s.n < SMALL_SAMPLE;
  return (
    <section className="panel ledger" aria-labelledby="ledger-h">
      <h2 id="ledger-h">
        Every instant exit{" "}
        <small>
          {s.n} fronted{small ? ", a small sample" : ""}
          {total > exits.length ? ` · newest ${exits.length} of ${total} attested or fronted` : ""}
        </small>
      </h2>
      <p className="note">
        One row per exit the vault paid before its batch was final. Every time is a block time as the node reports it: the L2 withdrawal's post, the batch's
        submission, front() and the sweep() that repaid the vault.
      </p>
      {rows.length === 0 ? (
        <p className="empty">The vault has not fronted an exit yet.</p>
      ) : (
        <div className="table-wrap" role="region" aria-labelledby="ledger-h" tabIndex={0}>
          <table className="log-table ledger-table">
            <thead>
              <tr>
                <th scope="col">Exit</th>
                <th scope="col" className="num" title="From the L2 withdrawal's post to front()">
                  Withdrawn → paid
                </th>
                <th scope="col" className="num" title="From the batch's submission to front()">
                  Batch → paid
                </th>
                <th scope="col" className="num" title="How long before the batch could be final front() paid">
                  Before final
                </th>
                <th scope="col" title="How long after front() a sweep repaid the vault">
                  Vault repaid
                </th>
                <th scope="col" className="num">
                  front() gas
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id} style={{ animationDelay: `${Math.min(i, 30) * 18}ms` }}>
                  <td>
                    <span className="ledger-exit">
                      Batch {r.batchIndex}, withdrawal {r.withdrawalIndex}
                    </span>
                    <span className="note">
                      {r.amountUqor !== undefined ? qor(r.amountUqor) : "?"}
                      {r.paidAt ? ` · paid ${stamp(r.paidAt)}` : ""}
                    </span>
                  </td>
                  <td className="num">{secs(r.postToPaidSec)}</td>
                  <td className="num">{secs(r.batchToPaidSec)}</td>
                  <td className="num">{r.aheadOfFinalitySec === undefined ? "—" : r.aheadOfFinalitySec >= 0 ? dur(r.aheadOfFinalitySec) : `${dur(-r.aheadOfFinalitySec)} after`}</td>
                  <td>
                    <Repaid r={r} />
                  </td>
                  <td className="num">
                    {r.frontGas !== undefined ? r.frontGas.toLocaleString("en-US") : "—"}
                    {r.frontTx && (
                      <span className="note ledger-tx">
                        <CopyHash label="tx" value={r.frontTx} />
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">
                  {s.n} exit{s.n === 1 ? "" : "s"}
                  {small && <span className="note">small sample</span>}
                </th>
                <td className="num">{spreadText(s.postToPaid)}</td>
                <td className="num">{spreadText(s.batchToPaid)}</td>
                <td className="num">{spreadText(s.aheadOfFinality, "min")}</td>
                <td>
                  repaid {s.repaid} of {s.n}
                </td>
                <td className="num">{s.frontGas ? (s.frontGas.n === 1 ? s.frontGas.median.toLocaleString("en-US") : `median ${Math.round(s.frontGas.median).toLocaleString("en-US")}`) : "—"}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      {rows.length > 0 && (
        <p className="note ledger-sum">
          Repaid {s.repaid} of {s.n}
          {s.pending ? `, ${s.pending} waiting for finality` : ""}. Overdue: {s.overdue}. LP losses: {s.lost}
          {s.lost ? ` (${qorWei(s.lostWei)})` : ""}. Fees earned: {qorWei(s.feesWei)}.
          {s.latestPaidAt ? ` Latest: ${dur(Math.max(0, nowSec - s.latestPaidAt))} ago.` : ""}
          {paidLater ? ` ${paidLater} attested exit${paidLater === 1 ? " was" : "s were"} not fronted and paid in full after finality instead.` : ""}{" "}
          A snapshot is kept in <a href={`${REPO}/blob/main/docs/exits-metrics.json`} target="_blank" rel="noopener noreferrer">docs/exits-metrics.json</a>.
        </p>
      )}
    </section>
  );
}
