// store.ts — in-memory deterministic store for the forge.
//
// The scenario is fixed: the viewer is always adaiversen (id 1000). All
// identifiers come from monotonic counters and the instance opening time
// (MAKEFUN_TRIAL_NOW), never from the wall clock or Math.random, so two
// runs over the same request order produce byte-identical exports.

import { createHash } from 'node:crypto';

export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};
export const TEAMMATE = {
  login: 'quinnkeller',
  id: 1001,
  name: 'quinn keller',
  email: 'quinnkeller@example.invalid',
};
export const STRANGER = {
  login: 'olgabauer',
  id: 1002,
  name: 'olga bauer',
  email: 'olgabauer@example.invalid',
};

export const ZERO_OID = '0'.repeat(40);

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** sha1 of a git object: "<type> <size>\0" + payload. */
export function objectId(type: string, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([head, data]));
}

export function b64urlEncode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

export function b64urlDecode(text: string): string {
  return Buffer.from(text, 'base64url').toString('utf8');
}

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  authorLine: string;
  committerLine: string;
  message: string;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  number: number;
  id: number;
  globalId: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  seq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface CommentRec {
  id: number;
  globalId: string;
  body: string;
  issueNumber: number;
  seq: number;
  createdAt: string;
}

export interface Pull {
  number: number;
  id: number;
  globalId: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Repo {
  id: number;
  globalId: string;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  comments: CommentRec[];
  nextIssue: number;
  nextPull: number;
  nextLabel: number;
}

function gitSortKey(e: TreeEntry): string {
  // Git sorts tree entries by name, directories as if they end with '/'.
  return e.name + (e.mode === '40000' ? '/' : '');
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp);
    if (sp < 0 || nul < 0) break;
    const mode = data.subarray(off, sp).toString('utf8');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) =>
    gitSortKey(a) < gitSortKey(b) ? -1 : gitSortKey(a) > gitSortKey(b) ? 1 : 0,
  );
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank >= 0 ? text.slice(0, blank) : text;
  const message = blank >= 0 ? text.slice(blank + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let authorLine = '';
  let committerLine = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) authorLine = line.slice(7);
    else if (line.startsWith('committer ')) committerLine = line.slice(10);
  }
  return { tree, parents, authorLine, committerLine, message };
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string; message: string } {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank >= 0 ? text.slice(0, blank) : text;
  const message = blank >= 0 ? text.slice(blank + 2) : '';
  let object = '';
  let type = '';
  let tag = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
  }
  return { object, type, tag, message };
}

export class Store {
  repos = new Map<string, Repo>();
  repoCounter = 0;
  issueIdCounter = 0;
  commentIdCounter = 0;
  labelIdCounter = 0;
  pullIdCounter = 0;
  seq = 0;
  commitCounter = 0;
  nowIso: string;
  epochSec: number;
  baseUrl: string;

