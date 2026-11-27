/**
 * The trust page rendered to HTML for 27 Nov 2026's read, and for a read where every live part failed: no
 * runtime error, the self-assessment wording is there, and no stage is claimed. No network: the page is given
 * its facts.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseCircuit, parseGovVoting, parseRdkParams, parseRollup, type TrustFacts } from "../src/trust.ts";
import { TrustPage } from "../src/views/Trust.tsx";

const facts: TrustFacts = {
  readAt: Date.UTC(2026, 10, 27, 16, 45),
  height: 10_859_790,
  rollup: parseRollup({
    rollup: { rollup_id: "vigil-pay-1", creator: "qor1z6m6kshavs5zjvd3tz0nu9tjpde5p7w83mj90s", status: "active", challenge_window_sec: "3600", proof_system: "fraud", sequencing: "based", execution_vm: "qledger-v1", deposit_pool: "2450000", escrow_balance: "9900000000" },
  }),
  params: parseRdkParams({ params: { min_submitter_bond: "1000000000", posted_data_retention_blocks: "648000" } }),
  gov: parseGovVoting({ params: { voting_period: "14400s", expedited_voting_period: "3600s" } }),
  circuit: parseCircuit({ disabled_list: ["/cosmwasm.wasm.v1.MsgStoreCode"] }, { accounts: [] }),
  upgradeAuthority: { address: "qor10d07y265gmmuvt4z0w9aw880jnsr700jwfyxr3", isGov: true },
  vault: {
    quorum: ["0x2684Af6bd37F2fd9cEA02B58D1725d69f3C928CA", "0x13f665a393a96c972606ACfAE757754443DCBa8f"],
    threshold: 2,
    lp: "0x16B7aB42fD64282931B1589f3e15720B7340f9c7",
    feeBps: 50,
    availableWei: 1_001_000_000_000_000_000n,
    totalOwedWei: 0n,
  },
  errors: {},
};

const render = (f: TrustFacts | undefined, error?: string) => renderToStaticMarkup(createElement(TrustPage, { f, error, refreshing: false }));

describe("the trust page", () => {
  it("renders 27 Nov's read with every section", () => {
    const html = render(facts);
    for (const s of ["Risk rosette", "Stages checklist", "Who can do what", "Instant exits: the risk card", "If Vigil disappears", "What an RDK rollup needs from QoreChain to reach Stage 1"]) {
      expect(html).toContain(s);
    }
    expect(html).toContain("not an L2BEAT rating, and it claims no stage");
    expect(html).toContain("Last updated on 23 Jul 2025");
    expect(html).toContain("docs/ESCAPE_HATCH.md");
    expect(html).toContain("Assumption the framework makes, not a requirement.");
    expect(html).toContain("None if a vote is expedited (1 h); about 3 h otherwise");
    expect(html).toContain('role="img"');
    expect(html.match(/<path /g)).toHaveLength(5);
    expect(html).not.toMatch(/quantum-proof|quantum-safe|unbreakable/i);
  });

  it("names what it could not read instead of breaking", () => {
    const html = render({ readAt: 0, errors: { gov: "timeout", rollup: "timeout", params: "timeout", circuit: "timeout", vault: "HTTP 503" } });
    expect(html).toContain("Some reads failed");
    expect(html).toContain("not graded");
  });

  it("shows the reading line before the first answer", () => {
    expect(render(undefined)).toContain("Reading vigil-pay-1");
    expect(render(undefined, "socket closed")).toContain("Could not read the chain: socket closed");
  });
});
