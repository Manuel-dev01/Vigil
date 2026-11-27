/**
 * Showing one payslip to someone without a key: its data key.
 *
 * A QoreSeal envelope encrypts the payslip once, with AES-256-GCM under a random 32-byte data key, and
 * wraps that data key for each recipient (ML-KEM-1024 with X25519). A recipient who unwraps it can hand
 * the data key to someone else, a landlord or a lender:
 * - it opens this one envelope and nothing else: not the recipient's other payslips, and it cannot sign
 *   or spend;
 * - it needs no seal key and no wallet;
 * - it cannot be revoked, because the envelope stays on chain and in the public inbox archive.
 *
 * QoreSeal 0.1.0's open() unwraps the data key inside and does not return it. payslipDataKey repeats
 * that unwrap with QoreSeal's exported primitives (parseEnvelope, recipientHint, mlkemDecapsulate,
 * x25519Agree, hybridSharedSecret, deriveKey) and AES-256-GCM from @noble/ciphers, the cipher QoreSeal itself uses,
 * and returns the key only once it has decrypted the payload. test/disclose.test.ts checks it against
 * openPayslip on envelopes sealed to throwaway keys.
 *
 * AES-GCM is not key-committing: whoever builds an envelope could make it open, under two different
 * data keys, to two different payslips. The amount paid stays anchored by the public ML-DSA-44
 * transfer, which a disclosure checks (THREAT_MODEL.md section 13).
 */
import { gcm } from "@noble/ciphers/aes.js";
import {
  ENTRY_LENGTH,
  deriveKey,
  fromBase64Url,
  hybridSharedSecret,
  mlkemDecapsulate,
  parseEnvelope,
  recipientHint,
  toBase64Url,
  x25519Agree,
  type SealKeyPair,
} from "@qorechain/qoreseal";
import { PAYSLIP_PURPOSE, checkPayslipShape, sealedLaneAad, type Payslip } from "./payslip.ts";

export const DATA_KEY_BYTES = 32;
/** A data key in a link: base64url without padding, 43 characters. */
const DATA_KEY_TEXT = /^[A-Za-z0-9_-]{43}$/;
/** QoreSeal wraps each data key under a fresh key-encryption key with an all-zero 96-bit nonce. */
const WRAP_NONCE = new Uint8Array(12);
const dec = new TextDecoder();

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

function attempt<T>(f: () => T): T | undefined {
  try {
    return f();
  } catch {
    return undefined;
  }
}

/** The envelope's payload, decrypted with its data key for `rollupId`. Throws if it does not authenticate. */
function decryptPayload(envelope: Uint8Array, dataKey: Uint8Array, rollupId: string): Uint8Array {
  if (dataKey.length !== DATA_KEY_BYTES) throw new Error(`a data key is ${DATA_KEY_BYTES} bytes, not ${dataKey.length}`);
  const env = parseEnvelope(envelope);
  // The payload's additional data is the envelope header followed by the caller's AAD, here the rollup binding.
  return gcm(dataKey, env.nonce, concat(env.header, sealedLaneAad(rollupId))).decrypt(env.ciphertext);
}

/**
 * The 32-byte data key of a payslip envelope, unwrapped with a recipient's seal keys. Throws if these keys
 * open no entry of the envelope, or if the payload does not open for this chain and rollup.
 */
export function payslipDataKey(input: { chainId: string; rollupId: string; envelope: Uint8Array; keys: SealKeyPair }): Uint8Array {
  const env = parseEnvelope(input.envelope);
  // Each wrapped key authenticates the envelope's fixed header (magic, version, algorithms, flags, salt,
  // recipient count): the header less its recipient entries and the payload nonce.
  const fixed = env.header.subarray(0, env.header.length - env.entries.length * ENTRY_LENGTH[env.mode] - env.nonce.length);
  // As open() does: an anonymous envelope (payslips are) has no hints, so every entry is tried and a wrong
  // one fails its tag; otherwise only the entries whose recipient hint is this key's.
  const myHint = recipientHint(env.salt, input.keys.mlkemPublicKey);
  const candidates = env.anonymous ? env.entries : env.entries.filter((e) => sameBytes(e.hint, myHint));
  for (const e of candidates) {
    const dataKey = attempt(() => {
      let shared = mlkemDecapsulate(input.keys.mlkemSecretKey, e.mlkemCiphertext);
      if (env.mode === "hybrid") {
        if (!e.x25519Ciphertext) throw new Error("a hybrid entry without its X25519 part");
        shared = hybridSharedSecret({
          mlkemSharedSecret: shared,
          x25519SharedSecret: x25519Agree(input.keys.x25519SecretKey, e.x25519Ciphertext),
          x25519Ciphertext: e.x25519Ciphertext,
          x25519PublicKey: input.keys.x25519PublicKey,
        });
      }
      const kek = deriveKey({ shared, chainId: input.chainId, purpose: PAYSLIP_PURPOSE, salt: env.salt });
      const aad = e.x25519Ciphertext ? concat(fixed, e.hint, e.mlkemCiphertext, e.x25519Ciphertext) : concat(fixed, e.hint, e.mlkemCiphertext);
      return gcm(kek, WRAP_NONCE, aad).decrypt(e.wrappedKey);
    });
    if (dataKey && attempt(() => decryptPayload(input.envelope, dataKey, input.rollupId))) return dataKey;
  }
  throw new Error("no entry of this envelope opens with this key for this chain and rollup");
}

/**
 * A payslip opened with its data key alone. Checks its form and its rollup, but not that its lines add
 * up to the payment: a disclosure shows that as a check of its own. Throws if the key does not open it.
 */
export function openPayslipWithDataKey(input: { rollupId: string; envelope: Uint8Array; dataKey: Uint8Array }): Payslip {
  const plaintext = attempt(() => decryptPayload(input.envelope, input.dataKey, input.rollupId));
  if (!plaintext) throw new Error(`this key does not open the envelope (or it is not sealed for ${input.rollupId})`);
  const p = checkPayslipShape(JSON.parse(dec.decode(plaintext)) as Payslip);
  if (p.rollupId !== input.rollupId) throw new Error(`the payslip names rollup ${p.rollupId}, not ${input.rollupId}`);
  return p;
}

/** A data key as link text: base64url, no padding, 43 characters. */
export const dataKeyToText = (dataKey: Uint8Array): string => {
  if (dataKey.length !== DATA_KEY_BYTES) throw new Error(`a data key is ${DATA_KEY_BYTES} bytes, not ${dataKey.length}`);
  return toBase64Url(dataKey);
};

/**
 * The web app's link to one payslip, after its address: `#/payslip?entry=<n>&dk=<data key>`. Browsers do
 * not send the part after "#" to the server, so the key reaches only the page.
 */
export const shareFragment = (entry: number, dataKey: Uint8Array): string => `#/payslip?entry=${entry}&dk=${dataKeyToText(dataKey)}`;

/** The whole link: the web app's address `base` (any "#" part replaced) with the fragment of shareFragment. */
export function shareLink(base: string | URL, entry: number, dataKey: Uint8Array): string {
  const u = new URL(base);
  u.hash = shareFragment(entry, dataKey).slice(1);
  return u.href;
}

/** The inverse of dataKeyToText; throws on anything that is not exactly a 32-byte key. */
export function dataKeyFromText(text: string): Uint8Array {
  if (!DATA_KEY_TEXT.test(text)) throw new Error("a data key is 43 characters of base64url");
  const key = attempt(() => fromBase64Url(text));
  if (!key || key.length !== DATA_KEY_BYTES) throw new Error("a data key is 43 characters of base64url");
  return key;
}
