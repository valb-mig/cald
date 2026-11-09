import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { HttpError } from './errors.ts';
import { git, gitCreateBranch, gitStage, gitStatus, gitWrite, requireRepo, type GitFile } from './git.ts';

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

/** `avatar`: a foto de quem escreveu; `role`: a relação com o repositório (OWNER, MEMBER, CONTRIBUTOR…). */
export type GithubComment = { author: string | null; avatar: string | null; role: string; body: string; createdAt: string; url: string };

export type GithubReview = {
  author: string | null;
  avatar: string | null;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  body: string;
  submittedAt: string | null;
};

/** Um check do último commit, com o resultado já resumido: passou, falhou, rodando ou neutro (pulado, cancelado). */
export type GithubCheck = { name: string; result: 'success' | 'failure' | 'pending' | 'neutral'; url: string | null };

/** `viewed`: você marcou o arquivo como visto nesta versão do PR (o GitHub desmarca quando ele muda). */
export type GithubFile = { path: string; additions: number; deletions: number; change: string; viewed: boolean };

/** Um comentário de uma conversa de revisão; `pending`: está na sua revisão ainda não enviada (só você vê). */
export type GithubThreadComment = {
  id: string;
  author: string | null;
  avatar: string | null;
  role: string;
  body: string;
  createdAt: string;
  url: string;
  pending: boolean;
  canEdit: boolean;
  canDelete: boolean;
};

/**
 * Uma conversa de revisão presa a uma linha (ou a um trecho, de `startLine` a `line`) de um arquivo, do
 * lado novo (`RIGHT`) ou do antigo (`LEFT`) do diff. `line` é nulo quando o código mudou depois e ela não
 * aponta mais para a versão atual (`outdated`); aí vale o `hunk`, o trecho do diff de quando foi escrita.
 */
export type GithubThread = {
  id: string;
  path: string;
  line: number | null;
  startLine: number | null;
  side: 'LEFT' | 'RIGHT';
  originalLine: number | null;
  outdated: boolean;
  resolved: boolean;
  resolvedBy: string | null;
  canReply: boolean;
  canResolve: boolean;
  canUnresolve: boolean;
  hunk: string;
  comments: GithubThreadComment[];
};

/** Um commit do PR, para a aba de commits e para a linha do tempo. */
export type GithubCommit = { sha: string; short: string; headline: string; author: string | null; avatar: string | null; date: string; url: string };

type ItemBase = {
  number: number;
  title: string;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  author: string | null;
  authorAvatar: string | null;
  /** A relação de quem abriu com o repositório: OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR… */
  authorRole: string;
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
  /** O id do PR na API GraphQL, para as ações de revisão. */
  id: string;
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
  /** Os 50 últimos, do mais antigo ao mais novo; `commitCount` é o total. */
  commits: GithubCommit[];
  /** O que o GitHub diz do merge agora: `CLEAN` pronto, `BLOCKED` falta revisão ou check, `BEHIND` atrás da base… */
  mergeState: string;
  /** De um fork: a branch é de outro repositório, e não dá para apagar daqui. */
  crossRepo: boolean;
  /** Os jeitos de merge que o repositório aceita, e o que o GitHub sugere para quem está logado. */
  mergeMethods: MergeMethod[];
  defaultMethod: MergeMethod;
  /** O repositório apaga a branch sozinho depois do merge. */
  deleteBranchOnMerge: boolean;
  /** As conversas de revisão nas linhas dos arquivos (as 100 primeiras), com as suas pendentes. */
  threads: GithubThread[];
  /** A sua revisão começada e ainda não enviada: os comentários dela só você vê. */
  pendingReview: { id: string; comments: number } | null;
};

/** `viewer`: o login do `gh` deste PC; `repoLabels`: as etiquetas do repositório, para pôr e tirar. */
export type GithubItem =
  | {
      ok: true;
      repo: string;
      viewer: string;
      viewerAvatar: string | null;
      repoLabels: GithubLabel[];
      item: GithubIssueDetail | GithubPullDetail;
      fetchedAt: number;
      quota: GithubQuota | null;
    }
  | Failure;

const COMMON = `number title url state body createdAt updatedAt author { login avatarUrl(size: 64) } authorAssociation viewerDidAuthor
  assignees(first: 10) { nodes { login } }
  labels(first: 20) { nodes { name color } }
  comments(last: 50) { totalCount nodes { author { login avatarUrl(size: 64) } authorAssociation body createdAt url } }`;

// O que todo item precisa do repositório e de quem está logado: as etiquetas, para pôr e tirar.
const AROUND = `labels(first: 100, orderBy: {field: NAME, direction: ASC}) { nodes { name color } }`;

