// app.ts — HTTP server: routing, auth, JSON plumbing, and the git smart
// HTTP endpoints. REST and GraphQL are authenticated with the shop token
// from MAKEFUN_SHOP_TOKEN; git endpoints are unauthenticated (the suite
// drives them with the same bearer, but no check requires a 401 there).

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store, ZERO_OID } from './store.ts';
import { handleRest } from './rest.ts';
import type { HttpReq } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  v0Advertisement,
  v2Advertisement,
  handleLsRefs,
  handleFetchV2,
  handleFetchV0,
  handleReceivePack,
  reportSideband,
  decodePktLines,
  encodeFlush,
} from './git.ts';

const MAX_BODY = 64 * 1024 * 1024;

export function createApp(opts: { shopToken: string; nowIso: string | undefined }): {
  server: ReturnType<typeof createServer>;
  store: Store;
} {
  const server = createServer();
  const storeHolder: { store: Store | null } = { store: null };
  let requestCounter = 0;

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    let totalLength = 0;
    let tooBig = false;
    req.on('data', (chunk: Buffer) => {
      if (chunks.length < 1024) chunks.push(chunk);
      totalLength += chunk.length;
      if (totalLength > MAX_BODY) tooBig = true;
    });
    req.on('end', () => {
      void (async () => {
        try {
          if (tooBig) {
            sendJson(res, 413, { message: 'Request body too large' });
            return;
          }
          const body = Buffer.concat(chunks);
          await handleRequest(req, res, body);
        } catch (err) {
          // Never kill the server on a bad request.
          try {
            sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal server error' });
          } catch {
            // Response already gone.
          }
        }
      })();
    });
  });

  function sendJson(res: ServerResponse, status: number, payload: unknown): void {
    const data = Buffer.from(JSON.stringify(payload), 'utf8');
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': data.length,
      'x-github-request-id': `req-${++requestCounter}`,
    });
    res.end(data);
  }

  function sendRaw(res: ServerResponse, status: number, contentType: string, data: Buffer): void {
    res.writeHead(status, {
      'content-type': contentType,
      'content-length': data.length,
    });
    res.end(data);
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> {
    // The store needs the public base URL, which is known once the server
    // is listening; lazily create it on the first request.
    if (!storeHolder.store) {
      const port = (server.address() as { port: number } | null)?.port ?? 0;
      storeHolder.store = new Store(opts.nowIso, `http://127.0.0.1:${port}`);
    }
    const store = storeHolder.store;
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const rawPath = url.pathname;
    const path = rawPath.length > 1 && rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
    const method = req.method ?? 'GET';
    const segments = path.split('/').filter((s) => s.length > 0);

    // Health check: no auth, always 200.
    if (path === '/healthz' && method === 'GET') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // Git smart HTTP: /{owner}/{repo}.git/...
    if (segments.length >= 2 && segments[1].endsWith('.git')) {
      await handleGit(req, res, store, segments, method, url, body);
      return;
    }

    // Everything else under /api/v3, /api/graphql, /mcp needs the token.
    const auth = req.headers['authorization'] ?? '';
    const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (token !== opts.shopToken || token === '') {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }

    if (path === '/api/graphql' && method === 'POST') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      const out = handleGraphQL(store, parsed);
      sendJson(res, out.status, out.body);
      return;
    }

    if (path === '/mcp' && method === 'POST') {
      const out = handleMcp(store, body);
      if (Buffer.isBuffer(out.body)) {
        res.writeHead(out.status, { 'content-length': 0 });
        res.end();
        return;
      }
      sendJson(res, out.status, out.body);
      return;
    }

    if (segments[0] === 'api' && segments[1] === 'v3') {
      let json: any = undefined;
      let jsonError = false;
      if (body.length > 0) {
        try {
          json = JSON.parse(body.toString('utf8'));
        } catch {
          jsonError = true;
        }
      }
      const httpReq: HttpReq = {
        method,
        path,
        segments,
        query: url.searchParams,
        body,
        json,
        jsonError,
        baseUrl: store.baseUrl,
      };
      const out = handleRest(store, httpReq);
      if (out) {
        if (Buffer.isBuffer(out.body)) {
          res.writeHead(out.status, {
            'content-type': out.contentType ?? 'application/json',
            'x-github-request-id': `req-${++requestCounter}`,
            ...(out.extraHeaders ?? {}),
          });
          res.end(out.body);
          return;
        }
        const headers: Record<string, string> = {
          'x-github-request-id': `req-${++requestCounter}`,
          ...(out.extraHeaders ?? {}),
        };
        const data = Buffer.from(JSON.stringify(out.body), 'utf8');
        res.writeHead(out.status, { 'content-type': out.contentType ?? 'application/json', 'content-length': data.length, ...headers });
        res.end(data);
        return;
      }
    }

    sendJson(res, 404, { message: 'Not Found' });
  }

  async function handleGit(
    req: IncomingMessage,
    res: ServerResponse,
    store: Store,
    segments: string[],
    method: string,
    url: URL,
    body: Buffer,
  ): Promise<void> {
    const owner = decodeURIComponent(segments[0]);
    const repoName = decodeURIComponent(segments[1].slice(0, -4));
    const repo = store.getRepo(owner, repoName);
    const tail = segments.slice(2);

    const notFound = () => sendJson(res, 404, { message: 'Not Found' });

    if (tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs' && method === 'GET') {
      if (!repo) {
        notFound();
        return;
      }
      const service = url.searchParams.get('service') ?? '';
      const protocol = req.headers['git-protocol'];
      const wantsV2 = typeof protocol === 'string' && protocol.includes('version=2');
      if (service === 'git-upload-pack') {
        const adv = wantsV2 ? v2Advertisement() : v0Advertisement(store, repo, 'upload-pack');
        sendRaw(res, 200, 'application/x-git-upload-pack-advertisement', adv);
        return;
      }
      if (service === 'git-receive-pack') {
        const adv = v0Advertisement(store, repo, 'receive-pack');
        sendRaw(res, 200, 'application/x-git-receive-pack-advertisement', adv);
        return;
      }
      notFound();
      return;
    }

    if (tail.length === 1 && tail[0] === 'git-upload-pack' && method === 'POST') {
      if (!repo) {
        notFound();
        return;
      }
      const protocol = req.headers['git-protocol'];
      const wantsV2 = typeof protocol === 'string' && protocol.includes('version=2');
      try {
        if (wantsV2) {
          const packets = decodePktLines(body);
          const first = packets.find((p) => p.kind === 'data');
          const command = first ? first.payload.toString('utf8').trim() : '';
          if (command === 'command=ls-refs') {
            const args: string[] = [];
            let seenDelim = false;
            for (const p of packets) {
              if (p.kind === 'delim') {
                seenDelim = true;
                continue;
              }
              if (p.kind !== 'data') continue;
              const text = p.payload.toString('utf8').trim();
              if (text.startsWith('command=') || text.startsWith('object-format=') || text.startsWith('agent=')) continue;
              if (seenDelim) args.push(text);
            }
            const out = handleLsRefs(store, repo, args);
            sendRaw(res, 200, 'application/x-git-upload-pack-result', out);
            return;
          }
          if (command === 'command=fetch') {
            const args: string[] = [];
            let seenDelim = false;
            for (const p of packets) {
              if (p.kind === 'delim') {
                seenDelim = true;
                continue;
              }
              if (p.kind !== 'data') continue;
              const text = p.payload.toString('utf8').trim();
              if (text.startsWith('command=') || text.startsWith('object-format=') || text.startsWith('agent=')) continue;
              if (seenDelim) args.push(text);
            }
            const out = handleFetchV2(store, repo, args);
            sendRaw(res, 200, 'application/x-git-upload-pack-result', out);
            return;
          }
          // Unknown command: answer an empty flush so the client fails
          // cleanly instead of hanging.
          sendRaw(res, 200, 'application/x-git-upload-pack-result', encodeFlush());
          return;
        }
        const out = handleFetchV0(store, repo, body);
        sendRaw(res, 200, 'application/x-git-upload-pack-result', out);
        return;
      } catch (err) {
        sendRaw(res, 400, 'text/plain', Buffer.from(`bad request: ${err instanceof Error ? err.message : 'parse error'}`, 'utf8'));
        return;
      }
    }

    if (tail.length === 1 && tail[0] === 'git-receive-pack' && method === 'POST') {
      if (!repo) {
        notFound();
        return;
      }
      try {
        const result = handleReceivePack(store, repo, body);
        const out = reportSideband(result.report);
        sendRaw(res, 200, 'application/x-git-receive-pack-result', out);
        return;
      } catch (err) {
        sendRaw(res, 400, 'text/plain', Buffer.from(`bad request: ${err instanceof Error ? err.message : 'parse error'}`, 'utf8'));
        return;
      }
    }

    notFound();
  }

  return { server, store: storeHolder.store as unknown as Store };
}
