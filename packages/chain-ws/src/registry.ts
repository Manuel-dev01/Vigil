/**
 * The chain's protobuf schemas as a registry.
 *
 * `descriptors/qorechain-diana.binpb` is a snapshot of the node's own gRPC
 * reflection (see `scripts/snapshot-descriptors.ts` and the `.json` beside it
 * for the height and SHA-256). Pass its bytes here; a browser app imports the
 * file as an asset and fetches it, Node reads it from disk.
 */
import { createFileRegistry, fromBinary, type FileRegistry } from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";

export function chainRegistry(descriptorSet: Uint8Array): FileRegistry {
  return createFileRegistry(fromBinary(FileDescriptorSetSchema, descriptorSet));
}

/** SHA-256 of the bytes, hex, to compare with the snapshot's recorded hash. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  return Array.from(d, (x) => x.toString(16).padStart(2, "0")).join("");
}