const ISSUE_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  rateLimit { remaining limit resetAt }
  viewer { login avatarUrl(size: 64) }
  repository(owner: $owner, name: $name) {
    ${AROUND}
    issue(number: $number) { ${COMMON} stateReason }
  }
}`;

const PULL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  rateLimit { remaining limit resetAt }
  viewer { login avatarUrl(size: 64) }
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
      id
      files(first: 100) { nodes { path additions deletions changeType viewerViewedState } }
      pending: reviews(states: PENDING, first: 1) { nodes { id comments { totalCount } } }
      reviewThreads(first: 100) { nodes {
        id path line startLine diffSide originalLine isOutdated isResolved resolvedBy { login } viewerCanReply viewerCanResolve viewerCanUnresolve
        comments(first: 50) { nodes { id author { login avatarUrl(size: 64) } authorAssociation body createdAt url diffHunk state viewerCanUpdate viewerCanDelete } }
      } }
      reviews(last: 30) { nodes { author { login avatarUrl(size: 64) } state body submittedAt } }
      commitList: commits(last: 50) { nodes { commit {
        oid abbreviatedOid messageHeadline committedDate url author { name user { login avatarUrl(size: 64) } }
      } } }
    }
  }
}`;

type RawAuthor = { login: string; avatarUrl?: string } | null;
type RawComment = { author: RawAuthor; authorAssociation?: string; body: string; createdAt: string; url: string };
type RawCommon = {
  number: number;
  title: string;
  url: string;
  state: ItemBase['state'];
  body: string;
  createdAt: string;
  updatedAt: string;
  author: RawAuthor;
  authorAssociation?: string;
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
  id: string;
  files: { nodes: { path: string; additions: number; deletions: number; changeType: string; viewerViewedState: string }[] } | null;
  pending: { nodes: { id: string; comments: { totalCount: number } }[] };
  reviewThreads: {
    nodes: {
      id: string;
      path: string;
      line: number | null;
      startLine: number | null;
      diffSide: 'LEFT' | 'RIGHT';
      originalLine: number | null;
      isOutdated: boolean;
      isResolved: boolean;
      resolvedBy: { login: string } | null;
      viewerCanReply: boolean;
      viewerCanResolve: boolean;
      viewerCanUnresolve: boolean;
      comments: {
        nodes: (RawComment & { id: string; diffHunk: string; state: 'PENDING' | 'SUBMITTED'; viewerCanUpdate: boolean; viewerCanDelete: boolean })[];
      };
    }[];
  };
  reviews: { nodes: { author: RawAuthor; state: GithubReview['state']; body: string; submittedAt: string | null }[] };
  commitList: {
    nodes: {
      commit: {
        oid: string;
        abbreviatedOid: string;
        messageHeadline: string;
        committedDate: string;
        url: string;
        author: { name: string | null; user: RawAuthor } | null;
      };
    }[];
  };
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
    authorAvatar: raw.author?.avatarUrl ?? null,
    authorRole: raw.authorAssociation ?? 'NONE',
    mine: raw.viewerDidAuthor,
    assignees: raw.assignees.nodes.map((a) => a.login),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    body: raw.body,
    labels: raw.labels.nodes,
    comments: raw.comments.nodes.map((c) => ({
      author: c.author?.login ?? null,
      avatar: c.author?.avatarUrl ?? null,
      role: c.authorAssociation ?? 'NONE',
      body: c.body,
      createdAt: c.createdAt,
      url: c.url,
    })),
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
        await graphql<{ data?: { viewer: { login: string; avatarUrl?: string }; repository: (RawAround & { issue: RawIssueDetail | null }) | null } }>(
          cwd,
          ISSUE_QUERY,
          vars,
        )
      ).data;
      const raw = data?.repository?.issue;
      if (!raw) return missing;
      return {
        ok: true,
        repo,
        viewer: data.viewer.login,
        viewerAvatar: data.viewer.avatarUrl ?? null,
        repoLabels: data.repository!.labels.nodes,
        item: { ...common(raw), kind: 'issue', stateReason: raw.stateReason },
        fetchedAt,
        quota,
      };
    }
    const data = (
      await graphql<{
        data?: { viewer: { login: string; avatarUrl?: string }; repository: (RawAround & RawMergeRules & { pullRequest: RawPullDetail | null }) | null };
      }>(
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
      viewerAvatar: data.viewer.avatarUrl ?? null,
      repoLabels: rules.labels.nodes,
      item: {
        ...common(raw),
        kind: 'pr',
        id: raw.id,
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
        files: (raw.files?.nodes ?? []).map((f) => ({
          path: f.path,
          additions: f.additions,
          deletions: f.deletions,
          change: f.changeType,
          viewed: f.viewerViewedState === 'VIEWED',
        })),
        reviews: raw.reviews.nodes.map((r) => ({
          author: r.author?.login ?? null,
          avatar: r.author?.avatarUrl ?? null,
          state: r.state,
          body: r.body,
          submittedAt: r.submittedAt,
        })),
        commits: raw.commitList.nodes.map(({ commit: c }) => ({
          sha: c.oid,
          short: c.abbreviatedOid,
          headline: c.messageHeadline,
          author: c.author?.user?.login ?? c.author?.name ?? null,
          avatar: c.author?.user?.avatarUrl ?? null,
          date: c.committedDate,
          url: c.url,
        })),
        mergeState: raw.mergeStateStatus,
        crossRepo: raw.isCrossRepository,
        mergeMethods: methods,
        defaultMethod: methods.includes(suggested) ? suggested : (methods[0] ?? 'merge'),
        deleteBranchOnMerge: rules.deleteBranchOnMerge,
        threads: raw.reviewThreads.nodes
          .filter((t) => t.comments.nodes.length)
          .map((t) => ({
            id: t.id,
            path: t.path,
            line: t.line,
            startLine: t.startLine,
            side: t.diffSide,
            originalLine: t.originalLine,
            outdated: t.isOutdated,
            resolved: t.isResolved,
            resolvedBy: t.resolvedBy?.login ?? null,
            canReply: t.viewerCanReply,
            canResolve: t.viewerCanResolve,
            canUnresolve: t.viewerCanUnresolve,
            hunk: t.comments.nodes[0]!.diffHunk,
            comments: t.comments.nodes.map((c) => ({
              id: c.id,
              author: c.author?.login ?? null,
              avatar: c.author?.avatarUrl ?? null,
              role: c.authorAssociation ?? 'NONE',
              body: c.body,
              createdAt: c.createdAt,
              url: c.url,
              pending: c.state === 'PENDING',
              canEdit: c.viewerCanUpdate,
              canDelete: c.viewerCanDelete,
            })),
          })),
        pendingReview: raw.pending.nodes[0] ? { id: raw.pending.nodes[0].id, comments: raw.pending.nodes[0].comments.totalCount } : null,
      },
      fetchedAt,
      quota,
    };
  } catch (err) {
    return failure(err, fetchedAt);
  }
}

