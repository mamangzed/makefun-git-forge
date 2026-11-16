// git.ts — git smart HTTP: pkt-line codec, packfile read/write, and the
// upload-pack (v0 + v2) / receive-pack (v0) protocol handlers.
//
// Plain objects only in generated packs (no deltas); incoming packs may
// carry ofs/ref deltas and are resolved here.

import { inflateSync, deflateSync } from 'node:zlib';
import { objectId, sha1Hex, ZERO_OID, parseCommit, parseTree, parseTag } from './store.ts';
import type { Store, Repo, ObjType, GitObject } from './store.ts';

// ---- pkt-line --------------------------------------------------------------

export type Pkt = { kind: 'data' | 'flush' | 'delim' | 'response_end'; payload: Buffer };

export function encodePktLine(payload: Buffer): Buffer {
  const len = payload.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'utf8');
  return Buffer.concat([head, payload]);
}

export function encodeFlush(): Buffer {
  return Buffer.from('0000', 'utf8');
}

export function encodeDelim(): Buffer {
  return Buffer.from('0001', 'utf8');
}

export function encodeResponseEnd(): Buffer {
  return Buffer.from('0002', 'utf8');
}

export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const hex = buf.subarray(off, off + 4).toString('ascii');
    const len = parseInt(hex, 16);
    if (!Number.isFinite(len) || len < 0) break;
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len === 2) {
      out.push({ kind: 'response_end', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (off + len > buf.length) break;
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return out;
}

export function textPkt(text: string): Buffer {
  return encodePktLine(Buffer.from(text, 'utf8'));
}

// ---- packfile --------------------------------------------------------------

// Object header: (type << 4 | size-low) then size continuation bytes.
function readVarintHeader(buf: Buffer, off: number): { type: number; size: number; next: number } {
  let byte = buf[off];
  const type = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  let i = off + 1;
  while (byte & 0x80) {
    byte = buf[i];
    size |= (byte & 0x7f) << shift;
    shift += 7;
    i += 1;
  }
  return { type, size, next: i };
}

function writeVarintHeader(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let byte = (type << 4) | (size & 0x0f);
  size >>= 4;
  while (size > 0) {
    bytes.push(byte | 0x80);
    byte = size & 0x7f;
    size >>= 7;
  }
  bytes.push(byte);
  return Buffer.from(bytes);
}

const TYPE_NAME: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_NUM: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function readOfsOffset(buf: Buffer, off: number): { value: number; next: number } {
  let byte = buf[off];
  let value = byte & 0x7f;
  let i = off + 1;
  while (byte & 0x80) {
    byte = buf[i];
    value = ((value + 1) << 7) | (byte & 0x7f);
    i += 1;
  }
  return { value, next: i };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    while (true) {
      const byte = delta[off++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const srcSize = readVarint();
  const dstSize = readVarint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const parts: Buffer[] = [];
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i++) {
        if (op & (1 << i)) cpOff |= delta[off++] << (8 * i);
      }
      for (let i = 0; i < 3; i++) {
        if (op & (0x10 << i)) cpSize |= delta[off++] << (8 * i);
      }
      if (cpSize === 0) cpSize = 0x10000;
      parts.push(base.subarray(cpOff, cpOff + cpSize));
    } else if (op > 0) {
      parts.push(delta.subarray(off, off + op));
      off += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== dstSize) throw new Error('delta result size mismatch');
  return out;
}

/** Inflate one zlib stream starting at `off`; returns its bytes and the
 * offset just past the stream. Node's sync inflate reports how many input
 * bytes it consumed only when called with `{ info: true }`. */
function inflateAt(buf: Buffer, off: number): { data: Buffer; next: number } {
  const result = inflateSync(buf.subarray(off), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: off + result.engine.bytesWritten };
}

export interface PackEntry {
  oid: string;
  type: ObjType;
  data: Buffer;
}

/** Parse a packfile (version 2). Supports plain objects and ofs/ref deltas. */
export function parsePack(buf: Buffer): PackEntry[] {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const byOffset = new Map<number, PackEntry>();
  const byOid = new Map<string, PackEntry>();
  const pending: Array<{ offset: number; type: ObjType; data: Buffer; base: string | number }> = [];
  let off = 12;
  for (let n = 0; n < count; n++) {
    const start = off;
    const head = readVarintHeader(buf, off);
    off = head.next;
    let type = head.type;
    let baseRef: string | number | null = null;
    if (type === 6) {
      const r = readOfsOffset(buf, off);
      baseRef = start - r.value;
      off = r.next;
    } else if (type === 7) {
      baseRef = buf.subarray(off, off + 20).toString('hex');
      off += 20;
    }
    const inflated = inflateAt(buf, off);
    off = inflated.next;
    const data = inflated.data;
    if (type === 6 || type === 7) {
      pending.push({ offset: start, type: 'blob', data, base: baseRef as string | number });
      continue;
    }
    const name = TYPE_NAME[type];
    if (!name) throw new Error(`unknown object type ${type}`);
    const oid = objectId(name, data);
    const entry: PackEntry = { oid, type: name, data };
    byOffset.set(start, entry);
    byOid.set(oid, entry);
  }
  // Resolve deltas (repeated passes; chains are short).
  let guard = 0;
  while (pending.length > 0 && guard < 1000) {
    guard += 1;
    const item = pending.shift()!;
    let base: PackEntry | undefined;
    if (typeof item.base === 'number') base = byOffset.get(item.base);
    else base = byOid.get(item.base);
    if (!base) {
      pending.push(item);
      continue;
    }
    const data = applyDelta(base.data, item.data);
    const oid = objectId(base.type, data);
    const entry: PackEntry = { oid, type: base.type, data };
    byOffset.set(item.offset, entry);
    byOid.set(oid, entry);
  }
  if (pending.length > 0) throw new Error('unresolved delta base');
  return [...byOid.values()];
}

/** Serialize objects as a version-2 packfile (plain entries, no deltas). */
export function writePack(entries: Array<{ type: ObjType; data: Buffer }>): Buffer {
  const chunks: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(entries.length, 8);
  chunks.push(head);
  for (const e of entries) {
    chunks.push(writeVarintHeader(TYPE_NUM[e.type], e.data.length));
    chunks.push(deflateSync(e.data));
  }
  const body = Buffer.concat(chunks);
  const trailer = Buffer.from(sha1Hex(body), 'hex');
  return Buffer.concat([body, trailer]);
}

/** Object id for a stored object, recomputed from its bytes. */
export function storePackObjects(repo: Repo, entries: PackEntry[]): void {
  for (const e of entries) {
    if (!repo.objects.has(e.oid)) repo.objects.set(e.oid, { type: e.type, data: e.data });
  }
}

// ---- sideband --------------------------------------------------------------

export function sidebandPacket(band: number, data: Buffer): Buffer {
  const payload = Buffer.concat([Buffer.from([band]), data]);
  return encodePktLine(payload);
}

/** Split a byte stream into sideband band-1 packets. A pkt-line is at most
 * 65520 bytes total, so the payload (band byte + data) is at most 65516
 * and each data chunk at most 65515 bytes. */
export function sidebandStream(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let off = 0; off < data.length; off += 65515) {
    parts.push(sidebandPacket(1, data.subarray(off, Math.min(off + 65515, data.length))));
  }
  if (parts.length === 0) parts.push(sidebandPacket(1, Buffer.alloc(0)));
  parts.push(encodeFlush());
  return Buffer.concat(parts);
}

// ---- reachability ----------------------------------------------------------

export interface FetchPlan {
  objects: PackEntry[];
  shallow: string[];
  unshallow: string[];
}

/** Objects reachable from `wants`, minus those reachable from `haves`. */
export function planFetch(
  store: Store,
  repo: Repo,
  wants: string[],
  haves: string[],
  depth: number | null,
  oldShallow: string[],
): FetchPlan {
  const shallowSet = new Set(oldShallow);
  // H: what the client already holds. Walk ancestors of the haves, but
  // never past an old shallow boundary: the client does not have that
  // commit's parents, so a deepen must still deliver them.
  const haveReach = new Set<string>();
  const hq: string[] = [];
  for (const h of haves) {
    const tip = store.resolveToCommit(repo, h);
    if (tip) hq.push(tip);
  }
  for (let qi = 0; qi < hq.length; qi++) {
    const oid = hq[qi];
    if (haveReach.has(oid)) continue;
    haveReach.add(oid);
    if (shallowSet.has(oid)) continue;
    const commit = store.getCommit(repo, oid);
    if (!commit) continue;
    for (const p of commit.parents) hq.push(p);
  }
  // D: depth-limited walk from the wants (unlimited when depth is null).
  const included = new Map<string, number>(); // commit oid -> depth from a want
  const boundary = new Set<string>();
  const queue: Array<[string, number]> = [];
  for (const w of wants) {
    const tip = store.resolveToCommit(repo, w);
    if (tip) queue.push([tip, 1]);
    else if (repo.objects.has(w)) included.set(w, 0);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const [oid, d] = queue[qi];
    if (included.has(oid)) continue;
    const commit = store.getCommit(repo, oid);
    if (!commit) continue;
    included.set(oid, d);
    if (depth !== null && d >= depth) {
      boundary.add(oid);
      continue;
    }
    for (const p of commit.parents) queue.push([p, d + 1]);
  }
  // Boundary commits are included (their parents are cut off).
  const shallow = [...boundary].sort();
  // Unshallow: old boundaries whose parents are now all in the walk.
  const unshallow: string[] = [];
  for (const s of oldShallow) {
    if (included.has(s)) {
      const commit = store.getCommit(repo, s);
      const parentsIncluded = commit ? commit.parents.every((p) => included.has(p)) : false;
      if (parentsIncluded) unshallow.push(s);
    }
  }
  // Deliver D minus H, over the full object closure: an object the client
  // already holds (reachable from a have) is never re-sent, even a blob
  // shared with a new commit's tree. H stops at shallow boundaries.
  const deliver = new Set<string>();
  const collectClosure = (commitOids: Iterable<string>, into: Set<string>) => {
    const seenTrees = new Set<string>();
    const walkTree = (treeOid: string) => {
      if (seenTrees.has(treeOid)) return;
      seenTrees.add(treeOid);
      into.add(treeOid);
      const obj = repo.objects.get(treeOid);
      if (!obj || obj.type !== 'tree') return;
      for (const e of parseTree(obj.data)) {
        if (e.mode === '40000') walkTree(e.oid);
        else into.add(e.oid);
      }
    };
    for (const oid of commitOids) {
      into.add(oid);
      const commit = store.getCommit(repo, oid);
      if (commit) walkTree(commit.tree);
    }
  };
  // D: depth-limited commits from the wants, plus their closure.
  const dCommits = new Set<string>([...included.keys()].filter((oid) => store.getCommit(repo, oid) !== null));
  const dClosure = new Set<string>();
  collectClosure(dCommits, dClosure);
  // Tags wanted directly, plus their targets.
  for (const w of wants) {
    const obj = repo.objects.get(w);
    if (obj && obj.type === 'tag') {
      dClosure.add(w);
      const target = parseTag(obj.data).object;
      const tip = store.resolveToCommit(repo, target);
      if (tip) collectClosure([tip], dClosure);
    }
  }
  // H: everything reachable from the haves (already computed as commits
  // in haveReach, with their closure).
  const hClosure = new Set<string>();
  collectClosure(haveReach, hClosure);
  for (const oid of dClosure) {
    if (!hClosure.has(oid)) deliver.add(oid);
  }
  const objects: PackEntry[] = [...deliver]
    .map((oid) => {
      const obj = repo.objects.get(oid)!;
      return { oid, type: obj.type, data: obj.data };
    })
    .sort((a, b) => (a.oid < b.oid ? -1 : 1));
  return { objects, shallow, unshallow };
}

// ---- advertisements -------------------------------------------------------

export interface RefLine {
  oid: string;
  name: string;
  symrefTarget?: string;
  peeled?: string;
  unborn?: boolean;
}

/** All refs of a repo, in git advertisement order (HEAD first). */
export function refLines(store: Store, repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const tip = repo.refs.get(defaultRef);
  out.push({
    oid: tip ?? ZERO_OID,
    name: 'HEAD',
    symrefTarget: defaultRef,
    unborn: tip ? undefined : true,
  });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const line: RefLine = { oid, name };
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'tag') {
      line.peeled = store.resolveToCommit(repo, oid) ?? undefined;
    }
    out.push(line);
  }
  return out;
}

