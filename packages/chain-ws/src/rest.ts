/**
 * The node's REST API, answered over its websocket.
 *
 * Every Cosmos and QoreChain query carries its REST route in a `google.api.http`
 * option. `restOverWs` reads those routes from the chain's own descriptors, so a
 * request for `/qorechain/rdk/v1/batch/vigil-pay-1/3` becomes the gRPC query
 * `/qorechain.rdk.v1.Query/Batch` sent through `abci_query`. The answer is
 * decoded and written as the same JSON the REST gateway returns
 * (proto field names, defaults included, 64-bit integers as strings, bytes as
 * base64).
 *
 * Transactions are not module state: `/cosmos/tx/v1beta1/txs/{hash}` and
 * `/cosmos/tx/v1beta1/txs?query=…` are answered from CometBFT's own `tx` and
 * `tx_search`, and `/cosmos/base/node/v1beta1/status` from `status`.
 *
 * The result is a `fetch` replacement: hand it to any client that takes one
 * (for example the RDK's `RestClient` or `createRdkClient`).
 */
import { fromBinary, fromJson, toBinary, toJson, type DescField, type DescMessage, type DescMethod, type FileRegistry, type JsonObject, type JsonValue } from "@bufbuild/protobuf";
import { getOption, hasOption } from "@bufbuild/protobuf";
import { ScalarType } from "@bufbuild/protobuf";
import type { WsRpc } from "./rpc.ts";

export interface JsonResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type RestFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<JsonResponse>;

export interface Route {
  /** The REST template, for example `/qorechain/rdk/v1/batch/{rollup_id}/{batch_index}`. */
  template: string;
  /** The gRPC path, for example `/qorechain.rdk.v1.Query/Batch`. */
  grpcPath: string;
  method: DescMethod;
  regex: RegExp;
  vars: string[];
  literals: number;
}

function compile(template: string): { regex: RegExp; vars: string[]; literals: number } {
  const vars: string[] = [];
  let literals = 0;
  const parts = template
    .replace(/:[A-Za-z]+$/, "")
    .split("/")
    .filter((s, i) => i > 0 || s !== "")
    .map((seg) => {
      const v = /^\{([^}=]+)(?:=([^}]*))?\}$/.exec(seg);
      if (!v) {
        literals++;
        return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }
      vars.push(v[1]!);
      return v[2] && v[2].includes("**") ? "(.+)" : "([^/]+)";
    });
  return { regex: new RegExp(`^/${parts.join("/")}$`), vars, literals };
}

/** Every GET route the descriptors declare, most specific first. */
export function buildRoutes(registry: FileRegistry): Route[] {
  const http = registry.getExtension("google.api.http");
  if (!http) throw new Error("the descriptors do not include google/api/annotations.proto");
  const routes: Route[] = [];
  for (const file of registry.files) {
    for (const service of file.services) {
      for (const method of service.methods) {
        if (method.methodKind !== "unary" || !hasOption(method, http)) continue;
        const rule = getOption(method, http) as unknown as HttpRule;
        for (const r of [rule, ...(rule.additionalBindings ?? [])]) {
          if (r.pattern?.case !== "get" || typeof r.pattern.value !== "string") continue;
          routes.push({ template: r.pattern.value, grpcPath: `/${service.typeName}/${method.name}`, method, ...compile(r.pattern.value) });
        }
      }
    }
  }
  return routes.sort((a, b) => b.literals - a.literals || a.vars.length - b.vars.length);
}

interface HttpRule {
  pattern?: { case?: string; value?: unknown };
  additionalBindings?: HttpRule[];
}

/** Set `obj[a][b][c] = value` for the dotted proto path `a.b.c`, coercing to the field's JSON type. */
function setPath(desc: DescMessage, obj: JsonObject, path: string, raw: string): void {
  const names = path.split(".");
  let d: DescMessage | undefined = desc;
  let o: JsonObject = obj;
  for (let i = 0; i < names.length; i++) {
    const field: DescField | undefined = d?.fields.find((f) => f.name === names[i] || f.jsonName === names[i]);
    if (!field) return; // unknown query parameters are ignored, as the gateway does
    if (i < names.length - 1) {
      if (field.fieldKind !== "message") return;
      o = (o[field.name] ??= {}) as JsonObject;
      d = field.message;
      continue;
    }
    const scalar = field.fieldKind === "scalar" ? field.scalar : field.fieldKind === "list" && field.listKind === "scalar" ? field.scalar : undefined;
    const isEnum = field.fieldKind === "enum" || (field.fieldKind === "list" && field.listKind === "enum");
    const value = coerce(scalar, isEnum ? "enum" : undefined, raw);
    if (field.fieldKind === "list") ((o[field.name] ??= []) as JsonValue[]).push(value);
    else o[field.name] = value;
  }
}