// ---- a inbox: o que pede você em todo o GitHub da conta, não só nos repositórios dos projetos ----

/**
 * Por que um PR ou uma issue está na inbox: pedem sua revisão; um PR seu com check falhando, mudança
 * pedida, conflito ou aprovado e pronto para o merge; uma issue atribuída a você; ou te mencionaram.
 */
export type InboxReason = 'review' | 'checks' | 'changes' | 'conflict' | 'ready' | 'assigned' | 'mentioned';
export type InboxGithubItem = {
  kind: 'pr' | 'issue';
  reason: InboxReason;
  /** "dono/nome" e o endereço do repositório, para achar o projeto local que é clone dele. */
  repo: string;
  repoUrl: string;
  number: number;
  title: string;
  url: string;
  author: string | null;
  updatedAt: string;
  labels: GithubLabel[];
};
export type GithubInbox = { ok: true; viewer: string; items: InboxGithubItem[]; fetchedAt: number } | Failure;

const INBOX_QUERY = `query {
  rateLimit { remaining limit resetAt }
  viewer { login }
  review: search(type: ISSUE, first: 25, query: "is:open is:pr archived:false review-requested:@me sort:updated-desc") { nodes { ...pr } }
  mine: search(type: ISSUE, first: 40, query: "is:open is:pr archived:false author:@me sort:updated-desc") { nodes { ...pr } }
  assigned: search(type: ISSUE, first: 25, query: "is:open is:issue archived:false assignee:@me sort:updated-desc") { nodes { ...issue } }
  mentioned: search(type: ISSUE, first: 25, query: "is:open archived:false mentions:@me sort:updated-desc") { nodes { ...issue ...pr } }
}
fragment pr on PullRequest {
  __typename number title url updatedAt isDraft reviewDecision mergeable
  repository { nameWithOwner url } author { login } labels(first: 6) { nodes { name color } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}
fragment issue on Issue {
  __typename number title url updatedAt repository { nameWithOwner url } author { login } labels(first: 6) { nodes { name color } }
}`;

type InboxNode = {
  __typename?: 'PullRequest' | 'Issue';
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  isDraft?: boolean;
  reviewDecision?: GithubPull['review'];
  mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  repository: { nameWithOwner: string; url: string };
  author: { login: string } | null;
  labels?: { nodes: GithubLabel[] };
  commits?: { nodes: { commit: { statusCheckRollup: { state: GithubPull['checks'] } | null } }[] };
};
type InboxRaw = { data?: { viewer: { login: string }; review: { nodes: InboxNode[] }; mine: { nodes: InboxNode[] }; assigned: { nodes: InboxNode[] }; mentioned: { nodes: InboxNode[] } } };

