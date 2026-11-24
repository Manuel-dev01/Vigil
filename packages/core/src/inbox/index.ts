/**
 * The rollup inbox reader shared by Keel, its keep-alive pulse, the CLI tools
 * and the exit relayer: entries by sequence, checked against the chain's
 * inbox accumulator, with an archive for what the chain has pruned.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InboxArchive, readArchiveFile, type InboxEnv } from "./archive.ts";
import { InboxReader, type InboxLog } from "./reader.ts";
import { restInboxSource, type InboxSource, type RestInboxSourceOptions } from "./source.ts";

export { EMPTY_ACC, InboxArchive, accumulate, parseArchive, readArchiveFile, toEntry, type ArchivedEntry, type InboxEnv } from "./archive.ts";
export { InboxMismatchError, InboxReader, PrunedEntryError, type InboxLog, type ReadResult } from "./reader.ts";
export { depositEventsOf, restInboxSource, type DepositEvent, type InboxHead, type InboxSource, type PostedData, type RequestCounts, type RestInboxSourceOptions } from "./source.ts";
export { findPayload, lengthDelimitedFields } from "./protobuf.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** The repository's committed archive for a rollup: `data/inbox/<rollupId>.jsonl`. */
export function committedArchivePath(rollupId: string): string {
  return resolve(repoRoot, "data/inbox", `${rollupId}.jsonl`);
}

export interface OpenInboxOptions extends RestInboxSourceOptions {
  /** The service's own archive (on its volume), written as entries are confirmed. Undefined keeps it in memory. */
  archivePath?: string;
  /** Read-only archives that may extend it, oldest data first (default: the repository's committed archive). */
  seeds?: string[];
  /** Serve chain data from here instead of REST (tests). */
  source?: InboxSource;
  log?: InboxLog;
}

/**
 * A reader over the service's archive, extended from the seed archives (their
 * rows stay unconfirmed until the chain confirms them), reading the chain over
 * REST.
 */
export function openInboxReader(env: InboxEnv, opts: OpenInboxOptions = {}): InboxReader {
  const log = opts.log ?? (() => {});
  const archive = new InboxArchive(env, opts.archivePath);
  if (archive.loadProblem) log("inbox_archive_repaired", { problem: archive.loadProblem });
  for (const seed of opts.seeds ?? [committedArchivePath(env.rollupId)]) {
    if (!existsSync(seed) || (opts.archivePath && resolve(seed) === resolve(opts.archivePath))) continue;
    const { rows, problem } = readArchiveFile(seed);
    const r = archive.extend(rows);
    if (r.added > 0 || problem || r.problem) log("inbox_archive_seeded", { seed, added: r.added, head: archive.head, ...((problem ?? r.problem) && { problem: problem ?? r.problem }) });
  }
  const source = opts.source ?? restInboxSource(env.rollupId, opts);
  return new InboxReader(env, source, { archive, log });
}