function coerce(scalar: ScalarType | undefined, kind: "enum" | undefined, raw: string): JsonValue {
  if (kind === "enum") return /^-?\d+$/.test(raw) ? Number(raw) : raw;
  switch (scalar) {
    case ScalarType.BOOL:
      return raw === "true" || raw === "1";
    case ScalarType.INT32:
    case ScalarType.UINT32:
    case ScalarType.SINT32:
    case ScalarType.FIXED32:
    case ScalarType.SFIXED32:
    case ScalarType.DOUBLE:
    case ScalarType.FLOAT:
      return Number(raw);
    default:
      return raw; // strings, 64-bit integers and base64 bytes stay strings in proto JSON
  }
}

/**
 * The REST gateway (gogoproto jsonpb, defaults emitted) writes an unset message
 * field and an empty bytes field as `null`; protobuf-es omits the first and
 * writes `""` for the second. Walk the message type and write them as the
 * gateway does, through `Any` values too.
 */
function gatewayShape(desc: DescMessage, json: JsonValue, registry: FileRegistry): JsonValue {
  if (json === null || typeof json !== "object" || Array.isArray(json)) return json;
  if (desc.typeName === "google.protobuf.Any") {
    const t = json["@type"];
    const inner = typeof t === "string" ? registry.getMessage(t.slice(t.lastIndexOf("/") + 1)) : undefined;
    if (!inner || inner.typeName.startsWith("google.protobuf.")) return json;
    const { "@type": typeUrl, ...rest } = json;
    return { "@type": typeUrl ?? null, ...(gatewayShape(inner, rest, registry) as JsonObject) };
  }
  if (desc.typeName.startsWith("google.protobuf.")) return json; // well-known types keep their own JSON form
  const out: JsonObject = { ...json };
  for (const f of desc.fields) {
    const v = out[f.name];
    if (f.oneof && v === undefined) continue;
    if (f.fieldKind === "message") out[f.name] = v === undefined ? null : gatewayShape(f.message, v, registry);
    else if (f.fieldKind === "scalar" && f.scalar === ScalarType.BYTES && v === "") out[f.name] = null;
    else if (f.fieldKind === "list" && f.listKind === "message" && Array.isArray(v)) out[f.name] = v.map((x) => gatewayShape(f.message, x, registry));
    else if (f.fieldKind === "map" && f.mapKind === "message" && v && typeof v === "object" && !Array.isArray(v))
      out[f.name] = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, gatewayShape(f.message, x, registry)]));
  }
  return out;
}

const reply = (status: number, body: unknown, statusText = ""): JsonResponse => ({
  ok: status >= 200 && status < 300,
  status,
  statusText,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

/** gRPC status names inside an ABCI log, mapped to the HTTP status the gateway would use. */
function httpStatus(log: string): number {
  const m = /code = (\w+)/.exec(log);
  switch (m?.[1]) {
    case "NotFound":
      return 404;
    case "InvalidArgument":
    case "FailedPrecondition":
    case "OutOfRange":
      return 400;
    case "Unimplemented":
      return 501;
    case "Unauthenticated":
      return 401;
    case "PermissionDenied":
      return 403;
    default:
      return /not found/i.test(log) ? 404 : 500;
  }
}

const toB64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));
const hexToBytes = (h: string): Uint8Array => new Uint8Array((h.replace(/^0x/i, "").match(/../g) ?? []).map((x) => parseInt(x, 16)));
const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

interface CometTx {
  hash: string;
  height: string;
  index: number;
  tx: string;
  tx_result: {
    code?: number;
    data?: string;
    log?: string;
    info?: string;
    gas_wanted?: string;
    gas_used?: string;
    codespace?: string;
    events?: { type: string; attributes?: { key: string; value: string; index?: boolean }[] }[];
  };
}

export interface RestOverWsOptions {
  /** Read state at this height instead of the latest (module queries only). */
  height?: number;
}