/** O que um PR seu pede de você; `null` se está esperando outra pessoa (revisão, checks rodando). */
function mineReason(n: InboxNode): InboxReason | null {
  const checks = n.commits?.nodes[0]?.commit.statusCheckRollup?.state;
  if (checks === 'FAILURE' || checks === 'ERROR') return 'checks';
  if (n.reviewDecision === 'CHANGES_REQUESTED') return 'changes';
  if (n.mergeable === 'CONFLICTING') return 'conflict';
  if (!n.isDraft && n.reviewDecision === 'APPROVED' && checks !== 'PENDING' && checks !== 'EXPECTED') return 'ready';
  return null;
}

async function loadInbox(): Promise<GithubInbox> {
  const fetchedAt = Date.now();
  try {
    const data = (await graphql<InboxRaw>(homedir(), INBOX_QUERY, {})).data;
    if (!data) return { ok: false, reason: 'error', message: 'O GitHub não respondeu à busca.', fetchedAt };
    const items = new Map<string, InboxGithubItem>();
    // Na ordem de urgência: o mesmo PR pedindo sua revisão e te mencionando fica como revisão.
    const add = (n: InboxNode, reason: InboxReason | null) => {
      if (!reason || !n?.url || items.has(n.url)) return;
      items.set(n.url, {
        kind: n.__typename === 'Issue' ? 'issue' : 'pr',
        reason,
        repo: n.repository.nameWithOwner,
        repoUrl: n.repository.url,
        number: n.number,
        title: n.title,
        url: n.url,
        author: n.author?.login ?? null,
        updatedAt: n.updatedAt,
        labels: n.labels?.nodes ?? [],
      });
    };
    for (const n of data.review.nodes) add(n, 'review');
    for (const n of data.mine.nodes) add(n, mineReason(n));
    for (const n of data.assigned.nodes) add(n, 'assigned');
    // Mencionado num PR seu ou que você revisa já entrou acima; o resto é menção mesmo.
    for (const n of data.mentioned.nodes) if (n.author?.login !== data.viewer.login) add(n, 'mentioned');
    return { ok: true, viewer: data.viewer.login, items: [...items.values()], fetchedAt };
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

/** O que pede você em todo o GitHub da conta (a inbox), com o mesmo cache e a mesma cota das listas. */
export function githubInbox(refresh: boolean): Promise<GithubInbox> {
  return cached('inbox', refresh, loadInbox);
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
 * Uma ação numa issue ou num PR, feita pelo `gh` deste PC, com o login dele. Revisar, dar merge, o
 * rascunho e tudo das linhas são só de PR. No merge, a branch é apagada pela API, e não pelo
 * `--delete-branch` do `gh`: ele também apaga a branch local e troca de branch na pasta do projeto, onde
 * pode ter uma conversa trabalhando.
 *
 * Nas linhas, como no GitHub: um comentário vai na hora (`now`) ou entra na sua revisão pendente (que
 * nasce com ele), e só sai com o `review`, junto com o veredito. `line` e `side` são a linha e o lado do
 * diff (`RIGHT`, o arquivo novo; `LEFT`, o antigo); com `startLine`, o comentário pega o trecho.
 */
export type GithubAction =
  | { type: 'comment'; body: string }
  | { type: 'labels'; add: string[]; remove: string[] }
  | { type: 'state'; open: boolean; reason?: 'completed' | 'not planned' }
  | { type: 'assign'; me: boolean }
  | { type: 'review'; event: 'approve' | 'request-changes' | 'comment'; body?: string }
  | { type: 'merge'; method: MergeMethod; deleteBranch: boolean }
  | { type: 'draft'; draft: boolean }
  | { type: 'edit'; title?: string; body?: string }
  | ({ type: 'line-comment'; now: boolean } & LineComment)
  /** Vários de uma vez na revisão pendente (os que um agente escreveu, ver pull-review-plan.ts). */
  | { type: 'line-comments'; comments: LineComment[] }
  | { type: 'reply'; thread: string; body: string }
  | { type: 'resolve'; thread: string; resolved: boolean }
  | { type: 'edit-comment'; comment: string; body: string }
  | { type: 'delete-comment'; comment: string }
  | { type: 'discard-review' }
  | { type: 'viewed'; path: string; viewed: boolean };

export type DiffSide = 'LEFT' | 'RIGHT';
/** Um comentário numa linha (ou no trecho de `startLine` a `line`) de um arquivo, num lado do diff. */
export type LineComment = { path: string; line: number; side: DiffSide; startLine?: number; startSide?: DiffSide; body: string };

const PR_ONLY = new Set<GithubAction['type']>(['review', 'merge', 'draft', 'line-comment', 'line-comments', 'reply', 'resolve', 'edit-comment', 'delete-comment', 'discard-review', 'viewed']);

// O id do PR e o da sua revisão pendente, que as mutações da revisão pedem: sempre de agora, porque a
// pendente nasce e some com as ações (e de outro aparelho).
const IDS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { id pending: reviews(states: PENDING, first: 1) { nodes { id } } } }
}`;

const THREAD_FIELDS = `path: $path, line: $line, side: $side, startLine: $startLine, startSide: $startSide, body: $body`;
const THREAD_VARS = `$path: String!, $line: Int!, $side: DiffSide!, $startLine: Int, $startSide: DiffSide, $body: String!`;
// Sem revisão pendente: uma nova com o comentário, que fica pendente ou (com `event`) já sai como um comentário só.
const NEW_REVIEW = (submit: boolean) => `mutation($pr: ID!, ${THREAD_VARS}) {
  addPullRequestReview(input: {pullRequestId: $pr, ${submit ? 'event: COMMENT, ' : ''}threads: [{${THREAD_FIELDS}}]}) { pullRequestReview { id } }
}`;
const NEW_REVIEW_MANY = `mutation($pr: ID!, $threads: [DraftPullRequestReviewThread]) {
  addPullRequestReview(input: {pullRequestId: $pr, threads: $threads}) { pullRequestReview { id } }
}`;
const ADD_THREAD = `mutation($review: ID!, ${THREAD_VARS}) {
  addPullRequestReviewThread(input: {pullRequestReviewId: $review, ${THREAD_FIELDS}}) { thread { id } }
}`;
const REPLY = `mutation($thread: ID!, $body: String!, $review: ID) {
  addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $thread, body: $body, pullRequestReviewId: $review}) { comment { id } }
}`;
const RESOLVE = (resolved: boolean) => `mutation($thread: ID!) {
  ${resolved ? 'resolveReviewThread' : 'unresolveReviewThread'}(input: {threadId: $thread}) { thread { id } }
}`;
const EDIT_COMMENT = `mutation($comment: ID!, $body: String!) {
  updatePullRequestReviewComment(input: {pullRequestReviewCommentId: $comment, body: $body}) { pullRequestReviewComment { id } }
}`;
const DELETE_COMMENT = `mutation($comment: ID!) { deletePullRequestReviewComment(input: {id: $comment}) { clientMutationId } }`;
const SUBMIT_REVIEW = `mutation($review: ID!, $event: PullRequestReviewEvent!, $body: String) {
  submitPullRequestReview(input: {pullRequestReviewId: $review, event: $event, body: $body}) { pullRequestReview { id } }
}`;
const DISCARD_REVIEW = `mutation($review: ID!) { deletePullRequestReview(input: {pullRequestReviewId: $review}) { clientMutationId } }`;
const VIEWED = (viewed: boolean) => `mutation($pr: ID!, $path: String!) {
  ${viewed ? 'markFileAsViewed' : 'unmarkFileAsViewed'}(input: {pullRequestId: $pr, path: $path}) { clientMutationId }
}`;

/** O erro do `gh` como ele veio, para a tela. */
function actionError(err: unknown): HttpError {
  const f = failure(err, Date.now());
  const message = f.reason === 'no_gh' ? 'O GitHub CLI (gh) não está instalado no PC.' : f.reason === 'gh_auth' ? 'O gh do PC não está logado.' : (f.message ?? 'O GitHub recusou.');
  return new HttpError(422, 'github_action_failed', { message: message.replace(/^gh: /, '') });
}

/** Uma mutação da API GraphQL; as variáveis sem valor ficam de fora (valem nulas). */
async function mutate(cwd: string, query: string, vars: Record<string, string | number | undefined>): Promise<void> {
  const given = Object.fromEntries(Object.entries(vars).filter(([, v]) => v !== undefined)) as Record<string, string | number>;
  try {
    await graphql(cwd, query, given);
  } catch (err) {
    throw actionError(err);
  }
}

/** Uma mutação com variáveis que não cabem no `-f` do `gh` (uma lista de objetos): o corpo vai pela entrada padrão. */
async function mutateInput(cwd: string, query: string, variables: Record<string, unknown>): Promise<void> {
  try {
    const call = exec('gh', ['api', 'graphql', '--input', '-'], { cwd, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
    call.child.stdin?.end(JSON.stringify({ query, variables }));
    await call;
  } catch (err) {
    throw actionError(err);
  }
}

/** O comentário como o GitHub pede: o começo do trecho só quando há trecho. */
const threadOf = (c: LineComment) => ({
  path: c.path,
  line: c.line,
  side: c.side,
  startLine: c.startLine,
  startSide: c.startLine ? (c.startSide ?? c.side) : undefined,
  body: c.body,
});

async function pullIds(cwd: string, owner: string, name: string, number: number): Promise<{ pr: string; pending: string | null }> {
  type Raw = { data?: { repository: { pullRequest: { id: string; pending: { nodes: { id: string }[] } } | null } | null } };
  let raw: Raw;
  try {
    raw = await graphql<Raw>(cwd, IDS_QUERY, { owner, name, number });
  } catch (err) {
    throw actionError(err);
  }
  const pr = raw.data?.repository?.pullRequest;
  if (!pr) throw new HttpError(404, 'github_action_failed', { message: `PR #${number} não encontrado no GitHub.` });
  return { pr: pr.id, pending: pr.pending.nodes[0]?.id ?? null };
}

