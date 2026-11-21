"""Differential-fuzzing shim: runs qledger-v1 cases through the Python RDK.
stdin: one JSON case per line; stdout: one JSON result per line."""
import json
import sys

from qorrdk.qledger.execute import QledgerEntry, execute_qledger
from qorrdk.qledger.smt import QledgerLedger


def run(c):
    out = {"id": c["id"], "batches": []}
    ledger = QledgerLedger()
    for b in c["batches"]:
        entries = [QledgerEntry(height=e["height"], poster=e["poster"], payload=bytes.fromhex(e["payload"])) for e in b["entries"]]
        try:
            r = execute_qledger(ledger, entries, chain_id=c["chainId"], rollup_id=c["rollupId"])
        except Exception as err:  # noqa: BLE001
            out["batches"].append({"withdrawalsRoot": "", "withdrawals": [], "error": f"{type(err).__name__}: {err}"})
            continue
        out["batches"].append({
            "stateRoot": r.state_root.hex(),
            "withdrawalsRoot": r.withdrawals_root.hex(),
            "withdrawals": [{"index": str(w.index), "recipient": w.recipient, "amount": str(w.amount)} for w in r.withdrawals],
        })
    return out


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    c = json.loads(line)
    try:
        res = run(c)
    except Exception as err:  # noqa: BLE001
        res = {"id": c.get("id"), "batches": [], "error": f"{type(err).__name__}: {err}"}
    sys.stdout.write(json.dumps(res) + "\n")
    sys.stdout.flush()
