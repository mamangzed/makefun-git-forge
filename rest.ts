// rest.ts — GitHub REST v3 surface (/api/v3).
//
// JSON-only replies; every route is authenticated by the app layer except
// the ones it explicitly exempts. Errors are {"message": "..."}.

import { VIEWER, parseTree, repoJson, issueJson, commentJson, pullJson, labelJson } from './store.ts';
import type { Store, Repo, Issue, Pull } from './store.ts';

export interface HttpReq {
  method: string;
  path: string;
  segments: string[];
  query: URLSearchParams;
  body: Buffer;
  json: any;
  jsonError: boolean;
  baseUrl: string;
}

export interface HttpRes {
  status: number;
  body: unknown;
  contentType?: string;
  extraHeaders?: Record<string, string>;
}

export function jsonRes(status: number, body: unknown, extraHeaders?: Record<string, string>): HttpRes {
  return { status, body, contentType: 'application/json', extraHeaders };
}

export function errRes(status: number, message: string): HttpRes {
  return jsonRes(status, { message });
}

function paginate<T>(items: T[], query: URLSearchParams): { page: T[]; pageNum: number; perPage: number; total: number } {
  const perPage = Math.max(1, Math.min(100, parseInt(query.get('per_page') ?? '30', 10) || 30));
  const pageNum = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), pageNum, perPage, total: items.length };
}

function linkHeader(baseUrl: string, path: string, query: URLSearchParams, pageNum: number, perPage: number, total: number): Record<string, string> {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  if (pageNum >= lastPage) return {};
  const next = new URLSearchParams(query);
  next.set('page', String(pageNum + 1));
  next.set('per_page', String(perPage));
  const last = new URLSearchParams(query);
  last.set('page', String(lastPage));
  last.set('per_page', String(perPage));
  return {
    Link:
      `<${baseUrl}${path}?${next.toString()}>; rel="next", ` +
      `<${baseUrl}${path}?${last.toString()}>; rel="last"`,
  };
}

function parseAuthorLine(line: string): { name: string; email: string; date: string } {
  const m = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!m) return { name: VIEWER.name, email: VIEWER.email, date: '' };
  const date = new Date(parseInt(m[3], 10) * 1000).toISOString();
  return { name: m[1], email: m[2], date };
}

function commitJson(store: Store, repo: Repo, oid: string): Record<string, unknown> | null {
  const info = store.getCommit(repo, oid);
  if (!info) return null;
  const author = parseAuthorLine(info.authorLine);
  const committer = parseAuthorLine(info.committerLine);
  return {
    sha: oid,
    node_id: oid,
    commit: {
      message: info.message,
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
      tree: { sha: info.tree },
    },
    parents: info.parents.map((p) => ({ sha: p })),
    author: { login: VIEWER.login, id: VIEWER.id },
    committer: { login: VIEWER.login, id: VIEWER.id },
    url: `${store.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
    html_url: `${store.baseUrl}/${repo.owner}/${repo.name}/commit/${oid}`,
  };
}

function resolveRefTip(store: Store, repo: Repo, ref?: string | null): string | undefined {
  if (!ref) return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`);
  if (repo.refs.has(ref)) return repo.refs.get(ref);
  if (repo.objects.has(ref)) return ref;
  return undefined;
}