const needBody = (body: string) => {
  if (!body.trim()) throw new HttpError(400, 'github_action_failed', { message: 'Escreva o comentário.' });
};

/** Roda o `gh`; o erro dele (sem permissão, PR bloqueado, conflito) volta para a tela como está. */
async function run(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('gh', args, { cwd, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    throw actionError(err);
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
    case 'review': {
      // Com revisão pendente, ela é que sai, com os comentários das linhas: aí o texto pode ficar vazio.
      const { pending } = await pullIds(cwd, at.owner, at.name, number);
      if (action.event !== 'approve' && !action.body?.trim() && !pending)
        throw new HttpError(400, 'github_action_failed', { message: 'Escreva o que precisa mudar ou o comentário da revisão.' });
      if (pending) {
        const event = action.event === 'approve' ? 'APPROVE' : action.event === 'request-changes' ? 'REQUEST_CHANGES' : 'COMMENT';
        await mutate(cwd, SUBMIT_REVIEW, { review: pending, event, body: action.body?.trim() || undefined });
      } else {
        await run(cwd, ['pr', 'review', String(number), '--repo', repo, `--${action.event}`, ...(action.body?.trim() ? ['--body', action.body] : [])]);
      }
      break;
    }
    case 'line-comment': {
      needBody(action.body);
      const ids = await pullIds(cwd, at.owner, at.name, number);
      const thread = threadOf(action);
      // Com uma revisão pendente, o GitHub não deixa comentar na hora: o comentário entra nela.
      if (ids.pending) await mutate(cwd, ADD_THREAD, { review: ids.pending, ...thread });
      else await mutate(cwd, NEW_REVIEW(action.now), { pr: ids.pr, ...thread });
      break;
    }
    case 'line-comments': {
      const list = action.comments.filter((c) => c.body.trim());
      if (!list.length) break;
      const ids = await pullIds(cwd, at.owner, at.name, number);
      // Sem revisão pendente, uma nova já com todos (num pedido só, que entra inteiro ou nada); com ela, um a um.
      if (!ids.pending) await mutateInput(cwd, NEW_REVIEW_MANY, { pr: ids.pr, threads: list.map(threadOf) });
      else for (const c of list) await mutate(cwd, ADD_THREAD, { review: ids.pending, ...threadOf(c) });
      break;
    }
    case 'reply': {
      needBody(action.body);
      // Como no GitHub: com uma revisão pendente, a resposta entra nela; sem, vai na hora.
      const { pending } = await pullIds(cwd, at.owner, at.name, number);
      await mutate(cwd, REPLY, { thread: action.thread, body: action.body, review: pending ?? undefined });
      break;
    }
    case 'resolve':
      await mutate(cwd, RESOLVE(action.resolved), { thread: action.thread });
      break;
    case 'edit-comment':
      needBody(action.body);
      await mutate(cwd, EDIT_COMMENT, { comment: action.comment, body: action.body });
      break;
    case 'delete-comment':
      await mutate(cwd, DELETE_COMMENT, { comment: action.comment });
      break;
    case 'discard-review': {
      const { pending } = await pullIds(cwd, at.owner, at.name, number);
      if (pending) await mutate(cwd, DISCARD_REVIEW, { review: pending });
      break;
    }
    case 'viewed': {
      // O id do PR não muda: do que já está na tela, sem gastar outra consulta.
      const key = `pr\n${number}\n${cwd}`;
      const loaded = await (cache.get(key)?.value as Promise<GithubItem> | undefined)?.catch(() => null);
      const id = loaded?.ok && loaded.item.kind === 'pr' ? loaded.item.id : (await pullIds(cwd, at.owner, at.name, number)).pr;
      await mutate(cwd, VIEWED(action.viewed), { pr: id, path: action.path });
      // Marcar como visto não muda mais nada no PR: a resposta é a de antes com o arquivo marcado, sem
      // buscar o PR de novo (marcar os arquivos um a um gastaria uma consulta cada).
      if (loaded?.ok && loaded.item.kind === 'pr') {
        const pr = loaded.item;
        const next: GithubItem = { ...loaded, item: { ...pr, files: pr.files.map((f) => (f.path === action.path ? { ...f, viewed: action.viewed } : f)) } };
        cache.set(key, { at: cache.get(key)?.at ?? Date.now(), value: Promise.resolve(next), failed: false });
        return next;
      }
      break;
    }
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
    case 'edit': {
      if (action.title !== undefined && !action.title.trim()) throw new HttpError(400, 'github_action_failed', { message: 'O título não pode ficar vazio.' });
      const args = [cmd, 'edit', String(number), '--repo', repo];
      if (action.title !== undefined) args.push('--title', action.title.trim());
      if (action.body !== undefined) args.push('--body', action.body);
      await run(cwd, args);
      break;
    }
  }
  // O que estava guardado ficou velho: a lista da barra do projeto e o próprio item.
  cache.delete(`list\n${cwd}`);
  cache.delete(`${kind}\n${number}\n${cwd}`);
  return githubItem(cwd, kind, number, false);
}

// ---- os diffs de um PR ou de um commit ----

/** Um arquivo mudado, com o trecho do diff (`patch`); `null` em binário ou diff grande demais para a API. */
export type GithubPatch = { path: string; previous: string | null; status: string; additions: number; deletions: number; patch: string | null };

const PATCH_TTL_MS = 2 * 60_000;
const patches = new Map<string, { at: number; value: Promise<GithubPatch[]> }>();
const PATCH_FIELDS = '{path: .filename, previous: .previous_filename, status, additions, deletions, patch}';

/**
 * Os arquivos de um PR (`pr`) ou de um commit (`sha`), com o diff de cada um, pela API REST: um commit
 * não muda, e a lista do PR vale 2 min, como o resto do GitHub daqui.
 */
export async function githubPatches(cwd: string, target: { pr: number } | { sha: string }): Promise<{ files: GithubPatch[] }> {
  const at = await repoOf(cwd, Date.now());
  if ('ok' in at) throw new HttpError(422, 'github_action_failed', { message: 'Este projeto não está no GitHub.' });
  const repo = `${at.owner}/${at.name}`;
  if ('sha' in target && !/^[0-9a-f]{7,40}$/i.test(target.sha)) throw new HttpError(400, 'invalid_sha');
  const key = 'pr' in target ? `pr\n${target.pr}\n${cwd}` : `sha\n${target.sha}\n${cwd}`;
  const hit = patches.get(key);
  if (hit && ('sha' in target || Date.now() - hit.at < PATCH_TTL_MS)) return { files: await hit.value };
  const args =
    'pr' in target
      ? ['api', '--paginate', `repos/${repo}/pulls/${target.pr}/files?per_page=100`, '--jq', `.[] | ${PATCH_FIELDS}`]
      : ['api', `repos/${repo}/commits/${target.sha}`, '--jq', `.files[] | ${PATCH_FIELDS}`];
  const value = run(cwd, args).then((out) =>
    out
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as GithubPatch),
  );
  patches.set(key, { at: Date.now(), value });
  value.catch(() => patches.delete(key));
  return { files: await value };
}