function v0Capabilities(service: string): string {
  if (service === 'upload-pack') {
    return 'side-band-64k thin-pack ofs-delta multi_ack multi_ack_detailed shallow symref=HEAD:refs/heads/main agent=makefun-forge/1.0';
  }
  return 'report-status report-status-v2 side-band-64k delete-refs ofs-delta quiet agent=makefun-forge/1.0';
}

export function v0Advertisement(store: Store, repo: Repo, service: string): Buffer {
  const parts: Buffer[] = [];
  parts.push(textPkt(`# service=git-${service}\n`));
  parts.push(encodeFlush());
  const caps = v0Capabilities(service);
  const refs = refLines(store, repo);
  if (refs.length === 1 && refs[0].unborn) {
    parts.push(textPkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    for (const r of refs) {
      const suffix = first ? `\0${caps}` : '';
      first = false;
      parts.push(textPkt(`${r.oid} ${r.name}${suffix}\n`));
      if (r.peeled) parts.push(textPkt(`${r.peeled} ${r.name}^{}\n`));
    }
  }
  parts.push(encodeFlush());
  return Buffer.concat(parts);
}

export function v2Advertisement(): Buffer {
  const parts: Buffer[] = [
    textPkt('version 2\n'),
    textPkt('ls-refs=unborn\n'),
    textPkt('fetch=shallow wait-for-done filter\n'),
    textPkt('server-option\n'),
    textPkt('object-format=sha1\n'),
    textPkt('agent=makefun-forge/1.0\n'),
    encodeFlush(),
  ];
  return Buffer.concat(parts);
}

// ---- ls-refs ---------------------------------------------------------------

export function handleLsRefs(
  store: Store,
  repo: Repo,
  args: string[],
): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes: string[] = [];
  for (const a of args) {
    if (a.startsWith('ref-prefix ')) prefixes.push(a.slice('ref-prefix '.length));
  }
  const match = (name: string) => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  for (const r of refLines(store, repo)) {
    if (!match(r.name)) continue;
    if (r.unborn && !unborn) continue;
    const tokens: string[] = [];
    if (r.unborn) {
      tokens.push('unborn', r.name);
    } else {
      tokens.push(r.oid, r.name);
    }
    if (symrefs && r.symrefTarget) tokens.push(`symref-target:${r.symrefTarget}`);
    if (peel && r.peeled) tokens.push(`peeled:${r.peeled}`);
    parts.push(textPkt(tokens.join(' ') + '\n'));
  }
  parts.push(encodeFlush());
  return Buffer.concat(parts);
}

