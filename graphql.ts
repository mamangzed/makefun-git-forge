// graphql.ts — a small hand-rolled GraphQL executor for the fixed document
// shapes the suite sends. Supports queries, mutations, aliases, variables,
// inline input objects, inline fragments, __type introspection, and batched
// (array) request bodies. Unknown fields return HTTP 200 with an errors
// array naming the field.

import { VIEWER, b64urlDecode } from './store.ts';
import type { Store, Repo, Issue, Pull } from './store.ts';

// ---- tokenizer -------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'var'; value: string }
  | { kind: 'punct'; value: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      tokens.push({ kind: 'var', value: src.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      let isFloat = false;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      if (src[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (src.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!@='.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

// ---- parser ----------------------------------------------------------------

export type Value =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'var'; name: string }
  | { kind: 'list'; value: Value[] }
  | { kind: 'object'; value: Record<string, Value> };

export interface Selection {
  kind: 'field' | 'inline' | 'spread';
  alias?: string;
  name?: string;
  args?: Record<string, Value>;
  selections?: Selection[];
  typeCondition?: string;
}

export interface Operation {
  type: 'query' | 'mutation' | 'subscription';
  name?: string;
  varDefs: Record<string, Value | undefined>;
  selections: Selection[];
}

export interface Document {
  operations: Operation[];
  fragments: Map<string, Selection[]>;
}

class Parser {
  tokens: Token[];
  pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  next(): Token {
    const t = this.tokens[this.pos];
    this.pos += 1;
    return t;
  }

  expectPunct(v: string): void {
    const t = this.next();
    if (!t || t.kind !== 'punct' || t.value !== v) throw new Error(`expected ${v}`);
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, Selection[]>();
    while (this.pos < this.tokens.length) {
      const t = this.peek()!;
      if (t.kind === 'name' && t.value === 'fragment') {
        this.next();
        const name = this.next();
        const on = this.next();
        if (on.value !== 'on') throw new Error('expected on');
        const typeName = this.next();
        const selections = this.parseSelectionSet();
        fragments.set(name.value, selections);
        void typeName;
        continue;
      }
      operations.push(this.parseOperation());
    }
    return { operations, fragments };
  }

  parseOperation(): Operation {
    let type: Operation['type'] = 'query';
    let name: string | undefined;
    const t = this.peek()!;
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation' || t.value === 'subscription')) {
      type = t.value as Operation['type'];
      this.next();
      const n = this.peek();
      if (n && n.kind === 'name') {
        name = n.value;
        this.next();
      }
    }
    const varDefs: Record<string, Value | undefined> = {};
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === ')')) {
        const v = this.next(); // $name
        if (v.kind !== 'var') throw new Error('expected variable');
        this.expectPunct(':');
        this.skipType();
        let def: Value | undefined;
        if (this.peek()?.kind === 'punct' && this.peek()!.value === '=') {
          this.next();
          def = this.parseValue();
        }
        varDefs[v.value] = def;
      }
      this.next();
    }
    const selections = this.parseSelectionSet();
    return { type, name, varDefs, selections };
  }

  skipType(): void {
    const t = this.peek();
    if (!t) return;
    if (t.kind === 'punct' && t.value === '[') {
      this.next();
      this.skipType();
      this.expectPunct(']');
    } else if (t.kind === 'name') {
      this.next();
    }
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '!') this.next();
  }

  parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const out: Selection[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()!.value === '}')) {
      out.push(this.parseSelection());
    }
    this.next();
    return out;
  }

  parseSelection(): Selection {
    const t = this.peek()!;
    if (t.kind === 'punct' && t.value === '...') {
      this.next();
      const n = this.peek();
      if (n && n.kind === 'name' && n.value === 'on') {
        this.next();
        const typeName = this.next();
        return { kind: 'inline', typeCondition: typeName.value, selections: this.parseSelectionSet() };
      }
      if (n && n.kind === 'name') {
        this.next();
        return { kind: 'spread', name: n.value };
      }
      return { kind: 'inline', selections: this.parseSelectionSet() };
    }
    const nameTok = this.next();
    if (nameTok.kind !== 'name') throw new Error('expected field name');
    let alias: string | undefined;
    let name = nameTok.value;
    if (this.peek()?.kind === 'punct' && this.peek()!.value === ':') {
      this.next();
      alias = name;
      name = this.next().value;
    }
    let args: Record<string, Value> | undefined;
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') {
      args = this.parseArguments();
    }
    let selections: Selection[] | undefined;
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  parseArguments(): Record<string, Value> {
    const out: Record<string, Value> = {};
    this.expectPunct('(');
    while (!(this.peek()?.kind === 'punct' && this.peek()!.value === ')')) {
      const name = this.next();
      this.expectPunct(':');
      out[name.value] = this.parseValue();
    }
    this.next();
    return out;
  }

  parseValue(): Value {
    const t = this.next();
    switch (t.kind) {
      case 'string':
        return { kind: 'string', value: t.value };
      case 'int':
        return { kind: 'int', value: parseInt(t.value, 10) };
      case 'float':
        return { kind: 'float', value: parseFloat(t.value) };
      case 'var':
        return { kind: 'var', name: t.value };
      case 'name':
        if (t.value === 'true') return { kind: 'boolean', value: true };
        if (t.value === 'false') return { kind: 'boolean', value: false };
        if (t.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: t.value };
      case 'punct':
        if (t.value === '[') {
          const values: Value[] = [];
          while (!(this.peek()?.kind === 'punct' && this.peek()!.value === ']')) {
            values.push(this.parseValue());
          }
          this.next();
          return { kind: 'list', value: values };
        }
        if (t.value === '{') {
          const obj: Record<string, Value> = {};
          while (!(this.peek()?.kind === 'punct' && this.peek()!.value === '}')) {
            const name = this.next();
            this.expectPunct(':');
            obj[name.value] = this.parseValue();
          }
          this.next();
          return { kind: 'object', value: obj };
        }
        throw new Error(`unexpected punct ${t.value} as value`);
      default:
        throw new Error('unexpected token as value');
    }
  }
}

