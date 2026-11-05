import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { MAX_BYTES, type ArtefatoStore, type Artefato } from './artefatos.ts';
import { type Detalhe, type DetalheStore } from './detalhes.ts';
import { HttpError } from './errors.ts';
import { MAX_BODY, MAX_DESCRIPTION, type Habilidade, type HabilidadeStore } from './habilidades.ts';
import { MAX_INSTRUCTIONS, MAX_MEMBERS, type Team, type TeamStore } from './teams.ts';
import { MAX_TODO_BODY, MAX_TODO_TITLE, type Todo, type TodoStore } from './todos.ts';
import { MAX_COMMANDS, MAX_INSTRUCTIONS as MAX_WS_INSTRUCTIONS, MAX_PROJECTS, MAX_RULES, type Workspace, type WorkspaceStore } from './workspaces.ts';
import { worktreeOf } from './worktrees.ts';

/**
 * O MCP do cald: ferramentas para o Claude de uma conversa do painel criar e mudar as coisas do
 * próprio cald (o TODO do projeto, times, workspaces e habilidades), que aparecem na hora no app, e ler
 * os detalhes do projeto (como cada parte dele funciona), que só você escreve.
 * Roda no mesmo processo (`createSdkMcpServer`), um por conversa, já amarrado à pasta dela. Nada
 * aqui apaga: é a mesma regra do app de não ter ação sem volta. As abertas no terminal não o veem.
 */

export const CALD_MCP = 'cald';

/**
 * Passam sem pedir aprovação: ler, criar TODOs e marcá-los, e criar time ou workspace (nada disso muda o
 * que já existe, nem vale antes de você escolher). Editar time ou workspace e criar ou editar habilidade
 * pedem: uma habilidade global vale em todo projeto, e um arquivo de um repositório qualquer poderia
 * convencer o Claude a plantar ali uma instrução que fica.
 */
export const CALD_MCP_ALLOWED = [
  'listar_todos',
  'criar_todos',
  'editar_todo',
  'listar_detalhes',
  'ler_detalhe',
  'listar_times',
  'criar_time',
  'usar_time',
  'listar_workspaces',
  'criar_workspace',
  'listar_habilidades',
  // Publicar um artefato só o põe na tailnet (o link público é ligado por você, no app).
  'publicar_artefato',
  'listar_artefatos',
].map((name) => `mcp__${CALD_MCP}__${name}`);

export type CaldMcpDeps = {
  todos: TodoStore;
  detalhes: DetalheStore;
  teams: TeamStore;
  workspaces: WorkspaceStore;
  habilidades: HabilidadeStore;
  artefatos: ArtefatoStore;
  /** Só pasta que o painel já aceita vira projeto de workspace (ver Manager.knownCwd). */
  knownCwd: (cwd: string) => Promise<string>;
};

export type CaldMcpContext = {
  /** A pasta da conversa: o TODO e as habilidades "deste projeto" são dela. */
  cwd: string;
  /** Põe o time nesta conversa quando o turno acabar (ver Manager.useTeamLater). */
  useTeam: (teamId: string) => void;
  /** O id desta conversa (o artefato guarda de qual conversa veio, para o claudinho dela). */
  sessionId: () => string | undefined;
};

const INSTRUCTIONS = `O cald é o painel em que esta conversa roda, no celular e no PC do usuário. Por estas ferramentas você cria e muda coisas dele, e tudo aparece na hora no app.
- TODO: a lista de tarefas deste projeto no cald (não é a sua lista interna de tarefas). Cada item tem um número, que o usuário menciona no chat como \`TODO:n\`. Ao quebrar um trabalho em tarefas, crie todas de uma vez com \`criar_todos\`; ao terminar uma, marque-a como feita com \`editar_todo\` (\`feito: true\`).
- Detalhes: notas do usuário sobre como partes deste projeto funcionam. Quando a conversa abre com uma lista deles abaixo, leia com \`ler_detalhe\` o que tocar no trabalho antes de varrer o código para entender aquela parte: é mais rápido e mais barato.
- Times: subagentes do usuário (nome, papel, modelo, esforço e instruções), que uma conversa recebe para delegar pela ferramenta Agent. Ao montar um time para um projeto, estude o projeto antes (CLAUDE.md, README, a stack, os comandos de build, teste e lint, as convenções) e escreva para cada membro instruções específicas dele: do que cuida, onde isso fica no código, que padrões seguir e como validar. Um time editado só vale nas conversas que começarem depois; \`usar_time\` põe um time nesta conversa quando a sua resposta terminar.
- Workspaces: moldes de conversa, com projetos, instruções, regras, comandos de validação e um time padrão. Cada projeto pode ter um workspace padrão, com que a conversa nova dele já vem. Mudanças valem da próxima vez que uma conversa do workspace abrir.
- Habilidades: skills do cald (\`/cald:nome\`), globais ou deste projeto. Valem nas conversas do painel, esta inclusive, assim que salvas.
- Artefatos: para mostrar uma página HTML (protótipo, relatório, painel, visualização) ao usuário, publique com \`publicar_artefato\`. O cald congela o HTML e os arquivos que ele usa (CSS, JS, imagens e fontes da mesma pasta, por caminho relativo) numa versão, e o chat mostra um cartão para abrir. Publicar o mesmo arquivo de novo cria a versão seguinte, com o mesmo link. O link fica na tailnet do usuário; deixá-lo público na internet é escolha dele, no app.
Nada aqui apaga: para tirar algo, o usuário usa o app.`;