  constructor(nowIso: string | undefined, baseUrl: string) {
    this.nowIso = nowIso && nowIso.length > 0 ? nowIso : '2026-11-16T00:00:00.000Z';
    const parsed = Date.parse(this.nowIso);
    this.epochSec = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 1763251200;
    this.baseUrl = baseUrl;
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** Deterministic commit timestamp: opening epoch + a counter. */
  nextCommitTs(): number {
    const ts = this.epochSec + this.commitCounter;
    this.commitCounter += 1;
    return ts;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  globalRepoId(owner: string, name: string): string {
    return b64urlEncode(`repo:${owner}/${name}`);
  }

  globalIssueId(owner: string, name: string, number: number): string {
    return b64urlEncode(`issue:${owner}/${name}#${number}`);
  }

  globalPullId(owner: string, name: string, number: number): string {
    return b64urlEncode(`pull:${owner}/${name}#${number}`);
  }

  globalCommentId(owner: string, name: string, id: number): string {
    return b64urlEncode(`comment:${owner}/${name}#${id}`);
  }

  resolveGlobalId(id: string): { kind: string; owner: string; name: string; number: number } | null {
    try {
      const text = b64urlDecode(id);
      const m = /^(repo|issue|pull|comment):([^/]+)\/([^#]+)(?:#(\d+))?$/.exec(text);
      if (!m) return null;
      return { kind: m[1], owner: m[2], name: m[3], number: m[4] ? parseInt(m[4], 10) : 0 };
    } catch {
      return null;
    }
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    const key = this.repoKey(VIEWER.login, name);
    if (this.repos.has(key)) return null;
    this.repoCounter += 1;
    const repo: Repo = {
      id: this.repoCounter,
      globalId: this.globalRepoId(VIEWER.login, name),
      name,
      owner: VIEWER.login,
      description: description || '',
      private: !!isPrivate,
      defaultBranch: 'main',
      seq: this.nextSeq(),
      createdAt: this.nowIso,
      updatedAt: this.nowIso,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      comments: [],
      nextIssue: 1,
      nextPull: 1,
      nextLabel: 1,
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }

  // ---- git objects -------------------------------------------------------

  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const oid = objectId(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  getCommit(repo: Repo, oid: string): CommitInfo | null {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') return null;
    return parseCommit(obj.data);
  }

  /** Commit reachable from a ref/oid, following tag objects. */
  resolveToCommit(repo: Repo, oid: string): string | null {
    let cur = oid;
    for (let i = 0; i < 8; i++) {
      const obj = repo.objects.get(cur);
      if (!obj) return null;
      if (obj.type === 'commit') return cur;
      if (obj.type === 'tag') {
        cur = parseTag(obj.data).object;
        continue;
      }
      return null;
    }
    return null;
  }

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
  }

  deleteRef(repo: Repo, ref: string): boolean {
    return repo.refs.delete(ref);
  }

  /** All ancestors of a commit (itself included), with BFS depth. */
  ancestors(repo: Repo, tip: string): Map<string, number> {
    const seen = new Map<string, number>();
    const queue: Array<[string, number]> = [[tip, 0]];
    for (let qi = 0; qi < queue.length; qi++) {
      const [oid, depth] = queue[qi];
      if (seen.has(oid)) continue;
      const commit = this.getCommit(repo, oid);
      if (!commit) continue;
      seen.set(oid, depth);
      for (const p of commit.parents) queue.push([p, depth + 1]);
    }
    return seen;
  }

  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    // Depth-first search that stops as soon as the ancestor is found. For
    // the common linear fast-forward push this is a single step.
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const stack: string[] = [descendant];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const commit = this.getCommit(repo, oid);
      if (!commit) continue;
      for (const p of commit.parents) {
        if (p === ancestor) return true;
        stack.push(p);
      }
    }
    return false;
  }

  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancA = this.ancestors(repo, a);
    const queue: string[] = [b];
    const seen = new Set<string>();
    for (let qi = 0; qi < queue.length; qi++) {
      const oid = queue[qi];
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (ancA.has(oid)) return oid;
      const commit = this.getCommit(repo, oid);
      if (!commit) continue;
      for (const p of commit.parents) queue.push(p);
    }
    return null;
  }

  /** Commits reachable from a tip, newest-first (by generation, then oid). */
  listCommits(repo: Repo, tip: string): Array<{ oid: string; info: CommitInfo; depth: number }> {
    const anc = this.ancestors(repo, tip);
    const list = [...anc.entries()].map(([oid, depth]) => ({
      oid,
      info: this.getCommit(repo, oid)!,
      depth,
    }));
    list.sort((x, y) => (x.depth - y.depth) || (x.oid < y.oid ? -1 : 1));
    return list;
  }

  /** Flat map of path -> {mode, oid} for the tree at a commit. */
  flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { mode: string; oid: string }> {
    const out = new Map<string, { mode: string; oid: string }>();
    const obj = repo.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return out;
    for (const e of parseTree(obj.data)) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000') {
        for (const [p, v] of this.flattenTree(repo, e.oid, path)) out.set(p, v);
      } else {
        out.set(path, { mode: e.mode, oid: e.oid });
      }
    }
    return out;
  }

