/**
 * Snapshot the chain's protobuf schemas, read from the node itself through
 * gRPC reflection (`/cosmos.reflection.v1.ReflectionService/FileDescriptors`,
 * over the websocket's `abci_query`).
 *
 * Keeps every `qorechain.*` and `cosmos.*` file plus everything they import,
 * and writes them as one FileDescriptorSet with a small provenance record:
 *
 *   descriptors/qorechain-diana.binpb
 *   descriptors/qorechain-diana.json   (height, chain, sha256, file count)
 *
 * Run: pnpm --filter @vigil/chain-ws snapshot [--url wss://…/websocket]
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { FileDescriptorSetSchema, type FileDescriptorProto } from "@bufbuild/protobuf/wkt";
import { WsRpc } from "../src/rpc.ts";

const args = process.argv.slice(2);
const url = args.includes("--url") ? args[args.indexOf("--url") + 1]! : "wss://rpc-testnet.qore.host/websocket";
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "descriptors");

const rpc = new WsRpc({ url, timeoutMs: 60_000 });
try {
  const status = await rpc.call<{ node_info: { network: string; version: string }; sync_info: { latest_block_height: string } }>("status");
  const res = await rpc.abciQuery("/cosmos.reflection.v1.ReflectionService/FileDescriptors", new Uint8Array());
  if (res.code !== 0) throw new Error(`reflection query failed (code ${res.code}): ${res.log}`);
  // FileDescriptorsResponse { repeated FileDescriptorProto files = 1 } has the same wire form as FileDescriptorSet.
  const all = fromBinary(FileDescriptorSetSchema, res.value).file;
  const byName = new Map(all.map((f) => [f.name, f]));

  const keep = new Set<string>();
  const visit = (f: FileDescriptorProto): void => {
    if (keep.has(f.name)) return;
    keep.add(f.name);
    for (const dep of f.dependency) {
      const d = byName.get(dep);
      if (!d) throw new Error(`${f.name} imports ${dep}, which the node did not return`);
      visit(d);
    }
  };
  for (const f of all) if (/^(qorechain|cosmos)\./.test(f.package)) visit(f);

  // Dependencies first, so any reader can resolve imports in one pass.
  const ordered: FileDescriptorProto[] = [];
  const done = new Set<string>();
  const place = (f: FileDescriptorProto): void => {
    if (done.has(f.name)) return;
    done.add(f.name);
    for (const dep of f.dependency) place(byName.get(dep)!);
    ordered.push(f);
  };
  for (const name of [...keep].sort()) place(byName.get(name)!);

  const bytes = toBinary(FileDescriptorSetSchema, create(FileDescriptorSetSchema, { file: ordered }));
  const meta = {
    chainId: status.node_info.network,
    nodeVersion: status.node_info.version,
    height: Number(status.sync_info.latest_block_height),
    source: `${url} abci_query /cosmos.reflection.v1.ReflectionService/FileDescriptors`,
    files: ordered.length,
    filesOnNode: all.length,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${meta.chainId}.binpb`), bytes);
  writeFileSync(join(out, `${meta.chainId}.json`), JSON.stringify(meta, null, 2) + "\n");
  console.log(JSON.stringify(meta));
} finally {
  rpc.close();
}
