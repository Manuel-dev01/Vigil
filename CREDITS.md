# Credits

Vigil is built on open-source software. This file lists it, with each project's licence and where to find it.
Vigil itself is licensed under Apache-2.0 (see [LICENSE](LICENSE) and [NOTICE](NOTICE)).

Versions are the ones pinned in `pnpm-lock.yaml`, `.gitmodules` and the Dockerfiles at the time of writing.
Licences are taken from each package's own `package.json` and LICENSE file (for npm packages, as installed
under `node_modules/`) or from the project's repository.

## TypeScript libraries (direct dependencies)

| Project | Version | Licence | Used by | Link |
|---|---|---|---|---|
| `@qorechain/rdk` (QoreChain Rollup Development Kit) | 0.9.0 | Apache-2.0 | keel, qledger-watchtower, exit-relayer, sealed, chain-ws (dev), web, scripts | https://github.com/qorechain/qorechain-rdk |
| `@qorechain/sdk` (QoreChain SDK) | 0.14.0 | Apache-2.0 | keel, qledger-watchtower, exit-relayer, sealed, scripts | https://github.com/qorechain/qorechain-sdk |
| `@qorechain/qoreseal` (ML-KEM-1024 sealing) | 0.1.0 | Apache-2.0 | sealed, web | https://github.com/qorechain/qoreseal |
| `@qorechain/qorescan` (QoreScan, CBOM; its launcher downloads a release binary and checks its SHA-256) | 0.1.0 | Apache-2.0 | root devDependency: CI (CBOM gate), scripts/cbom | https://github.com/qorechain/qorescan |
| `@cosmjs/proto-signing` | 0.39.0 | Apache-2.0 | keel, qledger-watchtower, exit-relayer, scripts | https://github.com/cosmos/cosmjs |
| `@cosmjs/stargate` | 0.39.0 | Apache-2.0 | keel, qledger-watchtower, exit-relayer, scripts | https://github.com/cosmos/cosmjs |
| `cosmjs-types` | 0.11.0 | Apache-2.0 | scripts | https://github.com/confio/cosmjs-types |
| `viem` | 2.57.20 | MIT | exit-relayer, web, scripts | https://github.com/wevm/viem |
| `@noble/hashes` | 2.4.0 | MIT | scripts | https://github.com/paulmillr/noble-hashes |
| `@noble/post-quantum` | 0.7.1 | MIT | scripts | https://github.com/paulmillr/noble-post-quantum |
| `@bufbuild/protobuf` (Protobuf-ES) | 2.16.0 | Apache-2.0 AND BSD-3-Clause | chain-ws | https://github.com/bufbuild/protobuf-es |
| `undici` | 8.12.4 | MIT | core, keel, scripts | https://github.com/nodejs/undici |

## Web app (`apps/web`)