function resolveValue(v: Value, vars: Record<string, any>): any {
  switch (v.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return v.value;
    case 'null':
      return null;
    case 'enum':
      return v.value;
    case 'var':
      return vars[v.name];
    case 'list':
      return v.value.map((x) => resolveValue(x, vars));
    case 'object': {
      const out: Record<string, any> = {};
      for (const [k, val] of Object.entries(v.value)) out[k] = resolveValue(val, vars);
      return out;
    }
  }
}

// ---- schema tables ---------------------------------------------------------

const FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'search', 'user', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Viewer: ['login', 'id', 'name', 'email', 'url', 'avatarUrl'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'description', 'isPrivate', 'url', 'createdAt', 'updatedAt',
    'issue', 'issues', 'pullRequest', 'pullRequests', 'forkCount', 'stargazerCount', 'watchers',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt',
    'author', 'labels', 'comments', 'repository', 'locked', 'closedAt',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable',
    'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'url', 'createdAt',
    'updatedAt', 'author', 'repository', 'mergedAt', 'mergeCommit',
  ],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'url'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  User: ['login', 'id', 'name', 'email', 'url', 'avatarUrl'],
  Ref: ['name', 'target'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'interfaces'],
  __Field: ['name', 'description', 'args', 'type'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  __Schema: ['queryType', 'mutationType', 'types'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId', 'subject'],
};

const TYPE_INFO: Record<string, { kind: string; fields: string[]; enumValues: string[] }> = {
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'repository', 'locked', 'closedAt'],
    enumValues: [],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'url', 'createdAt', 'updatedAt', 'author', 'repository', 'mergedAt', 'mergeCommit'],
    enumValues: [],
  },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'description', 'isPrivate', 'url', 'createdAt', 'updatedAt', 'issue', 'issues', 'pullRequest', 'pullRequests', 'forkCount', 'stargazerCount', 'watchers'],
    enumValues: [],
  },
  SearchType: {
    kind: 'ENUM',
    fields: [],
    enumValues: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE', 'WIKI', 'PROJECT'],
  },
  Query: {
    kind: 'OBJECT',
    fields: ['viewer', 'repository', 'node', 'search', 'user'],
    enumValues: [],
  },
  Mutation: {
    kind: 'OBJECT',
    fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
    enumValues: [],
  },
  User: { kind: 'OBJECT', fields: ['login', 'id', 'name', 'email', 'url', 'avatarUrl'], enumValues: [] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'], enumValues: [] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'], enumValues: [] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'], enumValues: [] },
  IssueState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
};