  /** Write a tree for a flat file map; returns the tree oid. */
  writeTreeFromFiles(repo: Repo, files: Map<string, { mode: string; oid: string }>): string {
    interface Node {
      files: Map<string, { mode: string; oid: string }>;
      dirs: Map<string, Node>;
    }
    const root: Node = { files: new Map(), dirs: new Map() };
    for (const [path, entry] of files) {
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        let child = node.dirs.get(parts[i]);
        if (!child) {
          child = { files: new Map(), dirs: new Map() };
          node.dirs.set(parts[i], child);
        }
        node = child;
      }
      node.files.set(parts[parts.length - 1], entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, e] of node.files) entries.push({ mode: e.mode, name, oid: e.oid });
      for (const [name, child] of node.dirs) {
        entries.push({ mode: '40000', name, oid: build(child) });
      }
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  createCommit(repo: Repo, treeOid: string, parents: string[], message: string): string {
    const ts = this.nextCommitTs();
    const who = `${VIEWER.name} <${VIEWER.email}> ${ts} +0000`;
    const lines = [`tree ${treeOid}`];
    for (const p of parents) lines.push(`parent ${p}`);
    lines.push(`author ${who}`);
    lines.push(`committer ${who}`);
    const data = Buffer.from(lines.join('\n') + '\n\n' + message, 'utf8');
    return this.putObject(repo, 'commit', data);
  }

