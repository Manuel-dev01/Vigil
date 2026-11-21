//! Differential-fuzzing shim: runs qledger-v1 cases through the Rust RDK.
//! stdin: one JSON case per line; stdout: one JSON result per line.
use std::io::{BufRead, Write};

use qorechain_rdk::qledger::{execute_qledger, QledgerEntry, QledgerEnv, QledgerLedger, MLDSA44_VERIFIER};
use serde_json::{json, Value};

fn run(c: &Value) -> Value {
    let id = c["id"].as_str().unwrap_or("").to_string();
    let chain_id = c["chainId"].as_str().unwrap_or("").to_string();
    let rollup_id = c["rollupId"].as_str().unwrap_or("").to_string();
    let env = QledgerEnv { chain_id: &chain_id, rollup_id: &rollup_id, verifier: &MLDSA44_VERIFIER };
    let mut ledger = QledgerLedger::new();
    let mut batches = Vec::new();
    for b in c["batches"].as_array().cloned().unwrap_or_default() {
        let mut entries = Vec::new();
        for e in b["entries"].as_array().cloned().unwrap_or_default() {
            let payload = match hex::decode(e["payload"].as_str().unwrap_or("")) {
                Ok(p) => p,
                Err(_) => return json!({ "id": id, "batches": batches, "error": "bad payload hex" }),
            };
            entries.push(QledgerEntry {
                height: e["height"].as_u64().unwrap_or(0),
                poster: e["poster"].as_str().unwrap_or("").to_string(),
                payload,
            });
        }
        match execute_qledger(&env, &mut ledger, &entries) {
            Ok(r) => batches.push(json!({
                "stateRoot": hex::encode(r.state_root),
                "withdrawalsRoot": hex::encode(&r.withdrawals_root),
                "withdrawals": r.withdrawals.iter().map(|w| json!({
                    "index": w.index.to_string(), "recipient": w.recipient, "amount": w.amount.to_string()
                })).collect::<Vec<_>>(),
            })),
            Err(err) => batches.push(json!({ "withdrawalsRoot": "", "withdrawals": [], "error": err.to_string() })),
        }
    }
    json!({ "id": id, "batches": batches })
}

fn main() {
    let stdin = std::io::stdin();
    let mut out = std::io::BufWriter::new(std::io::stdout());
    for line in stdin.lock().lines() {
        let line = line.expect("read");
        let c: Value = serde_json::from_str(&line).expect("bad case");
        let res = std::panic::catch_unwind(|| run(&c))
            .unwrap_or_else(|_| json!({ "id": c["id"], "batches": [], "error": "panic" }));
        writeln!(out, "{}", res).unwrap();
    }
}