export function handleRest(store: Store, req: HttpReq): HttpRes | null {
  if (req.segments[0] !== 'api' || req.segments[1] !== 'v3') return null;
  const seg = req.segments.slice(2);
  const method = req.method;
  const body = req.json ?? {};

  // GET /api/v3/
  if (seg.length === 0) {
    if (method !== 'GET') return errRes(404, 'Not Found');
    return jsonRes(200, {
      current_user_url: `${store.baseUrl}/api/v3/user`,
      repository_url: `${store.baseUrl}/api/v3/repos/{owner}/{repo}`,
      user_repositories_url: `${store.baseUrl}/api/v3/user/repos`,
      emojis_url: `${store.baseUrl}/api/v3/emojis`,
      rate_limit_url: `${store.baseUrl}/api/v3/rate_limit`,
    }, { 'X-OAuth-Scopes': 'repo, read:org' });
  }

  // GET /api/v3/meta
  if (seg.length === 1 && seg[0] === 'meta') {
    if (method !== 'GET') return errRes(404, 'Not Found');
    return jsonRes(200, { installed_version: '1.0.0', verifiable_password_authentication: true });
  }

  // /api/v3/user
  if (seg.length >= 1 && seg[0] === 'user') {
    if (seg.length === 1) {
      if (method !== 'GET') return errRes(404, 'Not Found');
      return jsonRes(200, {
        login: VIEWER.login,
        id: VIEWER.id,
        node_id: store.globalRepoId(VIEWER.login, ''),
        name: VIEWER.name,
        email: VIEWER.email,
        type: 'User',
        avatar_url: '',
        html_url: `https://github.com/${VIEWER.login}`,
        url: `${store.baseUrl}/api/v3/users/${VIEWER.login}`,
        site_admin: false,
      });
    }
    if (seg.length === 2 && seg[1] === 'repos') {
      if (method === 'GET') {
        const all = store.listRepos();
        const { page, pageNum, perPage, total } = paginate(all, req.query);
        return jsonRes(200, page.map((r) => repoJson(store, r)), linkHeader(store.baseUrl, req.path, req.query, pageNum, perPage, total));
      }
      if (method === 'POST') {
        if (req.jsonError) return errRes(400, 'Problems parsing JSON');
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) return errRes(422, 'Validation Failed: name is required');
        const repo = store.createRepo(name, typeof body.description === 'string' ? body.description : '', body.private === true);
        if (!repo) return errRes(422, 'Repository already exists');
        return jsonRes(201, repoJson(store, repo));
      }
      return errRes(404, 'Not Found');
    }
    return errRes(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{repo}/...
  if (seg.length >= 3 && seg[0] === 'repos') {
    const owner = decodeURIComponent(seg[1]);
    const name = decodeURIComponent(seg[2]);
    const repo = store.getRepo(owner, name);
    const rest = seg.slice(3);

    if (rest.length === 0) {
      if (method === 'GET') {
        if (!repo) return errRes(404, 'Not Found');
        return jsonRes(200, repoJson(store, repo));
      }
      if (method === 'PATCH') {
        if (!repo) return errRes(404, 'Not Found');
        if (req.jsonError) return errRes(400, 'Problems parsing JSON');
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.private = body.private;
        if (typeof body.default_branch === 'string') repo.defaultBranch = body.default_branch;
        repo.updatedAt = store.nowIso;
        return jsonRes(200, repoJson(store, repo));
      }
      if (method === 'DELETE') {
        if (!repo) return errRes(404, 'Not Found');
        store.deleteRepo(owner, name);
        return { status: 204, body: Buffer.alloc(0), contentType: 'application/json' };
      }
      return errRes(404, 'Not Found');
    }
    if (!repo) return errRes(404, 'Not Found');

    // branches
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const list = [...repo.refs.keys()]
          .filter((r) => r.startsWith('refs/heads/'))
          .sort()
          .map((r) => ({
            name: r.slice('refs/heads/'.length),
            commit: { sha: repo.refs.get(r)!, url: `${store.baseUrl}/api/v3/repos/${owner}/${name}/commits/${repo.refs.get(r)!}` },
            protected: false,
          }));
        return jsonRes(200, list);
      }
      if (rest.length === 2 && method === 'GET') {
        const branch = decodeURIComponent(rest[1]);
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (!tip) return errRes(404, 'Not Found');
        return jsonRes(200, {
          name: branch,
          commit: { sha: tip, url: `${store.baseUrl}/api/v3/repos/${owner}/${name}/commits/${tip}` },
          protected: false,
        });
      }
      return errRes(404, 'Not Found');
    }

    // commits
    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      const tip = resolveRefTip(store, repo, req.query.get('sha'));
      if (!tip) return jsonRes(200, []);
      const list = store.listCommits(repo, tip).map((c) => commitJson(store, repo, c.oid)!);
      const { page } = paginate(list, req.query);
      return jsonRes(200, page);
    }

    // git/refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        if (req.jsonError) return errRes(400, 'Problems parsing JSON');
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || !sha) return errRes(422, 'Validation Failed');
        if (repo.refs.has(ref)) return errRes(422, 'Reference already exists');
        if (!repo.objects.has(sha)) return errRes(422, 'Object does not exist');
        repo.refs.set(ref, sha);
        return jsonRes(201, {
          ref,
          node_id: store.globalRepoId(owner, name),
          url: `${store.baseUrl}/api/v3/repos/${owner}/${name}/git/refs/${ref.replace(/^refs\//, '')}`,
          object: { sha, type: repo.objects.get(sha)!.type, url: `${store.baseUrl}/api/v3/repos/${owner}/${name}/git/${repo.objects.get(sha)!.type}s/${sha}` },
        });
      }
      if (method === 'GET' && rest.length >= 4 && rest[2] === 'heads') {
        const branch = decodeURIComponent(rest.slice(3).join('/'));
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (!tip) return errRes(404, 'Not Found');
        return jsonRes(200, {
          ref: `refs/heads/${branch}`,
          node_id: store.globalRepoId(owner, name),
          url: `${store.baseUrl}/api/v3/repos/${owner}/${name}/git/refs/heads/${branch}`,
          object: { sha: tip, type: 'commit', url: `${store.baseUrl}/api/v3/repos/${owner}/${name}/git/commits/${tip}` },
        });
      }
      return errRes(404, 'Not Found');
    }

    // contents
    if (rest[0] === 'contents') {
      const filePath = rest.slice(1).map(decodeURIComponent).join('/');
      if (method === 'GET') {
        const tip = resolveRefTip(store, repo, req.query.get('ref'));
        if (!tip) return errRes(404, 'Not Found');
        const commit = store.getCommit(repo, tip);
        if (!commit) return errRes(404, 'Not Found');
        const files = store.flattenTree(repo, commit.tree);
        if (filePath === '') {
          // Root directory listing.
          const entries = new Map<string, { type: string; sha: string }>();
          for (const p of files.keys()) {
            const top = p.split('/')[0];
            if (!entries.has(top)) {
              const obj = repo.objects.get(files.get(p)!.oid);
              entries.set(top, { type: p.includes('/') ? 'dir' : 'file', sha: p.includes('/') ? '' : files.get(p)!.oid });
            }
          }
          const list = [...entries.entries()].map(([n, e]) => ({ type: e.type, name: n, path: n, sha: e.sha }));
          return jsonRes(200, list);
        }
        const entry = files.get(filePath);
        if (entry) {
          const blob = repo.objects.get(entry.oid);
          const content = blob ? blob.data : Buffer.alloc(0);
          return jsonRes(200, {
            type: 'file',
            encoding: 'base64',
            size: content.length,
            name: filePath.split('/').pop(),
            path: filePath,
            content: content.toString('base64'),
            sha: entry.oid,
            url: `${store.baseUrl}/api/v3/repos/${owner}/${name}/contents/${filePath}`,
            html_url: `${store.baseUrl}/${owner}/${name}/blob/${repo.defaultBranch}/${filePath}`,
          });
        }
        // Directory?
        const prefix = filePath + '/';
        const children = new Map<string, { type: string; sha: string }>();
        for (const [p, e] of files) {
          if (!p.startsWith(prefix)) continue;
          const restPath = p.slice(prefix.length);
          const top = restPath.split('/')[0];
          if (!children.has(top)) {
            children.set(top, { type: restPath.includes('/') ? 'dir' : 'file', sha: restPath.includes('/') ? '' : e.oid });
          }
        }
        if (children.size === 0) return errRes(404, 'Not Found');
        const list = [...children.entries()].map(([n, e]) => ({ type: e.type, name: n, path: `${filePath}/${n}`, sha: e.sha }));
        return jsonRes(200, list);
      }
      if (method === 'PUT') {
        if (req.jsonError) return errRes(400, 'Problems parsing JSON');
        const message = typeof body.message === 'string' ? body.message : '';
        const contentB64 = typeof body.content === 'string' ? body.content : null;
        if (contentB64 === null) return errRes(422, 'Validation Failed: content is required');
        const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        const ref = `refs/heads/${branch}`;
        const tip = repo.refs.get(ref);
        const files = tip ? store.flattenTree(repo, store.getCommit(repo, tip)!.tree) : new Map();
        const existing = files.get(filePath);
        const sha = typeof body.sha === 'string' ? body.sha : null;
        if (existing && sha && sha !== existing.oid) return errRes(409, 'Conflict: sha does not match');
        if (existing && !sha) return errRes(409, 'Conflict: file already exists');
        const content = Buffer.from(contentB64, 'base64');
        const { commitOid, blobOid } = store.commitFile(repo, branch, filePath, content, message);
        return jsonRes(existing ? 200 : 201, {
          content: {
            name: filePath.split('/').pop(),
            path: filePath,
            sha: blobOid,
            size: content.length,
            type: 'file',
            encoding: 'base64',
            url: `${store.baseUrl}/api/v3/repos/${owner}/${name}/contents/${filePath}`,
          },
          commit: { sha: commitOid, message, author: { name: VIEWER.name, email: VIEWER.email }, committer: { name: VIEWER.name, email: VIEWER.email } },
        });
      }
      if (method === 'DELETE') {
        if (req.jsonError) return errRes(400, 'Problems parsing JSON');
        const message = typeof body.message === 'string' ? body.message : '';
        const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        const ref = `refs/heads/${branch}`;
        const tip = repo.refs.get(ref);
        if (!tip) return errRes(404, 'Not Found');
        const files = store.flattenTree(repo, store.getCommit(repo, tip)!.tree);
        const existing = files.get(filePath);
        if (!existing) return errRes(404, 'Not Found');
        const sha = typeof body.sha === 'string' ? body.sha : null;
        if (sha && sha !== existing.oid) return errRes(409, 'Conflict: sha does not match');
        const commitOid = store.removeFile(repo, branch, filePath, message);
        if (!commitOid) return errRes(404, 'Not Found');
        return jsonRes(200, {
          commit: { sha: commitOid, message, author: { name: VIEWER.name, email: VIEWER.email }, committer: { name: VIEWER.name, email: VIEWER.email } },
        });
      }
      return errRes(404, 'Not Found');
    }

    // labels
    if (rest[0] === 'labels') {
      if (rest.length === 1 && method === 'GET') {
        return jsonRes(200, [...repo.labels.values()].map(labelJson));
      }
      if (rest.length === 1 && method === 'POST') {
        if (req.jsonError) return errRes(400, 'Problems parsing JSON');
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const color = typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ffffff';
        if (!name) return errRes(422, 'Validation Failed: name is required');
        const existing = repo.labels.get(name);
        if (existing) return jsonRes(200, labelJson(existing));
        const label = store.createLabel(repo, name, color, typeof body.description === 'string' ? body.description : '');
        return jsonRes(201, labelJson(label));
      }
      return errRes(404, 'Not Found');
    }

    // issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = req.query.get('state') ?? 'open';
          const sort = req.query.get('sort') ?? 'created';
          const direction = req.query.get('direction') ?? 'desc';
          let list = repo.issues.filter((i) => state === 'all' || i.state === state);
          list = [...list].sort((a, b) => {
            const cmp = sort === 'updated' ? (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0) : a.seq - b.seq;
            return direction === 'asc' ? cmp : -cmp;
          });
          const { page } = paginate(list, req.query);
          return jsonRes(200, page.map((i) => issueJson(store, repo, i)));
        }
        if (method === 'POST') {
          if (req.jsonError) return errRes(400, 'Problems parsing JSON');
          const title = typeof body.title === 'string' ? body.title : '';
          if (!title) return errRes(422, 'Validation Failed: title is required');
          const labelNames: string[] = Array.isArray(body.labels) ? body.labels.filter((x: unknown) => typeof x === 'string') : [];
          for (const n of labelNames) {
            if (!repo.labels.has(n)) return errRes(422, `Validation Failed: label "${n}" does not exist`);
          }
          const issue = store.createIssue(repo, title, typeof body.body === 'string' ? body.body : '', labelNames);
          return jsonRes(201, issueJson(store, repo, issue));
        }
        return errRes(404, 'Not Found');
      }
      const num = parseInt(rest[1], 10);
      if (!Number.isFinite(num)) return errRes(404, 'Not Found');
      const issue = store.getIssue(repo, num);
      if (rest.length === 2) {
        if (method === 'GET') {
          if (!issue) return errRes(404, 'Not Found');
          return jsonRes(200, issueJson(store, repo, issue));
        }
        if (method === 'PATCH') {
          if (!issue) return errRes(404, 'Not Found');
          if (req.jsonError) return errRes(400, 'Problems parsing JSON');
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          if (body.state === 'open' || body.state === 'closed') {
            issue.state = body.state;
            issue.closedAt = body.state === 'closed' ? store.nowIso : null;
          }
          issue.updatedAt = store.nowIso;
          return jsonRes(200, issueJson(store, repo, issue));
        }
        return errRes(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (!issue) return errRes(404, 'Not Found');
        if (method === 'GET') {
          const list = repo.comments.filter((c) => c.issueNumber === num);
          return jsonRes(200, list.map((c) => commentJson(store, repo, c)));
        }
        if (method === 'POST') {
          if (req.jsonError) return errRes(400, 'Problems parsing JSON');
          const text = typeof body.body === 'string' ? body.body : '';
          const rec = store.addComment(repo, issue, text);
          return jsonRes(201, commentJson(store, repo, rec));
        }
        return errRes(404, 'Not Found');
      }
      return errRes(404, 'Not Found');
    }

    // pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = req.query.get('state') ?? 'open';
          let list = repo.pulls.filter((p) => state === 'all' || p.state === state);
          list = [...list].sort((a, b) => b.seq - a.seq);
          const { page } = paginate(list, req.query);
          return jsonRes(200, page.map((p) => pullJson(store, repo, p)));
        }
        if (method === 'POST') {
          if (req.jsonError) return errRes(400, 'Problems parsing JSON');
          const title = typeof body.title === 'string' ? body.title : '';
          const head = typeof body.head === 'string' ? body.head : '';
          const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
          if (!title || !head) return errRes(422, 'Validation Failed');
          const headSha = repo.refs.get(`refs/heads/${head}`);
          const baseSha = repo.refs.get(`refs/heads/${base}`);
          if (!headSha || !baseSha) return errRes(422, 'Validation Failed: branch does not exist');
          const dup = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
          if (dup) return errRes(422, 'A pull request already exists for this branch');
          const pull = store.createPull(repo, head, base, title, typeof body.body === 'string' ? body.body : '');
          if (!pull) return errRes(422, 'Validation Failed');
          return jsonRes(201, pullJson(store, repo, pull));
        }
        return errRes(404, 'Not Found');
      }
      const num = parseInt(rest[1], 10);
      if (!Number.isFinite(num)) return errRes(404, 'Not Found');
      const pull: Pull | undefined = store.getPull(repo, num);
      if (rest.length === 2) {
        if (method === 'GET') {
          if (!pull) return errRes(404, 'Not Found');
          return jsonRes(200, pullJson(store, repo, pull));
        }
        return errRes(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        if (!pull) return errRes(404, 'Not Found');
        const baseCommit = store.getCommit(repo, pull.baseSha);
        const headCommit = store.getCommit(repo, pull.headSha);
        if (!baseCommit || !headCommit) return jsonRes(200, []);
        const files = store.diffTrees(repo, baseCommit.tree, headCommit.tree);
        return jsonRes(200, files.map((f) => ({
          sha: pull.headSha,
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
        })));
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (!pull) return errRes(404, 'Not Found');
        if (pull.state !== 'open') return errRes(405, 'Pull request is not open');
        const mergeOid = store.mergePull(repo, pull);
        if (!mergeOid) return errRes(405, 'Merge conflict');
        return jsonRes(200, { sha: mergeOid, merged: true, message: `Merge pull request #${pull.number} from ${pull.headRef}` });
      }
      return errRes(404, 'Not Found');
    }
  }

  return errRes(404, 'Not Found');
}