| Project | Version | Licence | Link |
|---|---|---|---|
| React (`react`, `react-dom`) | 19.3.1 | MIT | https://github.com/react/react |
| Vite (`vite`, dev) | 8.3.5 | MIT | https://github.com/vitejs/vite |
| `@vitejs/plugin-react` (dev) | 6.2.1 | MIT | https://github.com/vitejs/vite-plugin-react |
| `@types/react`, `@types/react-dom` (dev) | 19.3.0 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| three.js (`three`; the landing page's 3D scene) | 0.187.0 | MIT | https://github.com/mrdoob/three.js |
| `@types/three` (dev) | 0.187.0 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| Lenis (`lenis`; the landing page's smooth scrolling) | 1.3.27 | MIT | https://github.com/darkroomengineering/lenis |

## Fonts (bundled with the web app and used in `brand/`)

Latin subsets from Fontsource, served by the site itself. Licences sit beside the files in
`apps/web/src/brand/fonts/`.

| Font | Package and version | Licence | Link |
|---|---|---|---|
| Bodoni Moda (display) | `@fontsource-variable/bodoni-moda` 5.3.0 | SIL Open Font License 1.1 | https://github.com/indestructible-type/Bodoni |
| Libre Franklin (text) | `@fontsource-variable/libre-franklin` 5.3.0 | SIL Open Font License 1.1 | https://github.com/impallari/Libre-Franklin |
| IBM Plex Mono (figures, hashes, labels) | `@fontsource/ibm-plex-mono` 5.3.0 | SIL Open Font License 1.1 | https://github.com/IBM/plex |

## Notable indirect dependencies

These come in through the libraries above (and so ship inside the web bundle or the services). Each keeps
its own licence; the full tree is in `pnpm-lock.yaml`.

| Project | Licence | Link |
|---|---|---|
| `@qorechain/pqc`, `@qorechain/qoresign`, `@qorechain/evm` | Apache-2.0 | https://github.com/qorechain/qorechain-pqc, https://github.com/qorechain/qoresign, https://github.com/qorechain/qorechain-sdk |
| `@noble/curves`, `@noble/ciphers` | MIT | https://github.com/paulmillr/noble-curves, https://github.com/paulmillr/noble-ciphers |
| `@scure/base`, `@scure/bip32`, `@scure/bip39`, `micro-key-producer` | MIT | https://github.com/paulmillr |
| `@cosmjs/amino`, `@cosmjs/crypto`, `@cosmjs/tendermint-rpc`, `@cosmjs/cosmwasm-stargate` | Apache-2.0 | https://github.com/cosmos/cosmjs |
| `bech32` | MIT | https://github.com/bitcoinjs/bech32 |

## Development and test tooling

| Project | Version | Licence | Link |
|---|---|---|---|
| TypeScript | 7.0.2 | Apache-2.0 | https://github.com/microsoft/TypeScript |
| tsx | 4.23.15 | MIT | https://github.com/privatenumber/tsx |
| Vitest | 5.1.0 | MIT | https://github.com/vitest-dev/vitest |
| `@types/node` | 26.6.6 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| pnpm | 11.1.2 | MIT | https://github.com/pnpm/pnpm |
| Node.js | 24 | MIT | https://github.com/nodejs/node |
| Gitleaks (secret scanning, pre-push hook) | | MIT | https://github.com/gitleaks/gitleaks |
| GitHub Actions used by CI: `actions/checkout`, `actions/setup-node`, `pnpm/action-setup` | | MIT | https://github.com/actions/checkout, https://github.com/actions/setup-node, https://github.com/pnpm/action-setup |
| GitHub Action `foundry-rs/foundry-toolchain` (CI) | | MIT OR Apache-2.0 | https://github.com/foundry-rs/foundry-toolchain |

## Smart contracts (`contracts/`)

| Project | Version | Licence | Link |
|---|---|---|---|
| Foundry (`forge`) | 1.8.3 | MIT OR Apache-2.0 | https://github.com/foundry-rs/foundry |
| Forge Standard Library (`forge-std`, git submodule at `contracts/lib/forge-std`) | 1.17.0 (`f3dae6e`) | MIT OR Apache-2.0 | https://github.com/foundry-rs/forge-std |
| Solidity compiler (`solc`, build tool only) | 0.8.28 | GPL-3.0 | https://github.com/argotorg/solidity |

## Deployment images

| Project | Image | Licence | Link |
|---|---|---|---|
| Caddy (serves the web app) | `caddy:2.11.8-alpine` (`apps/web/deploy/Dockerfile`) | Apache-2.0 | https://github.com/caddyserver/caddy |
| Node.js on Debian (keel, qledger-watchtower, exit-relayer) | `node:24-bookworm-slim` | MIT (Node.js); Debian packages under their own licences | https://github.com/nodejs/docker-node |

## Differential-fuzzing harness (`scripts/fuzz`)

`scripts/fuzz/setup.sh` fetches these at run time; none is vendored.

| Project | Licence | Link |
|---|---|---|
| QoreChain RDK for Go, Rust, Python and the JVM | Apache-2.0 | https://github.com/qorechain/qorechain-rdk |
| `qorechain-pqc` (Java) | Apache-2.0 | https://github.com/qorechain/qorechain-pqc |
| Bouncy Castle (`bcprov-jdk18on`) | Bouncy Castle Licence (MIT) | https://github.com/bcgit/bc-java |
| `serde_json`, `hex` (Rust crates) | MIT OR Apache-2.0 | https://github.com/serde-rs/json, https://github.com/KokaKiwi/rust-hex |
| uv (Python environments) | MIT OR Apache-2.0 | https://github.com/astral-sh/uv |

## Vendored files

- **`packages/chain-ws/descriptors/qorechain-diana.binpb`** is the chain's protobuf schemas as the
  `qorechain-diana` node returns them through gRPC reflection (provenance in `qorechain-diana.json`). The
  schemas come from:

  | Schemas | Project | Licence | Link |
  |---|---|---|---|
  | `qorechain/*` | QoreChain | Apache-2.0 | https://github.com/qorechain/qorechain-core |
  | `cosmos/*`, `amino/*` | Cosmos SDK | Apache-2.0 | https://github.com/cosmos/cosmos-sdk |
  | `tendermint/*` | CometBFT | Apache-2.0 | https://github.com/cometbft/cometbft |
  | `cosmos_proto/*` | cosmos-proto | Apache-2.0 | https://github.com/cosmos/cosmos-proto |
  | `gogoproto/*` | gogoproto | BSD-3-Clause | https://github.com/cosmos/gogoproto |
  | `google/protobuf/*` | Protocol Buffers | BSD-3-Clause | https://github.com/protocolbuffers/protobuf |
  | `google/api/*` | Google APIs | Apache-2.0 | https://github.com/googleapis/googleapis |

- **`contracts/lib/forge-std`** is a git submodule of forge-std (above), used by the Foundry tests only.

Thank you to everyone who maintains these projects.