// ---- abrir um PR pelo edit.r ----

/** Um commit da branch que ainda não está na principal: vai junto no PR. */
export type DraftCommit = { sha: string; short: string; headline: string };

/** O que a tela de abrir PR precisa: o repositório, as etiquetas, a principal e o que a branch tem de novo. */
export type PullDraftInfo =
  | {
      ok: true;
      repo: string;
      viewer: string;
      viewerAvatar: string | null;
      labels: GithubLabel[];
      /** A principal do repositório, onde o PR entra por padrão, e as outras branches do origin. */
      base: string;
      bases: string[];
      branch: string | null;
      /** Na principal: o PR precisa de uma branch nova, que sai daqui levando o que for escolhido. */
      onBase: boolean;
      files: GitFile[];
      commits: DraftCommit[];
      /** Um PR já aberto desta branch: em vez de outro, a tela leva até ele. */
      existing: { number: number; url: string; title: string } | null;
      fetchedAt: number;
    }
  | Failure;

export async function githubDraft(cwd: string): Promise<PullDraftInfo> {
  const fetchedAt = Date.now();
  const at = await repoOf(cwd, fetchedAt);
  if ('ok' in at) return at;
  const status = await gitStatus(cwd);
  if (!status) return { ok: false, reason: 'no_remote', fetchedAt };
  try {
    const res = await graphql<{
      data?: {
        viewer: { login: string; avatarUrl?: string };
        repository: {
          defaultBranchRef: { name: string } | null;
          labels: { nodes: GithubLabel[] };
          pullRequests: { nodes: { number: number; url: string; title: string }[] };
        } | null;
      };
    }>(
      cwd,
      `query($owner: String!, $name: String!, $head: String!) {
        rateLimit { remaining limit resetAt }
        viewer { login avatarUrl }
        repository(owner: $owner, name: $name) {
          defaultBranchRef { name }
          labels(first: 100, orderBy: {field: NAME, direction: ASC}) { nodes { name color } }
          pullRequests(headRefName: $head, states: OPEN, first: 1) { nodes { number url title } }
        }
      }`,
      { owner: at.owner, name: at.name, head: status.branch ?? '' },
    );
    const repo = res.data?.repository;
    if (!res.data || !repo) return { ok: false, reason: 'error', message: 'O GitHub não achou o repositório.', fetchedAt };
    const base = repo.defaultBranchRef?.name ?? 'main';
    const onBase = status.branch === base;
    // O que sai no PR além do não commitado: os commits que a origin/<principal> ainda não tem.
    const [log, refs] = await Promise.all([
      git(cwd, ['log', '--format=%H%x00%h%x00%s', '-n', '100', `origin/${base}..HEAD`]).then(
        (r) => r.stdout,
        () => '',
      ),
      git(cwd, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', '--count=40', 'refs/remotes/origin']).then(
        (r) => r.stdout,
        () => '',
      ),
    ]);
    const commits = log
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [sha = '', short = '', headline = ''] = l.split('\0');
        return { sha, short, headline };
      });
    const bases = refs
      .split('\n')
      .filter((r) => r && r !== 'origin' && r !== 'origin/HEAD')
      .map((r) => r.slice('origin/'.length))
      .filter((b) => b !== status.branch);
    return {
      ok: true,
      repo: `${at.owner}/${at.name}`,
      viewer: res.data.viewer.login,
      viewerAvatar: res.data.viewer.avatarUrl ?? null,
      labels: repo.labels.nodes,
      base,
      bases: [base, ...bases.filter((b) => b !== base)],
      branch: status.branch,
      onBase,
      files: status.files,
      commits,
      existing: onBase ? null : (repo.pullRequests.nodes[0] ?? null),
      fetchedAt,
    };
  } catch (err) {
    return failure(err, fetchedAt);
  }
}