// ---- fetch -----------------------------------------------------------------

export function handleFetchV2(
  store: Store,
  repo: Repo,
  args: string[],
): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowArgs: string[] = [];
  let depth: number | null = null;
  for (const a of args) {
    const tok = a.split(' ');
    if (tok[0] === 'want' && tok[1]) wants.push(tok[1]);
    else if (tok[0] === 'have' && tok[1]) haves.push(tok[1]);
    else if (tok[0] === 'shallow' && tok[1]) shallowArgs.push(tok[1]);
    else if (tok[0] === 'deepen') {
      const n = parseInt(tok[1] ?? '', 10);
      if (Number.isFinite(n)) depth = n;
    }
  }
  const plan = planFetch(store, repo, wants, haves, depth, shallowArgs);
  const parts: Buffer[] = [];
  // The acknowledgments section is only sent when the client offered
  // haves; a fresh clone expects the packfile section first.
  if (haves.length > 0) {
    parts.push(textPkt('acknowledgments\n'));
    let anyAck = false;
    for (const h of haves) {
      if (repo.objects.has(h)) {
        parts.push(textPkt(`ACK ${h}\n`));
        anyAck = true;
      }
    }
    if (!anyAck) parts.push(textPkt('NAK\n'));
    // The client sent `done`: signal that negotiation is over and the
    // packfile follows. Without `ready`, git keeps negotiating.
    parts.push(textPkt('ready\n'));
    parts.push(encodeDelim());
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(textPkt('shallow-info\n'));
    for (const s of plan.shallow) parts.push(textPkt(`shallow ${s}\n`));
    for (const s of plan.unshallow) parts.push(textPkt(`unshallow ${s}\n`));
    parts.push(encodeDelim());
  }
  parts.push(textPkt('packfile\n'));
  const pack = writePack(plan.objects);
  parts.push(sidebandStream(pack));
  return Buffer.concat(parts);
}