// ---- nodes -------------------------------------------------------------------

type Node = Record<string, any> & { __typename: string };

function cursorFor(kind: string, number: number): string {
  return Buffer.from(`cursor:${kind}:${number}`, 'utf8').toString('base64url');
}

function pageInfoFor(items: Array<{ cursor: string }>, hasNext: boolean): Node {
  return {
    __typename: 'PageInfo',
    hasNextPage: hasNext,
    hasPreviousPage: false,
    startCursor: items.length > 0 ? items[0].cursor : null,
    endCursor: items.length > 0 ? items[items.length - 1].cursor : null,
  };
}

// ---- executor ---------------------------------------------------------------

class Executor {
  store: Store;
  errors: Array<{ message: string }> = [];
  fragments: Map<string, Selection[]>;

  constructor(store: Store, fragments: Map<string, Selection[]>) {
    this.store = store;
    this.fragments = fragments;
  }

  executeOperation(op: Operation, variables: Record<string, any>): Record<string, any> {
    const vars: Record<string, any> = {};
    for (const [name, def] of Object.entries(op.varDefs)) {
      vars[name] = variables[name] !== undefined ? variables[name] : (def ? resolveValue(def, vars) : undefined);
    }
    const rootType = op.type === 'mutation' ? 'Mutation' : 'Query';
    const root: Node = { __typename: rootType };
    return this.executeSelectionSet(root, rootType, op.selections, vars);
  }

  executeSelectionSet(node: Node, typeName: string, selections: Selection[], vars: Record<string, any>): Record<string, any> {
    const out: Record<string, any> = {};
    for (const sel of selections) {
      if (sel.kind === 'spread') {
        const frag = this.fragments.get(sel.name ?? '');
        if (frag) Object.assign(out, this.executeSelectionSet(node, typeName, frag, vars));
        continue;
      }
      if (sel.kind === 'inline') {
        if (!sel.typeCondition || sel.typeCondition === node.__typename) {
          Object.assign(out, this.executeSelectionSet(node, typeName, sel.selections ?? [], vars));
        }
        continue;
      }
      const key = sel.alias ?? sel.name!;
      const allowed = FIELDS[typeName];
      if (allowed && !allowed.includes(sel.name!)) {
        this.errors.push({ message: `Cannot query field "${sel.name}" on type "${typeName}".` });
        out[key] = null;
        continue;
      }
      const args: Record<string, any> = {};
      if (sel.args) {
        for (const [k, v] of Object.entries(sel.args)) args[k] = resolveValue(v, vars);
      }
      out[key] = this.resolveField(node, typeName, sel.name!, args, sel.selections ?? [], vars);
    }
    return out;
  }

  resolveList(items: Node[], selections: Selection[], vars: Record<string, any>): Array<Record<string, any>> {
    return items.map((item) => this.executeSelectionSet(item, item.__typename, selections, vars));
  }

