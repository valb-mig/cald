import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HttpError } from './errors.ts';
import { gitStatus } from './git.ts';

const exec = promisify(execFile);

export type GithubLabel = { name: string; color: string };

export type GithubIssue = {
  number: number;
  title: string;
  url: string;
  author: string | null;
  updatedAt: string;
  comments: number;
  labels: GithubLabel[];
};

export type GithubPull = {
  number: number;
  title: string;
  url: string;
  author: string | null;
  updatedAt: string;
  draft: boolean;
  branch: string;
  review: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  /** Os checks do último commit: `null` sem nenhum. */
  checks: 'SUCCESS' | 'FAILURE' | 'ERROR' | 'PENDING' | 'EXPECTED' | null;
};

/**
 * PRs e issues abertos do repositório do projeto. Sem dar para buscar (`ok: false`), o motivo:
 * sem remoto, remoto fora do GitHub, sem o `gh` instalado ou logado, ou outro erro dele.
 */
export type GithubInfo =
  | {
      ok: true;
      repo: string;
      pulls: GithubPull[];
      pullCount: number;
      issues: GithubIssue[];
      issueCount: number;
      fetchedAt: number;
      quota: GithubQuota | null;
    }
  | { ok: false; reason: 'no_remote' | 'not_github' | 'no_gh' | 'gh_auth' | 'error'; message?: string; fetchedAt: number };

/**
 * Uma consulta só para PRs e issues: na API GraphQL ela custa 1 ponto dos 5.000 por hora da conta.
 * Os 30 mais recentes de cada, e o total, para o contador.
 */
const QUERY = `query($owner: String!, $name: String!) {
  rateLimit { remaining limit resetAt }
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 30, orderBy: {field: UPDATED_AT, direction: DESC}) {
      totalCount
      nodes {
        number title url isDraft updatedAt headRefName reviewDecision author { login }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
    issues(states: OPEN, first: 30, orderBy: {field: UPDATED_AT, direction: DESC}) {
      totalCount
      nodes { number title url updatedAt author { login } comments { totalCount } labels(first: 5) { nodes { name color } } }
    }
  }
}`;

type Node<T> = { totalCount: number; nodes: T[] };
type RawPull = {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  updatedAt: string;
  headRefName: string;
  reviewDecision: GithubPull['review'];
  author: { login: string } | null;
  commits: { nodes: { commit: { statusCheckRollup: { state: GithubPull['checks'] } | null } }[] };
};
type RawIssue = {
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  author: { login: string } | null;
  comments: { totalCount: number };
  labels: { nodes: GithubLabel[] };
};
type Raw = { data?: { repository: { pullRequests: Node<RawPull>; issues: Node<RawIssue> } | null } };

type Failure = Extract<GithubInfo, { ok: false }>;

/** O repositório do projeto no GitHub, pelo remoto do git; ou por que não tem. */
async function repoOf(cwd: string, fetchedAt: number): Promise<{ owner: string; name: string } | Failure> {
  const remote = (await gitStatus(cwd).catch(() => null))?.remote;
  if (!remote) return { ok: false, reason: 'no_remote', fetchedAt };
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(remote);
  if (!m) return { ok: false, reason: 'not_github', fetchedAt };
  return { owner: m[1]!, name: m[2]! };
}

/**
 * Quanto sobra da cota da API GraphQL da conta (5.000 pontos por hora), lido de graça em cada consulta
 * (`rateLimit`). Com pouca sobra, o "atualizar" deixa de buscar de novo e fica com o que tem (ver `cached`).
 */
export type GithubQuota = { remaining: number; limit: number; resetAt: string };
let quota: GithubQuota | null = null;
// Abaixo disso, só busca o que não tem; o resto da cota fica para as ações e para o Claude, que usa o mesmo login.
const LOW_QUOTA = 300;
const quotaLow = () => quota !== null && quota.remaining < LOW_QUOTA && Date.parse(quota.resetAt) > Date.now();