/** A `fetch` that answers the node's REST routes over `rpc`, using `registry` (the chain's descriptors). */
export function restOverWs(rpc: WsRpc, registry: FileRegistry, opts: RestOverWsOptions = {}): RestFetch {
  const routes = buildRoutes(registry);
  const txDesc = registry.getMessage("cosmos.tx.v1beta1.Tx");
  const jsonOpts = { registry, useProtoFieldName: true, alwaysEmitImplicit: true } as const;

  const decodeTx = (b64: string): JsonValue | null => {
    if (!txDesc) return null;
    try {
      return gatewayShape(txDesc, toJson(txDesc, fromBinary(txDesc, fromB64(b64)), jsonOpts), registry);
    } catch {
      return null; // a message type the descriptors do not know
    }
  };
  const times = new Map<string, Promise<string>>();
  const blockTime = (height: string): Promise<string> => {
    let p = times.get(height);
    if (!p) {
      p = rpc
        .call<{ header: { time: string } }>("header", { height })
        .then((h) => h.header.time.replace(/\.\d+Z$/, "Z"))
        .catch(() => "");
      times.set(height, p);
    }
    return p;
  };
  const toHexUpper = (b64: string): string => Array.from(fromB64(b64), (x) => x.toString(16).padStart(2, "0")).join("").toUpperCase();
  const txResponse = (t: CometTx, tx: JsonValue | null, timestamp: string): JsonObject => ({
    height: String(t.height),
    txhash: t.hash.toUpperCase(),
    codespace: t.tx_result.codespace ?? "",
    code: t.tx_result.code ?? 0,
    data: t.tx_result.data ? toHexUpper(t.tx_result.data) : "",
    raw_log: t.tx_result.log ?? "",
    logs: [],
    info: t.tx_result.info ?? "",
    gas_wanted: String(t.tx_result.gas_wanted ?? "0"),
    gas_used: String(t.tx_result.gas_used ?? "0"),
    tx: tx && typeof tx === "object" && !Array.isArray(tx) ? { "@type": "/cosmos.tx.v1beta1.Tx", ...tx } : null,
    timestamp,
    events: (t.tx_result.events ?? []).map((e) => ({
      type: e.type,
      attributes: (e.attributes ?? []).map((a) => ({ key: a.key, value: a.value, index: a.index ?? false })),
    })),
  });

  async function txRoute(path: string, q: URLSearchParams): Promise<JsonResponse> {
    const one = /^\/cosmos\/tx\/v1beta1\/txs\/([0-9A-Fa-f]{64})$/.exec(path);
    if (one) {
      try {
        const t = await rpc.call<CometTx>("tx", { hash: toB64(hexToBytes(one[1]!)), prove: false });
        const tx = decodeTx(t.tx);
        return reply(200, { tx, tx_response: txResponse(t, tx, await blockTime(t.height)) });
      } catch (e) {
        return reply(/not found/i.test(String(e)) ? 404 : 500, { code: 5, message: String(e) }, "tx lookup failed");
      }
    }
    const query = q.get("query") ?? q.getAll("events").join(" AND ");
    if (!query) return reply(400, { code: 3, message: "query is required" });
    const page = Math.max(1, Number(q.get("page") ?? q.get("pagination.offset") ?? 1));
    const perPage = Math.min(100, Math.max(1, Number(q.get("limit") ?? q.get("pagination.limit") ?? 100)));
    const order = /DESC/i.test(q.get("order_by") ?? "") ? "desc" : "asc";
    try {
      const r = await rpc.call<{ txs: CometTx[]; total_count: string }>("tx_search", { query, prove: false, page: String(page), per_page: String(perPage), order_by: order });
      const decoded = r.txs.map((t) => decodeTx(t.tx));
      const stamps = await Promise.all(r.txs.map((t) => blockTime(t.height)));
      return reply(200, {
        txs: decoded,
        tx_responses: r.txs.map((t, i) => txResponse(t, decoded[i] ?? null, stamps[i] ?? "")),
        pagination: null,
        total: String(r.total_count ?? r.txs.length),
      });
    } catch (e) {
      // CometBFT answers a page past the end with an error; the gateway answers an empty page.
      if (/page should be within/i.test(String(e))) return reply(200, { txs: [], tx_responses: [], pagination: null, total: "0" });
      return reply(500, { code: 13, message: String(e) }, "tx search failed");
    }
  }

  return async (url, init) => {
    if ((init?.method ?? "GET").toUpperCase() !== "GET") return reply(405, { code: 12, message: "only GET routes are served over the websocket" });
    const u = new URL(url, "http://node.invalid");
    const path = u.pathname.replace(/\/+$/, "") || "/";

    if (path.startsWith("/cosmos/tx/v1beta1/txs")) return txRoute(path, u.searchParams);
    if (path === "/cosmos/base/node/v1beta1/status") {
      const s = await rpc.call<{ sync_info: { latest_block_height: string; latest_block_time: string; latest_app_hash: string } }>("status");
      return reply(200, {
        earliest_store_height: "0",
        height: s.sync_info.latest_block_height,
        timestamp: s.sync_info.latest_block_time,
        app_hash: s.sync_info.latest_app_hash ? toB64(hexToBytes(s.sync_info.latest_app_hash)) : "",
        validator_hash: "",
      });
    }

    for (const route of routes) {
      const m = route.regex.exec(path);
      if (!m) continue;
      const input = route.method.input;
      const body: JsonObject = {};
      route.vars.forEach((v, i) => setPath(input, body, v, decodeURIComponent(m[i + 1]!)));
      for (const [k, v] of u.searchParams) if (!route.vars.includes(k)) setPath(input, body, k, v);
      let request: Uint8Array;
      try {
        request = toBinary(input, fromJson(input, body, { registry, ignoreUnknownFields: true }));
      } catch (e) {
        return reply(400, { code: 3, message: `bad request for ${route.template}: ${String(e)}` });
      }
      const res = await rpc.abciQuery(route.grpcPath, request, opts.height);
      if (res.code !== 0) return reply(httpStatus(res.log), { code: res.code, message: res.log, details: [] }, res.log);
      const out = route.method.output;
      return reply(200, gatewayShape(out, toJson(out, fromBinary(out, res.value), jsonOpts), registry));
    }
    return reply(501, { code: 12, message: `no gRPC route for ${path}` }, "Not Implemented");
  };
}