  resolveField(node: Node, typeName: string, field: string, args: Record<string, any>, selections: Selection[], vars: Record<string, any>): any {
    // Root fields.
    if (typeName === 'Query') {
      if (field === 'viewer') {
        return this.executeSelectionSet({ __typename: 'Viewer' }, 'Viewer', selections, vars);
      }
      if (field === 'repository') {
        const repo = this.store.getRepo(args.owner, args.name);
        if (!repo) return null;
        return this.executeSelectionSet({ __typename: 'Repository', repo }, 'Repository', selections, vars);
      }
      if (field === 'node') {
        const target = this.store.resolveGlobalId(args.id);
        if (!target) return null;
        if (target.kind === 'repo') {
          const repo = this.store.getRepo(target.owner, target.name);
          if (!repo) return null;
          return this.executeSelectionSet({ __typename: 'Repository', repo }, 'Repository', selections, vars);
        }
        return null;
      }
      if (field === '__type') {
        const info = TYPE_INFO[args.name];
        if (!info) return null;
        const typeNode: Node = { __typename: '__Type', name: args.name, kind: info.kind, fieldNames: info.fields, enumNames: info.enumValues };
        return this.executeSelectionSet(typeNode, '__Type', selections, vars);
      }
      if (field === '__schema') {
        const schemaNode: Node = { __typename: '__Schema' };
        return this.executeSelectionSet(schemaNode, '__Schema', selections, vars);
      }
      if (field === 'user') {
        if (args.login === VIEWER.login) {
          return this.executeSelectionSet({ __typename: 'User', login: VIEWER.login, id: VIEWER.id }, 'User', selections, vars);
        }
        return null;
      }
      return null;
    }

    if (typeName === 'Mutation') {
      if (field === 'createIssue') {
        const input = args.input ?? {};
        const target = this.store.resolveGlobalId(input.repositoryId);
        if (!target || target.kind !== 'repo') {
          this.errors.push({ message: 'Could not resolve repositoryId.' });
          return null;
        }
        const repo = this.store.getRepo(target.owner, target.name);
        if (!repo) {
          this.errors.push({ message: 'Repository not found.' });
          return null;
        }
        const issue = this.store.createIssue(repo, input.title ?? '', input.body ?? '', []);
        const payload: Node = { __typename: 'CreateIssuePayload', issue, repo };
        return this.executeSelectionSet(payload, 'CreateIssuePayload', selections, vars);
      }
      if (field === 'closeIssue') {
        const input = args.input ?? {};
        const target = this.store.resolveGlobalId(input.issueId);
        if (!target || target.kind !== 'issue') {
          this.errors.push({ message: 'Could not resolve issueId.' });
          return null;
        }
        const repo = this.store.getRepo(target.owner, target.name);
        const issue = repo?.issues.find((i) => i.number === target.number);
        if (!issue || !repo) {
          this.errors.push({ message: 'Issue not found.' });
          return null;
        }
        issue.state = 'closed';
        issue.closedAt = this.store.nowIso;
        issue.updatedAt = this.store.nowIso;
        const payload: Node = { __typename: 'CloseIssuePayload', issue, repo };
        return this.executeSelectionSet(payload, 'CloseIssuePayload', selections, vars);
      }
      if (field === 'createPullRequest') {
        const input = args.input ?? {};
        const target = this.store.resolveGlobalId(input.repositoryId);
        if (!target || target.kind !== 'repo') {
          this.errors.push({ message: 'Could not resolve repositoryId.' });
          return null;
        }
        const repo = this.store.getRepo(target.owner, target.name);
        if (!repo) {
          this.errors.push({ message: 'Repository not found.' });
          return null;
        }
        const pull = this.store.createPull(repo, input.headRefName, input.baseRefName, input.title ?? '', input.body ?? '');
        if (!pull) {
          this.errors.push({ message: 'Could not create pull request: branch does not exist.' });
          return null;
        }
        const payload: Node = { __typename: 'CreatePullRequestPayload', pull, repo };
        return this.executeSelectionSet(payload, 'CreatePullRequestPayload', selections, vars);
      }
      if (field === 'mergePullRequest') {
        const input = args.input ?? {};
        const target = this.store.resolveGlobalId(input.pullRequestId);
        if (!target || target.kind !== 'pull') {
          this.errors.push({ message: 'Could not resolve pullRequestId.' });
          return null;
        }
        const repo = this.store.getRepo(target.owner, target.name);
        const pull = repo?.pulls.find((p) => p.number === target.number);
        if (!pull || !repo) {
          this.errors.push({ message: 'Pull request not found.' });
          return null;
        }
        if (pull.state !== 'open') {
          this.errors.push({ message: 'Pull request is not open.' });
          return null;
        }
        const merged = this.store.mergePull(repo, pull);
        if (!merged) {
          this.errors.push({ message: 'Merge conflict.' });
          return null;
        }
        const payload: Node = { __typename: 'MergePullRequestPayload', pull, repo };
        return this.executeSelectionSet(payload, 'MergePullRequestPayload', selections, vars);
      }
      if (field === 'addComment') {
        const input = args.input ?? {};
        const target = this.store.resolveGlobalId(input.subjectId);
        if (!target || target.kind !== 'issue') {
          this.errors.push({ message: 'Could not resolve subjectId.' });
          return null;
        }
        const repo = this.store.getRepo(target.owner, target.name);
        const issue = repo?.issues.find((i) => i.number === target.number);
        if (!issue || !repo) {
          this.errors.push({ message: 'Issue not found.' });
          return null;
        }
        const comment = this.store.addComment(repo, issue, input.body ?? '');
        const payload: Node = { __typename: 'AddCommentPayload', comment, repo, issue };
        return this.executeSelectionSet(payload, 'AddCommentPayload', selections, vars);
      }
      return null;
    }

    // Payload fields.
    if (typeName === 'CreateIssuePayload' || typeName === 'CloseIssuePayload') {
      if (field === 'issue') {
        const issueNode: Node = { __typename: 'Issue', repo: node.repo, issue: node.issue };
        return this.executeSelectionSet(issueNode, 'Issue', selections, vars);
      }
      if (field === 'clientMutationId') return null;
      return null;
    }
    if (typeName === 'CreatePullRequestPayload' || typeName === 'MergePullRequestPayload') {
      if (field === 'pullRequest') {
        const prNode: Node = { __typename: 'PullRequest', repo: node.repo, pull: node.pull };
        return this.executeSelectionSet(prNode, 'PullRequest', selections, vars);
      }
      if (field === 'clientMutationId') return null;
      return null;
    }
    if (typeName === 'AddCommentPayload') {
      if (field === 'commentEdge') {
        const edge: Node = {
          __typename: 'IssueCommentEdge',
          node: { __typename: 'IssueComment', repo: node.repo, comment: node.comment },
          cursor: cursorFor('comment', node.comment.id),
        };
        return this.executeSelectionSet(edge, 'IssueCommentEdge', selections, vars);
      }
      if (field === 'subject') {
        const issueNode: Node = { __typename: 'Issue', repo: node.repo, issue: node.issue };
        return this.executeSelectionSet(issueNode, 'Issue', selections, vars);
      }
      if (field === 'clientMutationId') return null;
      return null;
    }

    if (typeName === 'Viewer') {
      if (field === 'login') return VIEWER.login;
      if (field === 'id') return VIEWER.id;
      if (field === 'name') return VIEWER.name;
      if (field === 'email') return VIEWER.email;
      if (field === 'url') return `https://github.com/${VIEWER.login}`;
      if (field === 'avatarUrl') return '';
      return null;
    }

    if (typeName === 'User') {
      if (field === 'login') return node.login;
      if (field === 'id') return node.id;
      if (field === 'name') return VIEWER.name;
      if (field === 'email') return VIEWER.email;
      if (field === 'url') return `https://github.com/${node.login}`;
      if (field === 'avatarUrl') return '';
      return null;
    }

    if (typeName === 'Repository') {
      const repo: Repo = node.repo;
      switch (field) {
        case 'id':
          return repo.globalId;
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner': {
          const userNode: Node = { __typename: 'User', login: repo.owner, id: VIEWER.id };
          return this.executeSelectionSet(userNode, 'User', selections, vars);
        }
        case 'defaultBranchRef': {
          const refNode: Node = { __typename: 'Ref', name: repo.defaultBranch };
          return this.executeSelectionSet(refNode, 'Ref', selections, vars);
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'description':
          return repo.description;
        case 'isPrivate':
          return repo.private;
        case 'url':
          return `${this.store.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}`;
        case 'createdAt':
          return repo.createdAt;
        case 'updatedAt':
          return repo.updatedAt;
        case 'forkCount':
        case 'stargazerCount':
        case 'watchers':
          return 0;
        case 'issue': {
          const issue = repo.issues.find((i) => i.number === args.number);
          if (!issue) return null;
          return this.executeSelectionSet({ __typename: 'Issue', repo, issue }, 'Issue', selections, vars);
        }
        case 'issues': {
          const conn = this.issueConnection(repo, args);
          return this.executeSelectionSet(conn, 'IssueConnection', selections, vars);
        }
        case 'pullRequest': {
          const pull = repo.pulls.find((p) => p.number === args.number);
          if (!pull) return null;
          return this.executeSelectionSet({ __typename: 'PullRequest', repo, pull }, 'PullRequest', selections, vars);
        }
        case 'pullRequests': {
          const conn = this.pullConnection(repo, args);
          return this.executeSelectionSet(conn, 'PullRequestConnection', selections, vars);
        }
        default:
          return null;
      }
    }

    if (typeName === 'Issue') {
      const issue: Issue = node.issue;
      switch (field) {
        case 'id':
          return issue.globalId;
        case 'databaseId':
          return issue.id;
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'url':
          return `${this.store.baseUrl}/${node.repo.owner}/${node.repo.name}/issues/${issue.number}`;
        case 'createdAt':
          return issue.createdAt;
        case 'updatedAt':
          return issue.updatedAt;
        case 'closedAt':
          return issue.closedAt;
        case 'locked':
          return false;
        case 'author': {
          const userNode: Node = { __typename: 'User', login: VIEWER.login, id: VIEWER.id };
          return this.executeSelectionSet(userNode, 'User', selections, vars);
        }
        case 'labels':
          return issue.labels.map((l) => ({ name: l.name, color: l.color }));
        case 'comments': {
          const comments = node.repo.comments.filter((c: any) => c.issueNumber === issue.number);
          const conn: Node = {
            __typename: 'IssueCommentConnection',
            items: comments.map((c: any) => ({ __typename: 'IssueComment', repo: node.repo, comment: c })),
            pageInfo: pageInfoFor(comments.map((c: any) => ({ cursor: cursorFor('comment', c.id) })), false),
            totalCount: comments.length,
          };
          return this.executeSelectionSet(conn, 'IssueCommentConnection', selections, vars);
        }
        case 'repository':
          return this.executeSelectionSet({ __typename: 'Repository', repo: node.repo }, 'Repository', selections, vars);
        default:
          return null;
      }
    }

    if (typeName === 'PullRequest') {
      const pull: Pull = node.pull;
      const repo: Repo = node.repo;
      switch (field) {
        case 'id':
          return pull.globalId;
        case 'databaseId':
          return pull.id;
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged':
          return pull.merged;
        case 'mergeable':
          // GraphQL's MergeableState enum, not the REST boolean.
          return this.wouldConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'headRefOid':
          return repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
        case 'baseRefOid':
          return repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
        case 'url':
          return `${this.store.baseUrl}/${repo.owner}/${repo.name}/pull/${pull.number}`;
        case 'createdAt':
          return pull.createdAt;
        case 'updatedAt':
          return pull.updatedAt;
        case 'mergedAt':
          return pull.mergedAt;
        case 'mergeCommit': {
          if (!pull.mergeCommitSha) return null;
          return { sha: pull.mergeCommitSha };
        }
        case 'author': {
          const userNode: Node = { __typename: 'User', login: VIEWER.login, id: VIEWER.id };
          return this.executeSelectionSet(userNode, 'User', selections, vars);
        }
        case 'repository':
          return this.executeSelectionSet({ __typename: 'Repository', repo }, 'Repository', selections, vars);
        case 'files': {
          const baseCommit = this.store.getCommit(repo, pull.baseSha);
          const headCommit = this.store.getCommit(repo, pull.headSha);
          const diffs = baseCommit && headCommit ? this.store.diffTrees(repo, baseCommit.tree, headCommit.tree) : [];
          const items = diffs.map((d) => ({
            __typename: 'PullRequestChangedFile',
            path: d.filename,
            additions: d.additions,
            deletions: d.deletions,
            changeType: d.status === 'added' ? 'ADDED' : d.status === 'removed' ? 'DELETED' : 'MODIFIED',
          }));
          const first = typeof args.first === 'number' ? args.first : items.length;
          const page = items.slice(0, first);
          const conn: Node = {
            __typename: 'PullRequestChangedFileConnection',
            items: page,
            pageInfo: pageInfoFor(page.map((p) => ({ cursor: cursorFor('file', 0) })), items.length > first),
            totalCount: items.length,
          };
          return this.executeSelectionSet(conn, 'PullRequestChangedFileConnection', selections, vars);
        }
        default:
          return null;
      }
    }

    if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'PullRequestChangedFileConnection' || typeName === 'IssueCommentConnection') {
      if (field === 'nodes') return this.resolveList(node.items, selections, vars);
      if (field === 'edges') {
        const edges = node.items.map((item: Node) => ({
          __typename: typeName === 'IssueConnection' ? 'IssueEdge' : typeName === 'PullRequestConnection' ? 'PullRequestEdge' : 'IssueCommentEdge',
          node: item,
          cursor: cursorFor('edge', 0),
        }));
        const edgeType = typeName === 'IssueConnection' ? 'IssueEdge' : typeName === 'PullRequestConnection' ? 'PullRequestEdge' : 'IssueCommentEdge';
        return edges.map((e: Node) => this.executeSelectionSet(e, edgeType, selections, vars));
      }
      if (field === 'pageInfo') {
        return this.executeSelectionSet(node.pageInfo, 'PageInfo', selections, vars);
      }
      if (field === 'totalCount') return node.totalCount;
      return null;
    }