/** Uma consulta GraphQL pelo `gh` deste PC, com o login dele; `vars` com `-F` (números) e `-f` (texto). */
async function graphql<T>(cwd: string, query: string, vars: Record<string, string | number>): Promise<T> {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [k, v] of Object.entries(vars)) args.push(typeof v === 'number' ? '-F' : '-f', `${k}=${v}`);
  const { stdout } = await exec('gh', args, { cwd, timeout: 20_000, maxBuffer: 16 * 1024 * 1024 });
  const parsed = JSON.parse(stdout) as T & { data?: { rateLimit?: GithubQuota } };
  if (parsed.data?.rateLimit) quota = parsed.data.rateLimit;
  return parsed;
}

function failure(err: unknown, fetchedAt: number): Failure {
  const e = err as NodeJS.ErrnoException & { stderr?: string };
  if (e.code === 'ENOENT') return { ok: false, reason: 'no_gh', fetchedAt };
  const stderr = String(e.stderr ?? '');
  if (/gh auth login|not logged|authentication/i.test(stderr)) return { ok: false, reason: 'gh_auth', fetchedAt };
  if (/rate limit|secondary rate/i.test(stderr)) {
    const back = quota && Date.parse(quota.resetAt) > Date.now() ? ` Volta às ${new Date(quota.resetAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}.` : '';
    return { ok: false, reason: 'error', message: `O limite de uso do GitHub foi atingido.${back}`, fetchedAt };
  }
  return { ok: false, reason: 'error', message: stderr.split('\n').find(Boolean)?.slice(0, 300) ?? e.message, fetchedAt };
}

async function load(cwd: string): Promise<GithubInfo> {
  const fetchedAt = Date.now();
  const at = await repoOf(cwd, fetchedAt);
  if ('ok' in at) return at;
  try {
    const repo = (await graphql<Raw>(cwd, QUERY, { owner: at.owner, name: at.name })).data?.repository;
    if (!repo) return { ok: false, reason: 'error', message: 'Repositório não encontrado no GitHub.', fetchedAt };
    return {
      ok: true,
      repo: `${at.owner}/${at.name}`,
      pullCount: repo.pullRequests.totalCount,
      pulls: repo.pullRequests.nodes.map((p) => ({
        number: p.number,
        title: p.title,
        url: p.url,
        author: p.author?.login ?? null,
        updatedAt: p.updatedAt,
        draft: p.isDraft,
        branch: p.headRefName,
        review: p.reviewDecision,
        checks: p.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null,
      })),
      issueCount: repo.issues.totalCount,
      issues: repo.issues.nodes.map((i) => ({
        number: i.number,
        title: i.title,
        url: i.url,
        author: i.author?.login ?? null,
        updatedAt: i.updatedAt,
        comments: i.comments.totalCount,
        labels: i.labels.nodes,
      })),
      fetchedAt,
      quota,
    };
  } catch (err) {
    return failure(err, fetchedAt);
  }
}

// ---- uma issue ou um PR, para a aba de análise no meio da tela ----

export type GithubComment = { author: string | null; body: string; createdAt: string; url: string };

export type GithubReview = {
  author: string | null;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  body: string;
  submittedAt: string | null;
};

/** Um check do último commit, com o resultado já resumido: passou, falhou, rodando ou neutro (pulado, cancelado). */
export type GithubCheck = { name: string; result: 'success' | 'failure' | 'pending' | 'neutral'; url: string | null };

export type GithubFile = { path: string; additions: number; deletions: number; change: string };

type ItemBase = {
  number: number;
  title: string;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  author: string | null;
  /** Quem está logado no `gh` deste PC abriu este: o GitHub não deixa aprovar o próprio PR. */
  mine: boolean;
  assignees: string[];
  createdAt: string;
  updatedAt: string;
  body: string;
  labels: GithubLabel[];
  /** Os 50 últimos, do mais antigo ao mais novo; `commentCount` é o total. */
  comments: GithubComment[];
  commentCount: number;
};

export type GithubIssueDetail = ItemBase & { kind: 'issue'; stateReason: string | null };

export type MergeMethod = 'merge' | 'squash' | 'rebase';