  /** Commit a single file change onto a branch (or create the branch). */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
  ): { commitOid: string; blobOid: string } {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    const files = tip ? this.flattenTree(repo, this.getCommit(repo, tip)!.tree) : new Map();
    const blobOid = this.putObject(repo, 'blob', content);
    files.set(path, { mode: '100644', oid: blobOid });
    const treeOid = this.writeTreeFromFiles(repo, files);
    const parents = tip ? [tip] : [];
    const commitOid = this.createCommit(repo, treeOid, parents, message);
    repo.refs.set(ref, commitOid);
    return { commitOid, blobOid };
  }

  /** Remove a file from a branch, creating a commit. */
  removeFile(repo: Repo, branch: string, path: string, message: string): string | null {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    if (!tip) return null;
    const files = this.flattenTree(repo, this.getCommit(repo, tip)!.tree);
    if (!files.has(path)) return null;
    files.delete(path);
    const treeOid = this.writeTreeFromFiles(repo, files);
    const commitOid = this.createCommit(repo, treeOid, [tip], message);
    repo.refs.set(ref, commitOid);
    return commitOid;
  }

  // ---- labels / issues / pulls ------------------------------------------

  createLabel(repo: Repo, name: string, color: string, description = ''): Label {
    const existing = repo.labels.get(name);
    if (existing) return existing;
    this.labelIdCounter += 1;
    const label: Label = { id: this.labelIdCounter, name, color, description };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repo, title: string, body: string, labelNames: string[]): Issue {
    const number = repo.nextIssue++;
    this.issueIdCounter += 1;
    const issue: Issue = {
      number,
      id: this.issueIdCounter,
      globalId: this.globalIssueId(repo.owner, repo.name, number),
      title,
      body: body || '',
      state: 'open',
      labels: labelNames.map((n) => repo.labels.get(n)!).filter(Boolean),
      seq: this.nextSeq(),
      createdAt: this.nowIso,
      updatedAt: this.nowIso,
      closedAt: null,
    };
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((i) => i.number === number);
  }

  addComment(repo: Repo, issue: Issue, body: string): CommentRec {
    this.commentIdCounter += 1;
    const rec: CommentRec = {
      id: this.commentIdCounter,
      globalId: this.globalCommentId(repo.owner, repo.name, this.commentIdCounter),
      body,
      issueNumber: issue.number,
      seq: this.nextSeq(),
      createdAt: this.nowIso,
    };
    repo.comments.push(rec);
    return rec;
  }

  createPull(repo: Repo, headRef: string, baseRef: string, title: string, body: string): Pull | null {
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (!headSha || !baseSha) return null;
    const number = repo.nextPull++;
    this.pullIdCounter += 1;
    const pull: Pull = {
      number,
      id: this.pullIdCounter,
      globalId: this.globalPullId(repo.owner, repo.name, number),
      title,
      body: body || '',
      state: 'open',
      headRef,
      baseRef,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      seq: this.nextSeq(),
      createdAt: this.nowIso,
      updatedAt: this.nowIso,
      closedAt: null,
    };
    repo.pulls.push(pull);
    return pull;
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.find((p) => p.number === number);
  }

  /** Squash-merge a pull. Returns the merge commit oid, or null on conflict. */
  mergePull(repo: Repo, pull: Pull): string | null {
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (!headTip || !baseTip) return null;
    const base = this.mergeBase(repo, baseTip, headTip);
    if (!base) return null;
    const baseFiles = this.flattenTree(repo, this.getCommit(repo, base)!.tree);
    const headFiles = this.flattenTree(repo, this.getCommit(repo, headTip)!.tree);
    const curFiles = this.flattenTree(repo, this.getCommit(repo, baseTip)!.tree);
    const changed = (a: Map<string, { mode: string; oid: string }>, b: Map<string, { mode: string; oid: string }>) => {
      const out = new Set<string>();
      for (const [p, e] of a) if (!b.has(p) || b.get(p)!.oid !== e.oid) out.add(p);
      for (const p of b) if (!a.has(p)) out.add(p);
      return out;
    };
    const headChanged = changed(baseFiles, headFiles);
    const baseChanged = changed(baseFiles, curFiles);
    for (const p of headChanged) {
      if (baseChanged.has(p)) {
        const h = headFiles.get(p);
        const b = curFiles.get(p);
        if ((h?.oid ?? null) !== (b?.oid ?? null)) return null; // conflict
      }
    }
    // Squash: merged tree is exactly the head tree, parent is the base tip.
    const headTree = this.getCommit(repo, headTip)!.tree;
    const mergeOid = this.createCommit(repo, headTree, [baseTip], pull.title);
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeOid);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.nowIso;
    pull.mergeCommitSha = mergeOid;
    pull.closedAt = this.nowIso;
    pull.updatedAt = this.nowIso;
    return mergeOid;
  }

  /** Line diff between two blobs (multiset difference, deterministic). */
  diffLines(oldText: string, newText: string): { additions: number; deletions: number } {
    const oldLines = oldText.length ? oldText.split('\n') : [];
    const newLines = newText.length ? newText.split('\n') : [];
    const counts = new Map<string, number>();
    for (const l of oldLines) counts.set(l, (counts.get(l) ?? 0) + 1);
    let additions = 0;
    for (const l of newLines) {
      const c = counts.get(l) ?? 0;
      if (c > 0) counts.set(l, c - 1);
      else additions += 1;
    }
    let deletions = 0;
    for (const c of counts.values()) deletions += c;
    return { additions, deletions };
  }

  /** File-level diff between two trees. */
  diffTrees(
    repo: Repo,
    baseTreeOid: string,
    headTreeOid: string,
  ): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const base = this.flattenTree(repo, baseTreeOid);
    const head = this.flattenTree(repo, headTreeOid);
    const paths = new Set<string>([...base.keys(), ...head.keys()]);
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b && !h) {
        const oldText = repo.objects.get(b.oid)?.data.toString('utf8') ?? '';
        const d = this.diffLines(oldText, '');
        out.push({ filename: path, status: 'removed', additions: 0, deletions: d.deletions, changes: d.deletions });
      } else if (!b && h) {
        const newText = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
        const d = this.diffLines('', newText);
        out.push({ filename: path, status: 'added', additions: d.additions, deletions: 0, changes: d.additions });
      } else if (b && h && b.oid !== h.oid) {
        const oldText = repo.objects.get(b.oid)?.data.toString('utf8') ?? '';
        const newText = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
        const d = this.diffLines(oldText, newText);
        out.push({ filename: path, status: 'modified', additions: d.additions, deletions: d.deletions, changes: d.additions + d.deletions });
      }
    }
    return out;
  }

  // ---- deterministic state export ---------------------------------------

  exportState(): Record<string, unknown> {
    const repos = this.listRepos().map((r) => ({
      id: r.id,
      name: r.name,
      owner: r.owner,
      description: r.description,
      private: r.private,
      default_branch: r.defaultBranch,
      refs: Object.fromEntries([...r.refs.entries()].sort()),
      objects: [...r.objects.keys()].sort(),
      labels: [...r.labels.values()].map((l) => ({ name: l.name, color: l.color })),
      issues: r.issues.map((i) => ({
        number: i.number,
        title: i.title,
        body: i.body,
        state: i.state,
        labels: i.labels.map((l) => l.name),
      })),
      comments: r.comments.map((c) => ({ id: c.id, issue: c.issueNumber, body: c.body })),
      pulls: r.pulls.map((p) => ({
        number: p.number,
        title: p.title,
        body: p.body,
        state: p.state,
        head: p.headRef,
        base: p.baseRef,
        merged: p.merged,
        merge_commit_sha: p.mergeCommitSha,
      })),
    }));
    return { viewer: VIEWER.login, repos };
  }
}

