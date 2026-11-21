// Differential-fuzzing shim: runs qledger-v1 cases through the Go RDK.
// stdin: one JSON case per line; stdout: one JSON result per line.
package main

import (
	"bufio"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"strconv"

	rdk "github.com/qorechain/qorechain-rdk/packages/go"
)

type entry struct {
	Height  uint64 `json:"height"`
	Poster  string `json:"poster"`
	Payload string `json:"payload"`
}
type batch struct {
	Entries []entry `json:"entries"`
}
type caseIn struct {
	ID       string  `json:"id"`
	ChainID  string  `json:"chainId"`
	RollupID string  `json:"rollupId"`
	Batches  []batch `json:"batches"`
}
type wd struct {
	Index     string `json:"index"`
	Recipient string `json:"recipient"`
	Amount    string `json:"amount"`
}
type batchOut struct {
	StateRoot       string `json:"stateRoot,omitempty"`
	WithdrawalsRoot string `json:"withdrawalsRoot"`
	Withdrawals     []wd   `json:"withdrawals"`
	Error           string `json:"error,omitempty"`
}
type caseOut struct {
	ID      string     `json:"id"`
	Batches []batchOut `json:"batches"`
	Error   string     `json:"error,omitempty"`
}

func main() {
	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 64<<20), 64<<20)
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()
	enc := json.NewEncoder(out)
	for in.Scan() {
		var c caseIn
		if err := json.Unmarshal(in.Bytes(), &c); err != nil {
			fmt.Fprintln(os.Stderr, "bad case:", err)
			os.Exit(2)
		}
		enc.Encode(run(c))
	}
}

func run(c caseIn) (res caseOut) {
	res.ID = c.ID
	defer func() {
		if r := recover(); r != nil {
			res.Error = fmt.Sprint("panic: ", r)
		}
	}()
	env := rdk.QledgerEnv{ChainID: c.ChainID, RollupID: c.RollupID}
	ledger := rdk.NewQledgerLedger()
	for _, b := range c.Batches {
		entries := make([]rdk.QledgerEntry, 0, len(b.Entries))
		for _, e := range b.Entries {
			p, err := hex.DecodeString(e.Payload)
			if err != nil {
				res.Error = "bad payload hex"
				return
			}
			entries = append(entries, rdk.QledgerEntry{Height: e.Height, Poster: e.Poster, Payload: p})
		}
		r, err := rdk.ExecuteQledger(env, ledger, entries)
		if err != nil {
			res.Batches = append(res.Batches, batchOut{Error: err.Error(), Withdrawals: []wd{}})
			continue
		}
		ws := make([]wd, 0, len(r.Withdrawals))
		for _, w := range r.Withdrawals {
			ws = append(ws, wd{Index: strconv.FormatUint(w.Index, 10), Recipient: w.Recipient, Amount: strconv.FormatUint(w.Amount, 10)})
		}
		res.Batches = append(res.Batches, batchOut{StateRoot: hex.EncodeToString(r.StateRoot), WithdrawalsRoot: hex.EncodeToString(r.WithdrawalsRoot), Withdrawals: ws})
	}
	return
}