export type GithubPullDetail = ItemBase & {
  kind: 'pr';
  draft: boolean;
  base: string;
  branch: string;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  review: GithubPull['review'];
  additions: number;
  deletions: number;
  changedFiles: number;
  commitCount: number;
  checks: GithubCheck[];
  /** Os 100 primeiros arquivos; `changedFiles` é o total. */
  files: GithubFile[];
  reviews: GithubReview[];
  /** O que o GitHub diz do merge agora: `CLEAN` pronto, `BLOCKED` falta revisão ou check, `BEHIND` atrás da base… */
  mergeState: string;
  /** De um fork: a branch é de outro repositório, e não dá para apagar daqui. */
  crossRepo: boolean;
  /** Os jeitos de merge que o repositório aceita, e o que o GitHub sugere para quem está logado. */
  mergeMethods: MergeMethod[];
  defaultMethod: MergeMethod;
  /** O repositório apaga a branch sozinho depois do merge. */
  deleteBranchOnMerge: boolean;
};

/** `viewer`: o login do `gh` deste PC; `repoLabels`: as etiquetas do repositório, para pôr e tirar. */
export type GithubItem =
  | {
      ok: true;
      repo: string;
      viewer: string;
      repoLabels: GithubLabel[];
      item: GithubIssueDetail | GithubPullDetail;
      fetchedAt: number;
      quota: GithubQuota | null;
    }
  | Failure;

const COMMON = `number title url state body createdAt updatedAt author { login } viewerDidAuthor
  assignees(first: 10) { nodes { login } }
  labels(first: 20) { nodes { name color } }
  comments(last: 50) { totalCount nodes { author { login } body createdAt url } }`;

// O que todo item precisa do repositório e de quem está logado: as etiquetas, para pôr e tirar.
const AROUND = `labels(first: 100, orderBy: {field: NAME, direction: ASC}) { nodes { name color } }`;

const ISSUE_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  rateLimit { remaining limit resetAt }
  viewer { login }
  repository(owner: $owner, name: $name) {
    ${AROUND}
    issue(number: $number) { ${COMMON} stateReason }
  }
}`;

const PULL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  rateLimit { remaining limit resetAt }
  viewer { login }
  repository(owner: $owner, name: $name) {
    ${AROUND}
    mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed deleteBranchOnMerge viewerDefaultMergeMethod
    pullRequest(number: $number) {
      ${COMMON} isDraft baseRefName headRefName mergeable mergeStateStatus isCrossRepository reviewDecision additions deletions changedFiles
      commits(last: 1) { totalCount nodes { commit { statusCheckRollup { contexts(first: 50) { nodes {
        __typename
        ... on CheckRun { name conclusion status detailsUrl }
        ... on StatusContext { context state targetUrl }
      } } } } } }
      files(first: 100) { nodes { path additions deletions changeType } }
      reviews(last: 30) { nodes { author { login } state body submittedAt } }
    }
  }
}`;

type RawComment = { author: { login: string } | null; body: string; createdAt: string; url: string };
type RawCommon = {
  number: number;
  title: string;
  url: string;
  state: ItemBase['state'];
  body: string;
  createdAt: string;
  updatedAt: string;
  author: { login: string } | null;
  viewerDidAuthor: boolean;
  assignees: { nodes: { login: string }[] };
  labels: { nodes: GithubLabel[] };
  comments: { totalCount: number; nodes: RawComment[] };
};
type RawAround = { labels: { nodes: GithubLabel[] } };
type RawMergeRules = {
  mergeCommitAllowed: boolean;
  squashMergeAllowed: boolean;
  rebaseMergeAllowed: boolean;
  deleteBranchOnMerge: boolean;
  viewerDefaultMergeMethod: 'MERGE' | 'SQUASH' | 'REBASE';
};
type RawContext =
  | { __typename: 'CheckRun'; name: string; conclusion: string | null; status: string; detailsUrl: string | null }
  | { __typename: 'StatusContext'; context: string; state: string; targetUrl: string | null };