    if (typeName === 'IssueEdge' || typeName === 'PullRequestEdge') {
      if (field === 'node') {
        const item = node.node as Node;
        return this.executeSelectionSet(item, item.__typename, selections, vars);
      }
      if (field === 'cursor') return node.cursor;
      return null;
    }

    if (typeName === 'IssueCommentEdge') {
      if (field === 'node') {
        const item = node.node as Node;
        return this.executeSelectionSet(item, item.__typename, selections, vars);
      }
      if (field === 'cursor') return node.cursor;
      return null;
    }

    if (typeName === 'IssueComment') {
      if (field === 'id') return node.comment.globalId;
      if (field === 'body') return node.comment.body;
      if (field === 'createdAt') return node.comment.createdAt;
      if (field === 'url') return `${this.store.baseUrl}/${node.repo.owner}/${node.repo.name}/issues/${node.comment.issueNumber}`;
      if (field === 'author') {
        const userNode: Node = { __typename: 'User', login: VIEWER.login, id: VIEWER.id };
        return this.executeSelectionSet(userNode, 'User', selections, vars);
      }
      return null;
    }

    if (typeName === 'PullRequestChangedFile') {
      if (field === 'path') return node.path;
      if (field === 'additions') return node.additions;
      if (field === 'deletions') return node.deletions;
      if (field === 'changeType') return node.changeType;
      return null;
    }