// ---- REST shapes ----------------------------------------------------------

export function userJson(u: { login: string; id: number }): Record<string, unknown> {
  return { login: u.login, id: u.id, type: 'User', avatar_url: '', html_url: `https://github.com/${u.login}` };
}

export function repoJson(store: Store, r: Repo): Record<string, unknown> {
  const url = `${store.baseUrl}/api/v3/repos/${r.owner}/${r.name}`;
  return {
    id: r.id,
    node_id: r.globalId,
    name: r.name,
    full_name: `${r.owner}/${r.name}`,
    owner: userJson(VIEWER),
    private: r.private,
    description: r.description,
    default_branch: r.defaultBranch,
    html_url: `https://github.com/${r.owner}/${r.name}`,
    url,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
    pushed_at: r.updatedAt,
    has_issues: true,
    has_wiki: false,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    fork: false,
    open_issues_count: r.issues.filter((i) => i.state === 'open').length,
    watchers_count: 0,
    stargazers_count: 0,
    forks_count: 0,
  };
}

export function labelJson(l: Label): Record<string, unknown> {
  return { id: l.id, node_id: b64urlEncode(`label:${l.name}`), name: l.name, color: l.color, description: l.description, default: false };
}

export function issueJson(store: Store, r: Repo, i: Issue): Record<string, unknown> {
  const url = `${store.baseUrl}/api/v3/repos/${r.owner}/${r.name}/issues/${i.number}`;
  return {
    id: i.id,
    node_id: i.globalId,
    number: i.number,
    title: i.title,
    body: i.body,
    state: i.state,
    labels: i.labels.map(labelJson),
    user: userJson(VIEWER),
    assignee: null,
    assignees: [],
    locked: false,
    comments: r.comments.filter((c) => c.issueNumber === i.number).length,
    created_at: i.createdAt,
    updated_at: i.updatedAt,
    closed_at: i.closedAt,
    url,
    html_url: `${store.baseUrl}/${r.owner}/${r.name}/issues/${i.number}`,
    comments_url: `${url}/comments`,
    repository_url: `${store.baseUrl}/api/v3/repos/${r.owner}/${r.name}`,
  };
}

export function commentJson(store: Store, r: Repo, c: CommentRec): Record<string, unknown> {
  const url = `${store.baseUrl}/api/v3/repos/${r.owner}/${r.name}/issues/comments/${c.id}`;
  return {
    id: c.id,
    node_id: c.globalId,
    body: c.body,
    user: userJson(VIEWER),
    created_at: c.createdAt,
    updated_at: c.createdAt,
    url,
    html_url: `${store.baseUrl}/${r.owner}/${r.name}/issues/${c.issueNumber}#issuecomment-${c.id}`,
    issue_url: `${store.baseUrl}/api/v3/repos/${r.owner}/${r.name}/issues/${c.issueNumber}`,
  };
}

export function pullJson(store: Store, r: Repo, p: Pull): Record<string, unknown> {
  const url = `${store.baseUrl}/api/v3/repos/${r.owner}/${r.name}/pulls/${p.number}`;
  const headSha = r.refs.get(`refs/heads/${p.headRef}`) ?? p.headSha;
  const baseSha = r.refs.get(`refs/heads/${p.baseRef}`) ?? p.baseSha;
  return {
    id: p.id,
    node_id: p.globalId,
    number: p.number,
    title: p.title,
    body: p.body,
    state: p.state,
    locked: false,
    draft: false,
    merged: p.merged,
    mergeable: true,
    mergeable_state: 'clean',
    merged_at: p.mergedAt,
    merge_commit_sha: p.mergeCommitSha,
    head: { label: `${r.owner}:${p.headRef}`, ref: p.headRef, sha: headSha, repo: repoJson(store, r) },
    base: { label: `${r.owner}:${p.baseRef}`, ref: p.baseRef, sha: baseSha, repo: repoJson(store, r) },
    user: userJson(VIEWER),
    created_at: p.createdAt,
    updated_at: p.updatedAt,
    closed_at: p.closedAt,
    url,
    html_url: `${store.baseUrl}/${r.owner}/${r.name}/pull/${p.number}`,
    diff_url: `${url}.diff`,
    patch_url: `${url}.patch`,
    commits_url: `${url}/commits`,
  };
}