export function handleFetchV0(
  store: Store,
  repo: Repo,
  body: Buffer,
): Buffer {
  const packets = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowArgs: string[] = [];
  let depth: number | null = null;
  let seenFlush = false;
  for (const p of packets) {
    if (p.kind === 'flush') {
      seenFlush = true;
      continue;
    }
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').trim();
    const bare = line.split('\0')[0];
    const tok = bare.split(' ');
    if (!seenFlush) {
      if (tok[0] === 'want' && tok[1]) wants.push(tok[1]);
      else if (tok[0] === 'shallow' && tok[1]) shallowArgs.push(tok[1]);
      else if (tok[0] === 'deepen') {
        const n = parseInt(tok[1] ?? '', 10);
        if (Number.isFinite(n)) depth = n;
      }
    } else {
      if (tok[0] === 'have' && tok[1]) haves.push(tok[1]);
    }
  }
  const plan = planFetch(store, repo, wants, haves, depth, shallowArgs);
  const parts: Buffer[] = [];
  // Protocol v0 order: shallow/unshallow lines first, terminated by a
  // flush, then ACK/NAK, then the pack. (v0 always leads with NAK when
  // nothing was acknowledged — even when the client sent no haves.)
  for (const s of plan.shallow) parts.push(textPkt(`shallow ${s}\n`));
  for (const s of plan.unshallow) parts.push(textPkt(`unshallow ${s}\n`));
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) parts.push(encodeFlush());
  let anyAck = false;
  for (const h of haves) {
    if (repo.objects.has(h)) {
      parts.push(textPkt(`ACK ${h}\n`));
      anyAck = true;
    }
  }
  if (!anyAck) parts.push(textPkt('NAK\n'));
  const pack = writePack(plan.objects);
  parts.push(sidebandStream(pack));
  return Buffer.concat(parts);
}