    if (typeName === 'PageInfo') {
      if (field === 'hasNextPage') return node.hasNextPage;
      if (field === 'hasPreviousPage') return node.hasPreviousPage;
      if (field === 'startCursor') return node.startCursor;
      if (field === 'endCursor') return node.endCursor;
      return null;
    }

    if (typeName === 'Ref') {
      if (field === 'name') return node.name;
      if (field === 'target') return null;
      return null;
    }

    if (typeName === '__Type') {
      if (field === 'name') return node.name;
      if (field === 'kind') return node.kind;
      if (field === 'description') return null;
      if (field === 'fields') {
        const items = node.fieldNames.map((n: string) => ({ __typename: '__Field', name: n }));
        return this.resolveList(items, selections, vars);
      }
      if (field === 'enumValues') {
        const items = node.enumNames.map((n: string) => ({ __typename: '__EnumValue', name: n }));
        return this.resolveList(items, selections, vars);
      }
      if (field === 'possibleTypes') return [];
      if (field === 'interfaces') return [];
      return null;
    }

    if (typeName === '__Field') {
      if (field === 'name') return node.name;
      if (field === 'description') return null;
      if (field === 'args') return [];
      if (field === 'type') return { name: 'String', kind: 'SCALAR' };
      return null;
    }

    if (typeName === '__EnumValue') {
      if (field === 'name') return node.name;
      if (field === 'description') return null;
      if (field === 'isDeprecated') return false;
      if (field === 'deprecationReason') return null;
      return null;
    }

