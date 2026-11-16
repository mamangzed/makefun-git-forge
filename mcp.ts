// mcp.ts — Model Context Protocol endpoint (POST /mcp).
//
// JSON-RPC 2.0 Streamable HTTP, modern revision 2026-07-28 with a legacy
// initialize fallback. Six tools over the same store as REST: create_repo,
// get_repo, create_issue, list_issues, create_pull_request,
// merge_pull_request. Tool lists are built once so two tools/list calls
// answer byte-for-byte identically.

import { VIEWER, repoJson, issueJson, pullJson } from './store.ts';
import type { Store, Repo } from './store.ts';

const SERVER_NAME = 'makefun-git-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25'];

const TOOLS: Array<Record<string, unknown>> = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function toolResult(data: unknown, isError = false): Record<string, unknown> {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  return {
    content: [{ type: 'text', text }],
    structuredContent: typeof data === 'object' && data !== null ? data : { result: data },
    isError,
  };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

export function handleMcp(store: Store, rawBody: Buffer): { status: number; body: unknown } {
  let msg: any;
  try {
    msg = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const id = msg.id ?? null;
  const method = typeof msg.method === 'string' ? msg.method : '';
  const params = msg.params && typeof msg.params === 'object' ? msg.params : {};

  // Notifications (no id) get an empty 202.
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    return { status: 202, body: Buffer.alloc(0) };
  }

  if (method === 'server/discover') {
    return {
      status: 200,
      body: rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: {
          'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION },
        },
      }),
    };
  }

  if (method === 'initialize') {
    const offered = Array.isArray(params.protocolVersion) ? params.protocolVersion : [params.protocolVersion];
    const chosen = SUPPORTED_VERSIONS.find((v) => offered.includes(v)) ?? '2025-11-25';
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion: chosen,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }),
    };
  }

  if (method === 'ping') {
    return { status: 200, body: rpcResult(id, {}) };
  }

  if (method === 'tools/list') {
    return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
  }

  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    const tool = TOOLS.find((t) => t.name === toolName);
    if (!tool) {
      return { status: 200, body: rpcError(id, -32602, `Unknown tool: ${toolName}`) };
    }
    const required = (tool.inputSchema as any).required as string[];
    for (const r of required) {
      if (args[r] === undefined || args[r] === null || args[r] === '') {
        return {
          status: 200,
          body: rpcResult(id, toolResult(`Missing required argument: ${r}`, true)),
        };
      }
    }
    const owner = typeof args.owner === 'string' ? args.owner : VIEWER.login;
    const repoName = typeof args.repo === 'string' ? args.repo : '';
    const repo: Repo | undefined = repoName ? store.getRepo(owner, repoName) : undefined;

    switch (toolName) {
      case 'create_repo': {
        const name = String(args.name);
        const existing = store.getRepo(VIEWER.login, name);
        if (existing) {
          return { status: 200, body: rpcResult(id, toolResult(repoJson(store, existing))) };
        }
        const created = store.createRepo(name, typeof args.description === 'string' ? args.description : '', args.private === true);
        if (!created) {
          return { status: 200, body: rpcResult(id, toolResult('Repository already exists', true)) };
        }
        return { status: 200, body: rpcResult(id, toolResult(repoJson(store, created))) };
      }
      case 'get_repo': {
        if (!repo) {
          return { status: 200, body: rpcResult(id, toolResult(`Repository not found: ${owner}/${repoName}`, true)) };
        }
        return { status: 200, body: rpcResult(id, toolResult(repoJson(store, repo))) };
      }
      case 'create_issue': {
        if (!repo) {
          return { status: 200, body: rpcResult(id, toolResult(`Repository not found: ${owner}/${repoName}`, true)) };
        }
        const issue = store.createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
        return { status: 200, body: rpcResult(id, toolResult(issueJson(store, repo, issue))) };
      }
      case 'list_issues': {
        if (!repo) {
          return { status: 200, body: rpcResult(id, toolResult(`Repository not found: ${owner}/${repoName}`, true)) };
        }
        const state = typeof args.state === 'string' ? args.state : 'open';
        const list = repo.issues.filter((i) => state === 'all' || i.state === state);
        const payload = list.map((i) => issueJson(store, repo, i));
        return { status: 200, body: rpcResult(id, toolResult(payload)) };
      }
      case 'create_pull_request': {
        if (!repo) {
          return { status: 200, body: rpcResult(id, toolResult(`Repository not found: ${owner}/${repoName}`, true)) };
        }
        const head = String(args.head);
        const base = String(args.base);
        const headSha = repo.refs.get(`refs/heads/${head}`);
        const baseSha = repo.refs.get(`refs/heads/${base}`);
        if (!headSha || !baseSha) {
          return { status: 200, body: rpcResult(id, toolResult('Branch does not exist', true)) };
        }
        const dup = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
        if (dup) {
          return { status: 200, body: rpcResult(id, toolResult(pullJson(store, repo, dup))) };
        }
        const pull = store.createPull(repo, head, base, String(args.title), typeof args.body === 'string' ? args.body : '');
        if (!pull) {
          return { status: 200, body: rpcResult(id, toolResult('Could not create pull request', true)) };
        }
        return { status: 200, body: rpcResult(id, toolResult(pullJson(store, repo, pull))) };
      }
      case 'merge_pull_request': {
        if (!repo) {
          return { status: 200, body: rpcResult(id, toolResult(`Repository not found: ${owner}/${repoName}`, true)) };
        }
        const num = typeof args.pull_number === 'number' ? args.pull_number : parseInt(String(args.pull_number), 10);
        const pull = repo.pulls.find((p) => p.number === num);
        if (!pull) {
          return { status: 200, body: rpcResult(id, toolResult(`Pull request not found: ${num}`, true)) };
        }
        if (pull.state !== 'open') {
          return { status: 200, body: rpcResult(id, toolResult('Pull request is not open', true)) };
        }
        const merged = store.mergePull(repo, pull);
        if (!merged) {
          return { status: 200, body: rpcResult(id, toolResult('Merge conflict', true)) };
        }
        return { status: 200, body: rpcResult(id, toolResult({ sha: merged, merged: true, number: pull.number })) };
      }
      default:
        return { status: 200, body: rpcError(id, -32602, `Unknown tool: ${toolName}`) };
    }
  }

  return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
}