type RawIssueDetail = RawCommon & { stateReason: string | null };
type RawPullDetail = RawCommon & {
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  mergeable: GithubPullDetail['mergeable'];
  mergeStateStatus: string;
  isCrossRepository: boolean;
  reviewDecision: GithubPull['review'];
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: { totalCount: number; nodes: { commit: { statusCheckRollup: { contexts: { nodes: RawContext[] } } | null } }[] };
  files: { nodes: { path: string; additions: number; deletions: number; changeType: string }[] } | null;
  reviews: { nodes: { author: { login: string } | null; state: GithubReview['state']; body: string; submittedAt: string | null }[] };
};

function checkOf(c: RawContext): GithubCheck {
  if (c.__typename === 'StatusContext') {
    const result = c.state === 'SUCCESS' ? 'success' : c.state === 'FAILURE' || c.state === 'ERROR' ? 'failure' : 'pending';
    return { name: c.context, result, url: c.targetUrl };
  }
  if (c.status !== 'COMPLETED') return { name: c.name, result: 'pending', url: c.detailsUrl };
  const result =
    c.conclusion === 'SUCCESS'
      ? 'success'
      : c.conclusion === 'FAILURE' || c.conclusion === 'TIMED_OUT' || c.conclusion === 'STARTUP_FAILURE' || c.conclusion === 'ACTION_REQUIRED'
        ? 'failure'
        : 'neutral';
  return { name: c.name, result, url: c.detailsUrl };
}

function common(raw: RawCommon): ItemBase {
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    state: raw.state,
    author: raw.author?.login ?? null,
    mine: raw.viewerDidAuthor,
    assignees: raw.assignees.nodes.map((a) => a.login),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    body: raw.body,
    labels: raw.labels.nodes,
    comments: raw.comments.nodes.map((c) => ({ author: c.author?.login ?? null, body: c.body, createdAt: c.createdAt, url: c.url })),
    commentCount: raw.comments.totalCount,
  };
}

async function loadItem(cwd: string, kind: 'issue' | 'pr', number: number): Promise<GithubItem> {
  const fetchedAt = Date.now();
  const at = await repoOf(cwd, fetchedAt);
  if ('ok' in at) return at;
  const repo = `${at.owner}/${at.name}`;
  const vars = { owner: at.owner, name: at.name, number };
  const missing: Failure = { ok: false, reason: 'error', message: `${kind === 'pr' ? 'PR' : 'Issue'} #${number} não encontrado no GitHub.`, fetchedAt };
  try {
    if (kind === 'issue') {
      const data = (
        await graphql<{ data?: { viewer: { login: string }; repository: (RawAround & { issue: RawIssueDetail | null }) | null } }>(cwd, ISSUE_QUERY, vars)
      ).data;
      const raw = data?.repository?.issue;
      if (!raw) return missing;
      return {
        ok: true,
        repo,
        viewer: data.viewer.login,
        repoLabels: data.repository!.labels.nodes,
        item: { ...common(raw), kind: 'issue', stateReason: raw.stateReason },
        fetchedAt,
        quota,
      };
    }
    const data = (
      await graphql<{ data?: { viewer: { login: string }; repository: (RawAround & RawMergeRules & { pullRequest: RawPullDetail | null }) | null } }>(
        cwd,
        PULL_QUERY,
        vars,
      )
    ).data;
    const raw = data?.repository?.pullRequest;
    if (!raw) return missing;
    const rules = data.repository!;
    const methods: MergeMethod[] = [
      ...(rules.mergeCommitAllowed ? (['merge'] as const) : []),
      ...(rules.squashMergeAllowed ? (['squash'] as const) : []),
      ...(rules.rebaseMergeAllowed ? (['rebase'] as const) : []),
    ];
    const suggested = rules.viewerDefaultMergeMethod.toLowerCase() as MergeMethod;
    return {
      ok: true,
      repo,
      viewer: data.viewer.login,
      repoLabels: rules.labels.nodes,
      item: {
        ...common(raw),
        kind: 'pr',
        draft: raw.isDraft,
        base: raw.baseRefName,
        branch: raw.headRefName,
        mergeable: raw.mergeable,
        review: raw.reviewDecision,
        additions: raw.additions,
        deletions: raw.deletions,
        changedFiles: raw.changedFiles,
        commitCount: raw.commits.totalCount,
        checks: raw.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes.map(checkOf) ?? [],
        files: (raw.files?.nodes ?? []).map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions, change: f.changeType })),
        reviews: raw.reviews.nodes.map((r) => ({ author: r.author?.login ?? null, state: r.state, body: r.body, submittedAt: r.submittedAt })),
        mergeState: raw.mergeStateStatus,
        crossRepo: raw.isCrossRepository,
        mergeMethods: methods,
        defaultMethod: methods.includes(suggested) ? suggested : (methods[0] ?? 'merge'),
        deleteBranchOnMerge: rules.deleteBranchOnMerge,
      },
      fetchedAt,
      quota,
    };
  } catch (err) {
    return failure(err, fetchedAt);
  }
}