/** O PR a abrir: `branch`, a nova (quando está na principal); `commits`, o não commitado que entra antes, em commits. */
export type PullDraft = { title: string; body: string; base: string; branch?: string; commits: { message: string; files: string[] }[]; labels: string[]; draft: boolean };

/**
 * Abre o PR do jeito que se faria no terminal: cria a branch (se pediu), faz os commits dos arquivos
 * escolhidos, publica a branch no origin e abre o PR pelo `gh`. Se algo falhar no meio, o que já foi
 * feito fica (a branch, o commit), e a tela relida mostra de onde continuar.
 */
export async function githubCreatePull(cwd: string, d: PullDraft): Promise<{ number: number; url: string }> {
  const at = await repoOf(cwd, Date.now());
  if ('ok' in at) throw new HttpError(422, 'github_action_failed', { message: 'Este projeto não está no GitHub.' });
  if (!d.title.trim()) throw new HttpError(400, 'github_action_failed', { message: 'Escreva o título do PR.' });
  const status = await requireRepo(cwd);
  if (d.branch && d.branch !== status.branch) await gitCreateBranch(cwd, d.branch);
  const branch = (await requireRepo(cwd)).branch;
  if (!branch) throw new HttpError(409, 'detached_head');
  if (branch === d.base) throw new HttpError(409, 'github_action_failed', { message: `O PR precisa sair de outra branch, não da ${d.base}.` });
  for (const c of d.commits) {
    if (!c.files.length) continue;
    await gitStage(cwd, c.files);
    // Só os deste commit: o que já estava preparado de outros arquivos fica para os próximos (ou de fora).
    await gitWrite(cwd, ['commit', '-m', c.message.trim() || d.title.trim(), '--', ...c.files]);
  }
  await gitWrite(cwd, ['push', '-u', 'origin', 'HEAD']);
  // Quem abre pelo edit.r já fica como responsável: a conta do `gh` deste PC.
  const args = ['pr', 'create', '--repo', `${at.owner}/${at.name}`, '--base', d.base, '--head', branch, '--title', d.title.trim(), '--body', d.body, '--assignee', '@me'];
  for (const l of d.labels) args.push('--label', l);
  if (d.draft) args.push('--draft');
  const out = await run(cwd, args);
  const url = out.trim().split('\n').findLast((l) => l.includes('/pull/')) ?? '';
  const number = Number(/\/pull\/(\d+)/.exec(url)?.[1]);
  cache.delete(`list\n${cwd}`);
  if (!number) throw new HttpError(422, 'github_action_failed', { message: 'O PR foi aberto, mas não entendi a resposta do gh.' });
  return { number, url };
}