    if (typeName === '__Schema') {
      if (field === 'queryType') return { name: 'Query' };
      if (field === 'mutationType') return { name: 'Mutation' };
      if (field === 'types') return Object.keys(TYPE_INFO).map((n) => ({ name: n }));
      return null;
    }

    return null;
  }

  issueConnection(repo: Repo, args: Record<string, any>): Node {
    let list = [...repo.issues];
    if (Array.isArray(args.states) && args.states.length > 0) {
      const wanted = new Set(args.states.map((s: string) => String(s).toLowerCase()));
      list = list.filter((i) => wanted.has(i.state));
    }
    const orderBy = args.orderBy ?? {};
    const direction = orderBy.direction === 'ASC' ? 1 : -1;
    list.sort((a, b) => {
      const cmp = a.seq - b.seq || a.number - b.number;
      return cmp * direction;
    });
    if (typeof args.after === 'string' && args.after) {
      try {
        const decoded = b64urlDecode(args.after);
        const m = /^cursor:issue:(\d+)$/.exec(decoded);
        if (m) {
          const idx = list.findIndex((i) => i.number === parseInt(m[1], 10));
          if (idx >= 0) list = list.slice(idx + 1);
        }
      } catch {
        // Bad cursor: ignore.
      }
    }
    const total = list.length;
    const first = typeof args.first === 'number' ? args.first : total;
    const page = list.slice(0, first);
    const items = page.map((issue) => ({ __typename: 'Issue', repo, issue }));
    const cursors = page.map((issue) => ({ cursor: cursorFor('issue', issue.number) }));
    return {
      __typename: 'IssueConnection',
      items,
      pageInfo: pageInfoFor(cursors, list.length > first),
      totalCount: total,
    };
  }

  pullConnection(repo: Repo, args: Record<string, any>): Node {
    let list = [...repo.pulls];
    if (Array.isArray(args.states) && args.states.length > 0) {
      const wanted = new Set(args.states.map((s: string) => String(s).toUpperCase()));
      list = list.filter((p) => wanted.has(p.merged ? 'MERGED' : p.state.toUpperCase()));
    } else {
      list = list.filter((p) => p.state === 'open');
    }
    list.sort((a, b) => b.seq - a.seq);
    const total = list.length;
    const first = typeof args.first === 'number' ? args.first : total;
    const page = list.slice(0, first);
    const items = page.map((pull) => ({ __typename: 'PullRequest', repo, pull }));
    const cursors = page.map((pull) => ({ cursor: cursorFor('pull', pull.number) }));
    return {
      __typename: 'PullRequestConnection',
      items,
      pageInfo: pageInfoFor(cursors, list.length > first),
      totalCount: total,
    };
  }

  wouldConflict(repo: Repo, pull: Pull): boolean {
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (!headTip || !baseTip) return true;
    const base = this.store.mergeBase(repo, baseTip, headTip);
    if (!base) return true;
    const baseFiles = this.store.flattenTree(repo, this.store.getCommit(repo, base)!.tree);
    const headFiles = this.store.flattenTree(repo, this.store.getCommit(repo, headTip)!.tree);
    const curFiles = this.store.flattenTree(repo, this.store.getCommit(repo, baseTip)!.tree);
    const changed = (a: Map<string, { oid: string }>, b: Map<string, { oid: string }>) => {
      const out = new Set<string>();
      for (const [p, e] of a) if (!b.has(p) || b.get(p)!.oid !== e.oid) out.add(p);
      for (const p of b) if (!a.has(p)) out.add(p);
      return out;
    };
    const headChanged = changed(baseFiles, headFiles);
    const baseChanged = changed(baseFiles, curFiles);
    for (const p of headChanged) {
      if (baseChanged.has(p)) {
        if ((headFiles.get(p)?.oid ?? null) !== (curFiles.get(p)?.oid ?? null)) return true;
      }
    }
    return false;
  }
}

// ---- entry point -----------------------------------------------------------

export function handleGraphQL(store: Store, body: unknown): { status: number; body: unknown } {
  const runOne = (op: unknown): Record<string, any> => {
    if (!op || typeof op !== 'object') {
      return { errors: [{ message: 'Request body must be a GraphQL operation object.' }] };
    }
    const { query, variables } = op as { query?: unknown; variables?: unknown };
    if (typeof query !== 'string' || query.trim() === '') {
      return { errors: [{ message: 'Must provide query string.' }] };
    }
    let doc: Document;
    try {
      doc = new Parser(tokenize(query)).parseDocument();
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : 'Syntax error in GraphQL document.' }] };
    }
    if (doc.operations.length === 0) {
      return { errors: [{ message: 'Must provide an operation.' }] };
    }
    const vars = variables && typeof variables === 'object' ? (variables as Record<string, any>) : {};
    const executor = new Executor(store, doc.fragments);
    const data = executor.executeOperation(doc.operations[0], vars);
    const out: Record<string, any> = { data };
    if (executor.errors.length > 0) out.errors = executor.errors;
    return out;
  };

  if (Array.isArray(body)) {
    return { status: 200, body: body.map(runOne) };
  }
  return { status: 200, body: runOne(body) };
}