// ---- cache ----

/** Quanto uma resposta vale: abrir de novo, trocar de aba ou o celular e o PC juntos usam a mesma. */
const TTL_MS = 2 * 60_000;
/** O "atualizar" pede uma nova, mas não mais que uma a cada tanto, para não gastar a cota à toa. */
const MIN_REFRESH_MS = 15_000;

type Result = { ok: true } | { ok: false; reason: Failure['reason'] };
const cache = new Map<string, { at: number; value: Promise<Result>; failed: boolean }>();

/** Do cache enquanto vale; `refresh` busca de novo, respeitando o intervalo mínimo. */
function cached<T extends Result>(key: string, refresh: boolean, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  const age = hit ? Date.now() - hit.at : Infinity;
  // Erro (rede, GitHub fora) vale só o intervalo mínimo: a próxima abertura já tenta de novo.
  if (hit && (age < MIN_REFRESH_MS || (!refresh && !hit.failed && age < TTL_MS))) return hit.value as Promise<T>;
  // Cota baixa: o que já tem vale até ela voltar, mesmo velho ou com o "atualizar".
  if (hit && !hit.failed && quotaLow()) return hit.value as Promise<T>;
  const entry = { at: Date.now(), value: load(), failed: false };
  void entry.value.then((v) => (entry.failed = !v.ok && v.reason === 'error'));
  cache.set(key, entry);
  return entry.value;
}

/** PRs e issues abertos do projeto (as listas da barra do projeto). */
export function githubInfo(cwd: string, refresh: boolean): Promise<GithubInfo> {
  return cached(`list\n${cwd}`, refresh, () => load(cwd));
}

/** Uma issue ou um PR inteiro: descrição, comentários e, no PR, checks, revisões e arquivos. */
export function githubItem(cwd: string, kind: 'issue' | 'pr', number: number, refresh: boolean): Promise<GithubItem> {
  return cached(`${kind}\n${number}\n${cwd}`, refresh, () => loadItem(cwd, kind, number));
}

// ---- ações: o que dá para fazer no GitHub sem sair do painel ----

/**
 * Uma ação numa issue ou num PR, feita pelo `gh` deste PC, com o login dele. `review` e `merge` e
 * `draft` são só de PR. No merge, a branch é apagada pela API, e não pelo `--delete-branch` do `gh`:
 * ele também apaga a branch local e troca de branch na pasta do projeto, onde pode ter uma conversa
 * trabalhando.
 */
export type GithubAction =
  | { type: 'comment'; body: string }
  | { type: 'labels'; add: string[]; remove: string[] }
  | { type: 'state'; open: boolean; reason?: 'completed' | 'not planned' }
  | { type: 'assign'; me: boolean }
  | { type: 'review'; event: 'approve' | 'request-changes' | 'comment'; body?: string }
  | { type: 'merge'; method: MergeMethod; deleteBranch: boolean }
  | { type: 'draft'; draft: boolean };

const PR_ONLY = new Set<GithubAction['type']>(['review', 'merge', 'draft']);