/**
 * O índice dos detalhes do projeto, junto das instruções: o Claude já abre sabendo o que existe (só
 * chave e título), sem gastar uma chamada. Vale como estava ao abrir a conversa; `listar_detalhes` dá o atual.
 */
function instructionsFor(index: string | null): string {
  if (!index) return INSTRUCTIONS;
  return `${INSTRUCTIONS}

Detalhes deste projeto (chave: título). Antes de ler o código para entender uma destas partes, leia o detalhe dela com \`ler_detalhe\`:
${index}`;
}

const artefatoOut = (a: Artefato, link: string) => ({
  id: a.id,
  titulo: a.title,
  descricao: a.description,
  versoes: a.versions.length,
  atual: a.versions.at(-1)!.n,
  arquivo: a.source,
  link,
  publico: a.public !== null,
});

const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 1) }] });

/** O erro do cald vira uma resposta que o Claude lê (e pode corrigir), em vez de derrubar a chamada. */
function guarded<A>(run: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      return ok(await run(args));
    } catch (err) {
      const text = err instanceof HttpError ? `Erro do cald: ${err.code}${err.details ? ` ${JSON.stringify(err.details)}` : ''}` : String(err);
      return { content: [{ type: 'text' as const, text }], isError: true };
    }
  };
}

// O que o Claude lê de cada coisa: os nomes em português, como nos parâmetros.
const detalheOut = (d: Detalhe) => ({ chave: d.chave, titulo: d.title, conteudo: d.body, atualizado: new Date(d.updatedAt ?? d.createdAt).toISOString().slice(0, 10) });
const todoOut = (t: Todo) => ({ n: t.n, titulo: t.title, feito: t.done, descricao: t.body || undefined, anexos: t.files.length || undefined });
const teamOut = (t: Team) => ({
  id: t.id,
  nome: t.name,
  membros: t.members.map((m) => ({ nome: m.name, subagent_type: m.key, papel: m.role, modelo: m.model, esforco: m.effort, instrucoes: m.instructions })),
});
const workspaceOut = (w: Workspace) => ({
  id: w.id,
  nome: w.name,
  cor: w.color,
  projetos: w.projects,
  instrucoes: w.instructions,
  regras: w.rules,
  comandos: w.commands.map((c) => ({ rotulo: c.label, comando: c.command, pasta: c.cwd })),
  timeId: w.teamId,
  arquivos: w.files.map((f) => f.name),
  padraoDe: w.defaultFor,
});
const habilidadeOut = (h: Habilidade) => ({ id: h.id, nome: h.name, descricao: h.description, escopo: h.project ? 'projeto' : 'global', corpo: h.body });

const effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
const member = z.object({
  nome: z.string().min(1).max(40).describe('Nome do membro (ex.: "Thor"); vira o subagent_type dele'),
  papel: z.string().max(60).describe('O papel em poucas palavras: Frontend, Backend, Testes…'),
  modelo: z.string().max(100).optional().describe('Alias ou id do modelo (ex.: "opus", "sonnet", "haiku"); sem ele, usa o da conversa'),
  esforco: effort.optional().describe('Esforço de raciocínio; sem ele, o padrão do modelo'),
  instrucoes: z.string().max(MAX_INSTRUCTIONS).describe('As instruções do membro, em Markdown, específicas deste projeto'),
});
const command = z.object({
  rotulo: z.string().max(60).describe('Ex.: "Build", "Testes", "Lint"'),
  comando: z.string().min(1).max(1000),
  pasta: z.string().max(4096).optional().describe('Pasta em que roda, se não for a do projeto'),
});
const wsFields = {
  instrucoes: z.string().max(MAX_WS_INSTRUCTIONS).optional().describe('Instruções que toda conversa do workspace recebe'),
  regras: z.array(z.string().max(1000)).max(MAX_RULES).optional().describe('Padrões do workspace, uma regra por item'),
  comandos: z.array(command).max(MAX_COMMANDS).optional().describe('Comandos para validar (build, teste, lint)'),
  timeId: z.string().max(64).nullable().optional().describe('Time padrão das conversas novas (id de listar_times); null tira'),
  cor: z.number().int().min(0).max(9).optional().describe('Índice da cor na paleta do app, de 0 a 9'),
};

const mapMembers = (list: z.infer<typeof member>[], old?: Team) =>
  list.map((m) => ({
    // O mesmo nome continua sendo o mesmo membro (e o mesmo claudinho no app).
    id: old?.members.find((o) => o.name === m.nome.trim())?.id,
    name: m.nome,
    role: m.papel,
    model: m.modelo,
    effort: m.esforco,
    instructions: m.instrucoes,
  }));
const mapCommands = (list: z.infer<typeof command>[]) => list.map((c) => ({ label: c.rotulo, command: c.comando, cwd: c.pasta }));

