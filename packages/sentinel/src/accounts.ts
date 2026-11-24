import type { Account } from "./rules.ts";

const QOR = 1_000_000n;
/** Every key the team runs, with its rules. All addresses are public in the README and EVIDENCE. */
export const ACCOUNTS: Account[] = [
  { name: "Creator / sequencer (drill account)", qor1: "qor1z6m6kshavs5zjvd3tz0nu9tjpde5p7w83mj90s", windowForbidden: true, minUqor: 50n * QOR },
  { name: "watchtower-2", qor1: "qor1y6z2767n0uhann4q9dvdzujad8euj2x2z6z6yd", windowForbidden: true, minUqor: 6n * QOR },
  { name: "watchtower-3", qor1: "qor1z0mxtgun49kfwfsx4naww4m4g3paew50v3lp33", windowForbidden: true, minUqor: 6n * QOR },
  { name: "keel-b (standby sequencer)", qor1: "qor1qwker9qw2l4jpsudwkkkcrwnc9a29xpvw36gft", windowForbidden: true, minUqor: 3n * QOR },
  { name: "keep-alive poster", qor1: "qor12t0u9hrz2qnfmkrpp3k5u3s9mghsz9vdwkjd6l", windowForbidden: true, minUqor: QOR / 2n },
  { name: "employer-1 (payslips)", qor1: "qor1r74gzxy9u495j0jz9xl2gf69uy2gwxfa7l5pws", windowForbidden: true, minUqor: QOR / 5n },
  { name: "exit-relayer", qor1: "qor1vwqwy8nqj060e8ufdze7qlnsq7lsjaxsfhf8hn", windowForbidden: false, maxWindowSec: 600, minUqor: (QOR * 6n) / 10n },
  { name: "evm-deployer", qor1: "qor1qdf0xu8fvmp0uchhhdfcx7mq893h65jk8yfcp6", windowForbidden: false, maxWindowSec: 1800, minUqor: (QOR * 3n) / 10n },
];