/** Roda o `gh`; o erro dele (sem permissão, PR bloqueado, conflito) volta para a tela como está. */
async function run(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('gh', args, { cwd, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const f = failure(err, Date.now());
    const message = f.reason === 'no_gh' ? 'O GitHub CLI (gh) não está instalado no PC.' : f.reason === 'gh_auth' ? 'O gh do PC não está logado.' : (f.message ?? 'O GitHub recusou.');
    throw new HttpError(422, 'github_action_failed', { message });
  }
}

/** Faz a ação e devolve o item como ficou, sem cache: a tela mostra já o resultado. */
export async function githubAct(cwd: string, kind: 'issue' | 'pr', number: number, action: GithubAction): Promise<GithubItem> {
  const at = await repoOf(cwd, Date.now());
  if ('ok' in at) throw new HttpError(422, 'github_action_failed', { message: 'Este projeto não está no GitHub.' });
  if (kind === 'issue' && PR_ONLY.has(action.type)) throw new HttpError(400, 'github_action_failed', { message: 'Só dá para fazer isso num PR.' });
  const repo = `${at.owner}/${at.name}`;
  const cmd = kind === 'pr' ? 'pr' : 'issue';
  switch (action.type) {
    case 'comment':
      if (!action.body.trim()) throw new HttpError(400, 'github_action_failed', { message: 'Escreva o comentário.' });
      await run(cwd, [cmd, 'comment', String(number), '--repo', repo, '--body', action.body]);
      break;
    case 'labels': {
      if (!action.add.length && !action.remove.length) break;
      const args = [cmd, 'edit', String(number), '--repo', repo];
      for (const l of action.add) args.push('--add-label', l);
      for (const l of action.remove) args.push('--remove-label', l);
      await run(cwd, args);
      break;
    }
    case 'state':
      if (action.open) await run(cwd, [cmd, 'reopen', String(number), '--repo', repo]);
      else await run(cwd, [cmd, 'close', String(number), '--repo', repo, ...(kind === 'issue' && action.reason ? ['--reason', action.reason] : [])]);
      break;
    case 'assign':
      await run(cwd, [cmd, 'edit', String(number), '--repo', repo, action.me ? '--add-assignee' : '--remove-assignee', '@me']);
      break;
    case 'review':
      if (action.event !== 'approve' && !action.body?.trim())
        throw new HttpError(400, 'github_action_failed', { message: 'Escreva o que precisa mudar ou o comentário da revisão.' });
      await run(cwd, ['pr', 'review', String(number), '--repo', repo, `--${action.event}`, ...(action.body?.trim() ? ['--body', action.body] : [])]);
      break;
    case 'merge': {
      // A branch, do PR já carregado na tela (sem gastar outra consulta); sem ele, pergunta ao GitHub.
      const loaded = await (cache.get(`pr\n${number}\n${cwd}`)?.value as Promise<GithubItem> | undefined)?.catch(() => null);
      const head =
        loaded?.ok && loaded.item.kind === 'pr'
          ? { headRefName: loaded.item.branch, isCrossRepository: loaded.item.crossRepo }
          : (JSON.parse(await run(cwd, ['pr', 'view', String(number), '--repo', repo, '--json', 'headRefName,isCrossRepository'])) as {
              headRefName: string;
              isCrossRepository: boolean;
            });
      await run(cwd, ['pr', 'merge', String(number), '--repo', repo, `--${action.method}`]);
      if (action.deleteBranch && !head.isCrossRepository) {
        // Já apagada (o repositório apaga sozinho depois do merge) não é erro.
        await run(cwd, ['api', '-X', 'DELETE', `repos/${repo}/git/refs/heads/${head.headRefName.split('/').map(encodeURIComponent).join('/')}`]).catch(
          () => undefined,
        );
      }
      break;
    }
    case 'draft':
      await run(cwd, ['pr', 'ready', String(number), '--repo', repo, ...(action.draft ? ['--undo'] : [])]);
      break;
  }
  // O que estava guardado ficou velho: a lista da barra do projeto e o próprio item.
  cache.delete(`list\n${cwd}`);
  cache.delete(`${kind}\n${number}\n${cwd}`);
  return githubItem(cwd, kind, number, false);
}