export function caldMcp(deps: CaldMcpDeps, ctx: CaldMcpContext): McpSdkServerConfigWithInstance {
  const { todos, detalhes, teams, workspaces, habilidades, artefatos } = deps;
  const knownProjects = (list: string[]) => Promise.all(list.map((p) => deps.knownCwd(p)));
  const habilidade = (id: string) => {
    const { global, project } = habilidades.list(ctx.cwd);
    const found = [...global, ...project].find((h) => h.id === id);
    if (!found) throw new HttpError(404, 'habilidade_not_found');
    return found;
  };

  return createSdkMcpServer({
    name: CALD_MCP,
    version: '1.0.0',
    instructions: instructionsFor(detalhes.index(ctx.cwd)),
    tools: [
      // ---- TODO do projeto ----
      tool(
        'listar_todos',
        'Lista o TODO deste projeto no cald: número, título, se está feito e a descrição.',
        { feitos: z.boolean().optional().describe('Incluir os já feitos (padrão: só os a fazer)') },
        guarded(async ({ feitos }) => todos.list(ctx.cwd).filter((t) => feitos || !t.done).map(todoOut)),
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        'criar_todos',
        'Cria itens no TODO deste projeto no cald, todos de uma vez, no fim da lista. Devolve o número de cada um.',
        {
          itens: z
            .array(
              z.object({
                titulo: z.string().min(1).max(MAX_TODO_TITLE),
                descricao: z.string().max(MAX_TODO_BODY).optional().describe('Markdown; pode citar arquivos do projeto com @caminho'),
              }),
            )
            .min(1)
            .max(50),
        },
        guarded(async ({ itens }) => (await todos.add(ctx.cwd, itens.map((t) => ({ title: t.titulo, body: t.descricao })))).map(todoOut)),
      ),
      tool(
        'editar_todo',
        'Muda um item do TODO deste projeto pelo número (o n de TODO:n): marca como feito (ou desfaz), troca o título ou a descrição. O que não vier fica como está.',
        {
          n: z.number().int().min(1),
          feito: z.boolean().optional(),
          titulo: z.string().min(1).max(MAX_TODO_TITLE).optional(),
          descricao: z.string().max(MAX_TODO_BODY).optional(),
        },
        guarded(async ({ n, feito, titulo, descricao }) => todoOut(await todos.update(ctx.cwd, n, { done: feito, title: titulo, body: descricao }))),
        { annotations: { idempotentHint: true } },
      ),

      // ---- detalhes do projeto ----
      tool(
        'listar_detalhes',
        'Lista os detalhes deste projeto no cald (notas do usuário sobre como partes dele funcionam): a chave e o título de cada um, sem o conteúdo.',
        {},
        guarded(async () =>
          detalhes
            .list(ctx.cwd)
            .filter((d) => d.body.trim())
            .map((d) => ({ chave: d.chave, titulo: d.title, tamanho: d.body.length })),
        ),
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        'ler_detalhe',
        'Lê o conteúdo (Markdown, com @caminho para arquivos do projeto) de um ou mais detalhes deste projeto, pela chave. Peça de uma vez todos os que o trabalho toca.',
        { chaves: z.array(z.string().min(1).max(200)).min(1).max(20).describe('Chaves de listar_detalhes (ou do índice nas instruções)') },
        guarded(async ({ chaves }) => {
          const { found, missing } = detalhes.read(ctx.cwd, chaves);
          return {
            detalhes: found.map(detalheOut),
            ...(missing.length ? { naoAchados: missing, existentes: detalhes.list(ctx.cwd).filter((d) => d.body.trim()).map((d) => d.chave) } : {}),
          };
        }),
        { annotations: { readOnlyHint: true } },
      ),

      // ---- times ----
      tool(
        'listar_times',
        'Lista os times de agentes do cald, com os membros e as instruções de cada um.',
        {},
        guarded(async () => teams.list().map(teamOut)),
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        'criar_time',
        `Cria um time de agentes no cald: até ${MAX_MEMBERS} membros, cada um um subagente com nome, papel, modelo, esforço e instruções. Estude o projeto antes e escreva instruções específicas dele.`,
        { nome: z.string().min(1).max(60), membros: z.array(member).min(1).max(MAX_MEMBERS) },
        guarded(async ({ nome, membros }) => teamOut(await teams.save({ name: nome, members: mapMembers(membros) }))),
      ),
      tool(
        'editar_time',
        'Muda um time do cald. `membros`, se vier, é a lista inteira como deve ficar (quem tem o mesmo nome continua o mesmo membro). Só vale nas conversas que começarem depois.',
        { id: z.string().min(1).max(64), nome: z.string().min(1).max(60).optional(), membros: z.array(member).min(1).max(MAX_MEMBERS).optional() },
        guarded(async ({ id, nome, membros }) => {
          const old = teams.get(id);
          const members = membros ? mapMembers(membros, old) : old.members;
          return teamOut(await teams.save({ id, name: nome ?? old.name, members }));
        }),
      ),
      tool(
        'usar_time',
        'Põe um time nesta conversa: quando a sua resposta terminar, a conversa reabre com os membros dele como subagentes, e a próxima mensagem já pode delegar a eles. Avise o usuário disso na resposta.',
        { id: z.string().min(1).max(64).describe('id de listar_times ou criar_time') },
        guarded(async ({ id }) => {
          const team = teams.get(id);
          ctx.useTeam(team.id);
          return { ok: true, time: team.name, quando: 'ao fim desta resposta' };
        }),
      ),

      // ---- workspaces ----
      tool(
        'listar_workspaces',
        'Lista os workspaces do cald: projetos, instruções, regras, comandos, time padrão e arquivos de contexto.',
        {},
        guarded(async () => workspaces.list().map(workspaceOut)),
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        'criar_workspace',
        'Cria um workspace no cald, um molde de conversa. O primeiro projeto é o principal, onde a conversa abre; sem projetos, fica só o desta conversa. Se o principal ainda não tem workspace padrão, este vira o padrão dele.',
        {
          nome: z.string().min(1).max(60),
          projetos: z.array(z.string().max(4096)).max(MAX_PROJECTS).optional().describe('Caminhos absolutos das pastas dos projetos'),
          ...wsFields,
        },
        guarded(async (a) => {
          // Numa conversa em worktree, o projeto é o checkout de que ele é cópia: o worktree some ao ser removido.
          const projects = await knownProjects(a.projetos?.length ? a.projetos : [worktreeOf(ctx.cwd)?.project ?? ctx.cwd]);
          if (a.timeId) teams.get(a.timeId);
          const ws = await workspaces.save({
            name: a.nome,
            color: a.cor ?? 0,
            projects,
            instructions: a.instrucoes ?? '',
            rules: a.regras ?? [],
            commands: mapCommands(a.comandos ?? []),
            teamId: a.timeId ?? undefined,
          });
          return workspaceOut(ws);
        }),
      ),
      tool(
        'editar_workspace',
        'Muda um workspace do cald. Cada lista que vier (projetos, regras, comandos) substitui a anterior inteira; o que não vier fica como está.',
        {
          id: z.string().min(1).max(64),
          nome: z.string().min(1).max(60).optional(),
          projetos: z.array(z.string().max(4096)).min(1).max(MAX_PROJECTS).optional(),
          ...wsFields,
        },
        guarded(async (a) => {
          const old = workspaces.get(a.id);
          if (a.timeId) teams.get(a.timeId);
          const ws = await workspaces.save({
            id: old.id,
            name: a.nome ?? old.name,
            color: a.cor ?? old.color,
            projects: a.projetos ? await knownProjects(a.projetos) : old.projects,
            instructions: a.instrucoes ?? old.instructions,
            rules: a.regras ?? old.rules,
            commands: a.comandos ? mapCommands(a.comandos) : old.commands,
            teamId: a.timeId === undefined ? old.teamId : (a.timeId ?? undefined),
          });
          return workspaceOut(ws);
        }),
      ),

      // ---- habilidades ----
      tool(
        'listar_habilidades',
        'Lista as habilidades do cald que valem aqui: as globais e as deste projeto, com descrição e corpo.',
        {},
        guarded(async () => {
          const { global, project } = habilidades.list(ctx.cwd);
          return [...project, ...global].map(habilidadeOut);
        }),
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        'criar_habilidade',
        'Cria uma habilidade do cald (uma skill, `/cald:nome`), global ou só deste projeto. Vale já nesta conversa.',
        {
          nome: z.string().min(1).max(50).describe('Minúsculas, números e hífen'),
          descricao: z.string().min(1).max(MAX_DESCRIPTION).describe('Quando usar: é por ela que o Claude decide carregar a habilidade'),
          corpo: z.string().max(MAX_BODY).describe('As instruções, em Markdown'),
          escopo: z.enum(['global', 'projeto']),
        },
        guarded(async (a) =>
          habilidadeOut(await habilidades.save({ name: a.nome, description: a.descricao, body: a.corpo, project: a.escopo === 'projeto' ? ctx.cwd : null })),
        ),
      ),
      tool(
        'editar_habilidade',
        'Muda uma habilidade do cald (global ou deste projeto). O que não vier fica como está.',
        {
          id: z.string().min(1).max(64),
          nome: z.string().min(1).max(50).optional(),
          descricao: z.string().min(1).max(MAX_DESCRIPTION).optional(),
          corpo: z.string().max(MAX_BODY).optional(),
          escopo: z.enum(['global', 'projeto']).optional(),
        },
        guarded(async (a) => {
          const old = habilidade(a.id);
          const project = a.escopo === undefined ? old.project : a.escopo === 'projeto' ? ctx.cwd : null;
          return habilidadeOut(
            await habilidades.save({ id: old.id, name: a.nome ?? old.name, description: a.descricao ?? old.description, body: a.corpo ?? old.body, project }),
          );
        }),
        { annotations: { idempotentHint: true } },
      ),

      // ---- artefatos ----
      tool(
        'publicar_artefato',
        `Publica uma página HTML como artefato do cald: congela o HTML e os arquivos da mesma pasta que ele usa por caminho relativo (até ${MAX_BYTES / 1024 / 1024} MB) numa versão, com um link fixo na tailnet. Publicar o mesmo arquivo de novo cria a versão seguinte do mesmo artefato; sem mudança, devolve a atual. O chat mostra um cartão para abrir.`,
        {
          arquivo: z.string().min(1).max(4096).describe('O .html (ou uma pasta com index.html); relativo vale a partir da pasta da conversa'),
          titulo: z.string().min(1).max(120).optional().describe('Sem ele, vale o <title> da página'),
          descricao: z.string().max(500).optional().describe('Uma frase dizendo o que a página é'),
          rotulo: z.string().max(60).optional().describe('Um nome curto para esta versão, ex.: "Com o tema escuro"'),
        },
        guarded(async (a) => {
          const r = await artefatos.publish({ path: a.arquivo, cwd: ctx.cwd, sessionId: ctx.sessionId(), title: a.titulo, description: a.descricao, label: a.rotulo });
          return {
            id: r.artefato.id,
            titulo: r.artefato.title,
            versao: r.version.n,
            novo: r.novo,
            arquivos: r.version.files,
            tamanho: r.version.bytes,
            link: artefatos.linkUrl(r.artefato.id),
          };
        }),
      ),
      tool(
        'listar_artefatos',
        'Lista os artefatos do cald: título, versões, arquivo de origem, link e se está público.',
        {},
        guarded(async () => artefatos.list().map((a) => artefatoOut(a, artefatos.linkUrl(a.id)))),
        { annotations: { readOnlyHint: true } },
      ),
    ],
  });
}