// ---- receive-pack ----------------------------------------------------------

export interface PushResult {
  ok: boolean;
  report: string;
}

export function handleReceivePack(
  store: Store,
  repo: Repo,
  body: Buffer,
): PushResult {
  // Split command pkt-lines from the pack: commands end at the first flush.
  const packets = decodePktLines(body);
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let flushEnd = -1;
  let scan = 0;
  for (const p of packets) {
    if (p.kind === 'flush') {
      flushEnd = scan;
      break;
    }
    if (p.kind === 'data') {
      const line = p.payload.toString('utf8').split('\0')[0].trim();
      const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
      if (m) commands.push({ oldOid: m[1], newOid: m[2], ref: m[3] });
    }
    scan += p.payload.length + 4;
  }
  // Pack bytes follow the flush pkt-line (4 bytes).
  const packStart = flushEnd >= 0 ? flushEnd + 4 : body.length;
  const packBytes = body.subarray(packStart);
  const reportLines: string[] = [];
  let entries: PackEntry[] = [];
  let unpackOk = true;
  let unpackError = '';
  if (commands.length > 0 && commands.some((c) => c.newOid !== ZERO_OID)) {
    try {
      entries = parsePack(packBytes);
      storePackObjects(repo, entries);
    } catch (err) {
      unpackOk = false;
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  } else if (packBytes.length > 0) {
    // Delete-only pushes carry no pack; ignore stray bytes.
  }
  if (unpackOk) {
    reportLines.push('unpack ok');
  } else {
    reportLines.push(`unpack error ${unpackError}`);
  }
  for (const cmd of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${cmd.ref} unpack failed`);
      continue;
    }
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (!current) {
        reportLines.push(`ng ${cmd.ref} reference does not exist`);
      } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward`);
      } else {
        repo.refs.delete(cmd.ref);
        reportLines.push(`ok ${cmd.ref}`);
      }
      continue;
    }
    // New object must be present (from the pack or already stored).
    const newCommit = store.resolveToCommit(repo, cmd.newOid);
    if (!newCommit && !repo.objects.has(cmd.newOid)) {
      reportLines.push(`ng ${cmd.ref} missing object`);
      continue;
    }
    if (!current) {
      if (cmd.oldOid !== ZERO_OID) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward`);
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      reportLines.push(`ok ${cmd.ref}`);
      continue;
    }
    if (cmd.oldOid !== current) {
      reportLines.push(`ng ${cmd.ref} non-fast-forward`);
      continue;
    }
    const curCommit = store.resolveToCommit(repo, current);
    const newTip = store.resolveToCommit(repo, cmd.newOid);
    if (curCommit && newTip && !store.isAncestor(repo, curCommit, newTip)) {
      reportLines.push(`ng ${cmd.ref} non-fast-forward`);
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    reportLines.push(`ok ${cmd.ref}`);
  }
  const report = reportLines.map((l) => textPkt(l + '\n')).join('') + '0000';
  return { ok: unpackOk, report };
}

/** Wrap a report stream in sideband band-1 packets (data chunks ≤ 65515). */
export function reportSideband(report: string): Buffer {
  const bytes = Buffer.from(report, 'ascii');
  const parts: Buffer[] = [];
  for (let off = 0; off < bytes.length; off += 65515) {
    parts.push(sidebandPacket(1, bytes.subarray(off, Math.min(off + 65515, bytes.length))));
  }
  parts.push(encodeFlush());
  return Buffer.concat(parts);
}
