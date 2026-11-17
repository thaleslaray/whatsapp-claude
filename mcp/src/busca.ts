// 0.8.0: busca com índice em memória. Por quê: até a 0.7.6 o wa_buscar decifrava e varria todas as mensagens de todas
// as conversas a cada busca, só no campo `texto`, sem ordem de relevância.
//
// - Motor: `node:sqlite` com FTS5, testado DE VERDADE na partida (criar a tabela, inserir, consultar). O Node embutido
//   do Claude Desktop tem o módulo no binário, mas nunca deu para rodar uma consulta lá dentro: se o teste falhar (ou o
//   módulo não existir), o motor é a "varredura", o comportamento de antes, que continua aqui como plano B.
// - O banco SQLite é SEMPRE `:memory:`: nenhum índice, texto ou trecho vai para o disco. Fecha no `fechar`.
// - Índice POR PROCESSO (o leitor busca sozinho, lendo os mesmos arquivos): antes de cada busca, cada conversa do índice
//   do banco é comparada com o que está indexado pelo carimbo do arquivo dela (`Banco.marcaDaConversa`: inode, mtime e
//   tamanho; toda gravação é atômica, com rename, então todo arquivo novo tem outro inode). Conversa nova ou mudada é
//   indexada de novo; a que sumiu sai. Assim escrita, edição, exclusão, transcrição, bloqueio e o que OUTRO processo
//   mudou aparecem na busca seguinte, sem ganchos espalhados pelo código.
// - Só entra no índice o que o Banco devolve (lista "nunca ler" e grupos escolhidos já respeitados por ele).
// - Nada de conteúdo, id ou jid em log ou caixa-preta: só contagens e tempos.
//
// 0.9.0: blocos de conversa (blocos.ts). Cada conversa indexada vira também uma tabela de blocos e uma FTS5 com o
// texto de cada bloco; cada linha sabe o bloco dela. Com `agrupar: "bloco"` (o padrão), um resultado por bloco, e a
// busca de duas ou mais palavras acha também o bloco em que elas aparecem em mensagens diferentes ("espalhado").
// - `esvaziar()`: o Banco avisa quando ESTE processo apaga conversa ou tudo, e o índice inteiro é descartado na hora
//   (ele se refaz em ~150 ms). O que outro processo apaga continua saindo na busca seguinte, pelo carimbo.
// - Com o trigram sem acento e todos os termos com 3+ caracteres, a varredura não acha nada que o pedaço de palavra
//   não ache: zero achados responde direto, sem decifrar tudo de novo.

import type { DatabaseSync, StatementSync } from "node:sqlite";
import { normalizarTexto, type Banco, type MensagemGuardada } from "./banco.ts";
import { dividirEmBlocos, textosDe } from "./blocos.ts";
import { log } from "./log.ts";

type ModuloSqlite = typeof import("node:sqlite");
/** Devolve o `node:sqlite` (ou undefined). Os testes injetam uma que nega o módulo. */
export type CarregarSqlite = () => ModuloSqlite | undefined;

export type Motor = "fts5" | "varredura";
export type Caminho = "indice" | "pedaco" | "varredura";
export type Campo = "texto" | "transcricao" | "arquivo";
export type Ordem = "relevancia" | "recentes";
/** 0.9.0: um resultado por bloco de conversa (padrão) ou por mensagem (o comportamento da 0.8.0). */
export type Agrupar = "bloco" | "mensagem";

/** Pesos do bm25 na ordem das colunas (texto, arquivo, transcricao): texto vale mais, depois transcrição, depois arquivo. */
const PESOS = "10.0, 1.0, 4.0";
/** A primeira sincronização pode pegar centenas de conversas: devolve o controle ao laço a cada tantas. */
const CEDER_A_CADA = 20;
/** Sincronização mais lenta que isto vai para a caixa-preta. */
const SINCRONIZACAO_LENTA_MS = 1_000;
const TOKENIZADOR = "unicode61 remove_diacritics 2";

/** Igual ao `cederAoLaco` do transporte (0.7.4): sem importar o transporte inteiro aqui. */
const cederAoLaco = (): Promise<void> => new Promise((pronto) => setImmediate(pronto));

/** O aviso de recurso experimental do `node:sqlite` (Node 22): não é erro e não deve sujar o stderr. */
function ehAvisoDoSqlite(aviso: unknown, resto: unknown[]): boolean {
  const tipo = aviso instanceof Error ? aviso.name : typeof resto[0] === "string" ? resto[0] : (resto[0] as { type?: unknown } | undefined)?.type;
  const texto = aviso instanceof Error ? aviso.message : String(aviso);
  return tipo === "ExperimentalWarning" && /sqlite/i.test(texto);
}

/**
 * Carrega o `node:sqlite` sem `import` estático (o esbuild não empacota nada, e a falta do módulo não derruba o
 * processo). Cala só o ExperimentalWarning dele, durante a carga; os outros avisos passam.
 */
export const carregarSqlite: CarregarSqlite = () => {
  const original = process.emitWarning;
  process.emitWarning = function (this: unknown, aviso: unknown, ...resto: unknown[]) {
    if (ehAvisoDoSqlite(aviso, resto)) return;
    return (original as (...a: unknown[]) => void).call(process, aviso, ...resto);
  } as typeof process.emitWarning;
  try {
    return process.getBuiltinModule?.("node:sqlite") as ModuloSqlite | undefined;
  } catch {
    return undefined;
  } finally {
    process.emitWarning = original;
  }
};

export interface Capacidade {
  motor: Motor;
  trigram: boolean;
  /** O tokenizador do pedaço de palavra que passou no teste (com remove_diacritics, se a versão do SQLite tiver). */
  tokenizadorDoPedaco?: string;
  sqlite?: ModuloSqlite;
}

/** Roda `teste` num banco em memória novo e fecha. Qualquer erro = não serve. */
function tentar(sqlite: ModuloSqlite, teste: (db: DatabaseSync) => boolean): boolean {
  let db: DatabaseSync | undefined;
  try {
    db = new sqlite.DatabaseSync(":memory:");
    return teste(db);
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      // já fechado
    }
  }
}

/** O teste da partida: FTS5 com o tokenizador sem acento e prefixos, e à parte o `trigram`. */
export function testarMotor(carregar: CarregarSqlite = carregarSqlite): Capacidade {
  let sqlite: ModuloSqlite | undefined;
  try {
    sqlite = carregar();
  } catch {
    sqlite = undefined;
  }
  if (!sqlite || typeof sqlite.DatabaseSync !== "function") return { motor: "varredura", trigram: false };
  const fts = tentar(sqlite, (db) => {
    db.exec(`CREATE VIRTUAL TABLE t USING fts5(x, tokenize='${TOKENIZADOR}', prefix='2 3')`);
    db.prepare("INSERT INTO t(x) VALUES (?)").run("Amanhã às três");
    const consultar = (q: string) => db.prepare("SELECT rowid FROM t WHERE t MATCH ?").all(q).length;
    return consultar('"amanha"') === 1 && consultar('"tre"*') === 1 && consultar('"ontem"') === 0;
  });
  if (!fts) return { motor: "varredura", trigram: false };
  for (const tokenizador of ["trigram remove_diacritics 1", "trigram"]) {
    const ok = tentar(sqlite, (db) => {
      db.exec(`CREATE VIRTUAL TABLE t USING fts5(x, tokenize='${tokenizador}')`);
      db.prepare("INSERT INTO t(x) VALUES (?)").run("condomínio");
      return db.prepare("SELECT rowid FROM t WHERE t MATCH ?").all('"DOMI"').length === 1;
    });
    if (ok) return { motor: "fts5", trigram: true, tokenizadorDoPedaco: tokenizador, sqlite };
  }
  return { motor: "fts5", trigram: false, sqlite };
}

// ---------- consulta ----------

/** Os termos do usuário, separados por espaço. */
export const termosDe = (texto: string): string[] => texto.split(/\s+/u).filter((t) => t !== "");

const temLetraOuNumero = (t: string) => /[\p{L}\p{N}]/u.test(t);
const aspas = (t: string) => `"${t.replaceAll('"', '""')}"`;

/**
 * A expressão do FTS5, sem deixar a sintaxe dele vazar: cada termo entre aspas (aspas internas dobradas), AND
 * implícito, e o último termo como prefixo quando tem 2 ou mais caracteres. Termo só de pontuação fica de fora
 * (não vira token). Operadores do usuário (OR, NEAR, :, *, ^, parênteses) viram texto comum dentro das aspas.
 */
export function expressaoDoIndice(termos: readonly string[]): string | null {
  const uteis = termos.filter(temLetraOuNumero);
  if (uteis.length === 0) return null;
  return uteis.map((t, i) => (i === uteis.length - 1 && [...t].length >= 2 ? `${aspas(t)}*` : aspas(t))).join(" ");
}

/** Pedaço de palavra (trigram): cada termo com 3 ou mais caracteres, entre aspas. */
export function expressaoDoPedaco(termos: readonly string[]): string | null {
  const uteis = termos.filter((t) => [...t].length >= 3 && temLetraOuNumero(t));
  return uteis.length === 0 ? null : uteis.map(aspas).join(" ");
}

/** 0.9.0: qualquer um dos termos (OR), com o mesmo prefixo no último: as mensagens de um bloco espalhado que têm alguma das palavras. */
export function expressaoDeQualquer(termos: readonly string[]): string | null {
  const uteis = termos.filter(temLetraOuNumero);
  if (uteis.length === 0) return null;
  return uteis.map((t, i) => (i === uteis.length - 1 && [...t].length >= 2 ? `${aspas(t)}*` : aspas(t))).join(" OR ");
}

export interface Consulta {
  texto: string;
  jid?: string;
  ordem: Ordem;
  /** 0.9.0: padrão "bloco". */
  agrupar?: Agrupar;
  de_mim?: boolean;
  /** ms, inclusive. */
  desde?: number;
  ate?: number;
  inicio: number;
  limite: number;
}

/** O que a busca devolve de cada mensagem (o bastante para a resposta; nunca chave nem caminho de mídia). */
export interface MensagemAchada {
  id: string;
  ts: number;
  de_mim: boolean;
  remetente?: { nome?: string; numero?: string };
  /** 0.11.0: quem escreveu no grupo, como veio na chave (só para o Banco resolver o número e o rótulo; nunca sai). */
  participante?: string;
}

/** 0.9.0: o bloco do achado: data da primeira e da última mensagem (ms), quantas mensagens e quantas delas casam. */
export interface BlocoDoAchado {
  inicio: number;
  fim: number;
  mensagens: number;
  achados: number;
}

export interface Achado {
  jid: string;
  mensagem: MensagemAchada;
  trecho: string;
  achado_em: Campo;
  bloco: BlocoDoAchado;
  /** As palavras estão no bloco, mas em mensagens diferentes. */
  espalhado?: true;
}

export interface ResultadoDaBusca {
  achados: Achado[];
  /** Resultados no total: blocos com `agrupar: "bloco"`, mensagens com "mensagem". */
  total: number;
  caminho: Caminho;
  /** 0.9.0: resultados por conversa, da que tem mais para a que tem menos (todas; o servidor mostra até 5). */
  por_conversa: Array<{ jid: string; achados: number }>;
}

/** Até onde a lista de resultados por conversa vai na resposta. */
export const CONVERSAS_NA_CONTAGEM = 5;

function contarPorConversa(jids: readonly string[]): Array<{ jid: string; achados: number }> {
  const contagem = new Map<string, number>();
  for (const j of jids) contagem.set(j, (contagem.get(j) ?? 0) + 1);
  return [...contagem].map(([jid, achados]) => ({ jid, achados })).sort((a, b) => b.achados - a.achados);
}

const VAZIO = (caminho: Caminho): ResultadoDaBusca => ({ achados: [], total: 0, caminho, por_conversa: [] });

/** Uma linha achada no índice, antes de virar resultado. */
interface LinhaAchada {
  id: number;
  bloco: number;
  conversa: string;
  ts: number;
}

/** Um resultado do índice antes da página: a linha que representa, o bloco e quantas do bloco casam. */
interface Candidato extends LinhaAchada {
  achados: number;
  espalhado?: true;
}

/**
 * Junta as linhas (já na ordem do resultado) por bloco: um candidato por bloco, representado pela primeira linha dele
 * na ordem (a mais bem colocada), com a contagem de linhas do bloco. Com `porMensagem`, uma por linha, com a mesma contagem.
 */
function juntarPorBloco(linhas: readonly LinhaAchada[], porMensagem: boolean): Candidato[] {
  const contagem = new Map<number, number>();
  for (const l of linhas) contagem.set(l.bloco, (contagem.get(l.bloco) ?? 0) + 1);
  if (porMensagem) return linhas.map((l) => ({ ...l, achados: contagem.get(l.bloco)! }));
  const vistos = new Set<number>();
  const saida: Candidato[] = [];
  for (const l of linhas) {
    if (vistos.has(l.bloco)) continue;
    vistos.add(l.bloco);
    saida.push({ ...l, achados: contagem.get(l.bloco)! });
  }
  return saida;
}

/** `recentes`: todos pela data da mensagem que representa (a mais nova primeiro), sem desfazer o desempate anterior. */
const porData = <T extends { ts: number }>(lista: T[]): T[] => lista.map((x, i) => ({ x, i })).sort((a, b) => b.x.ts - a.x.ts || a.i - b.i).map((p) => p.x);

export interface EstadoDaBusca {
  motor: Motor;
  trigram: boolean;
  mensagens_indexadas: number | null;
  conversas_indexadas: number | null;
  montado_em_ms: number | null;
}

interface Campos {
  texto: string;
  arquivo: string;
  transcricao: string;
}

const camposDe = (m: MensagemGuardada): Campos => ({ texto: m.texto ?? "", arquivo: m.midia?.nome ?? "", transcricao: m.transcricao?.texto ?? "" });

/**
 * Onde está o achado e o trecho em volta (cerca de 160 caracteres, como antes). Procura na ordem texto, transcrição,
 * arquivo. `agulhas` já sem acento e em minúsculas.
 */
export function localizar(campos: Campos, agulhas: readonly string[]): { achado_em: Campo; trecho: string } {
  for (const campo of ["texto", "transcricao", "arquivo"] as const) {
    const t = campos[campo];
    if (t === "") continue;
    // normalizarTexto tira os acentos combinantes: para texto em NFC, a posição bate com a do original.
    const n = normalizarTexto(t);
    let pos = -1;
    let tamanho = 0;
    for (const a of agulhas) {
      const p = a === "" ? -1 : n.indexOf(a);
      if (p >= 0 && (pos < 0 || p < pos)) {
        pos = p;
        tamanho = a.length;
      }
    }
    if (pos < 0) continue;
    const ini = Math.max(0, pos - 60);
    const fim = pos + tamanho + 100;
    return { achado_em: campo, trecho: `${ini > 0 ? "…" : ""}${t.slice(ini, fim)}${fim < t.length ? "…" : ""}` };
  }
  // O tokenizador achou, mas o indexOf não (pontuação no meio): o começo do primeiro campo com texto.
  const campo = (["texto", "transcricao", "arquivo"] as const).find((c) => campos[c] !== "") ?? "texto";
  const t = campos[campo];
  return { achado_em: campo, trecho: `${t.slice(0, 160)}${t.length > 160 ? "…" : ""}` };
}

/** As agulhas para localizar o trecho: os termos sem acento, mais as palavras de dentro deles (sem pontuação). */
function agulhasDe(termos: readonly string[]): string[] {
  const saida = new Set<string>();
  for (const t of termos) {
    const n = normalizarTexto(t);
    saida.add(n);
    for (const p of n.split(/[^\p{L}\p{N}]+/u)) if (p !== "") saida.add(p);
  }
  return [...saida];
}

const passaNosFiltros = (c: Consulta, m: { ts: number; de_mim: boolean }) =>
  (c.de_mim === undefined || m.de_mim === c.de_mim) && (c.desde === undefined || m.ts >= c.desde) && (c.ate === undefined || m.ts <= c.ate);

const contemTodos = (campos: Campos, termos: readonly string[]) => {
  const n = normalizarTexto(`${campos.texto}\n${campos.transcricao}\n${campos.arquivo}`);
  return termos.every((t) => n.includes(t));
};

interface LinhaDoIndice {
  id: number;
  conversa: string;
  mid: string;
  ts: number;
  de_mim: number;
  rem_nome: string | null;
  rem_numero: string | null;
  rem_part: string | null;
  texto: string | null;
  arquivo: string | null;
  transcricao: string | null;
}

export interface OpcoesDaBusca {
  carregarSqlite?: CarregarSqlite;
  /** A caixa-preta do processo (só o `registrar`). */
  caixaPreta?: { registrar(evento: string, campos?: Record<string, unknown>): void };
}

/**
 * 0.9.0: com o trigram sem acento e todos os termos com 3+ caracteres, o pedaço de palavra (que roda quando há termo
 * útil de 3+) conferiu tudo o que a varredura conferiria (todos os termos como pedaço de texto, sem acento): ela não
 * acharia nada a mais. Termo curto, trigram ausente ou com acento: a varredura ainda pode achar.
 */
export function varreduraNaoAchaMais(c: Pick<Capacidade, "trigram" | "tokenizadorDoPedaco">, termos: readonly string[]): boolean {
  return c.trigram && (c.tokenizadorDoPedaco ?? "").includes("remove_diacritics") && expressaoDoPedaco(termos) !== null && termos.every((t) => [...t].length >= 3);
}

const dentroDoPeriodo = (c: Consulta, ts: number) => (c.desde === undefined || ts >= c.desde) && (c.ate === undefined || ts <= c.ate);

export class Busca {
  readonly motor: Motor;
  readonly trigram: boolean;
  readonly #sqlite: ModuloSqlite | undefined;
  readonly #tokenizadorDoPedaco: string | undefined;
  readonly #caixa: OpcoesDaBusca["caixaPreta"];
  #db: DatabaseSync | null = null;
  #banco: Banco | null = null;
  /** Conversa (jid) -> carimbo do arquivo quando foi indexada. */
  readonly #indexadas = new Map<string, string>();
  readonly #consultas = new Map<string, StatementSync>();
  #mensagens = 0;
  #montadoEmMs: number | null = null;
  #registrouPrimeira = false;
  /** O índice foi esvaziado depois de montado: a remontagem não vai de novo para a caixa-preta. */
  #remontagem = false;
  /** Uma busca por vez: a sincronização cede ao laço, e outra busca no meio veria o índice pela metade. */
  #fila: Promise<unknown> = Promise.resolve();
  #fechada = false;

  constructor(opcoes: OpcoesDaBusca = {}) {
    const c = testarMotor(opcoes.carregarSqlite ?? carregarSqlite);
    this.motor = c.motor;
    this.trigram = c.trigram;
    this.#sqlite = c.sqlite;
    this.#tokenizadorDoPedaco = c.tokenizadorDoPedaco;
    this.#caixa = opcoes.caixaPreta;
  }

  estado(): EstadoDaBusca {
    const montado = this.#montadoEmMs !== null;
    return {
      motor: this.motor,
      trigram: this.trigram,
      mensagens_indexadas: montado ? this.#mensagens : null,
      conversas_indexadas: montado ? this.#indexadas.size : null,
      montado_em_ms: this.#montadoEmMs,
    };
  }

  /** Fecha e descarta o banco em memória (o texto indexado some com ele). */
  fechar(): void {
    this.#fechada = true;
    this.#descartar();
  }

  /**
   * 0.9.0: descarta o índice inteiro na hora (o Banco deste processo apagou conversa ou tudo). A próxima busca monta de
   * novo. Uma sincronização no meio percebe e recomeça (ver #sincronizar).
   */
  esvaziar(): void {
    this.#descartar();
    if (this.#montadoEmMs !== null) this.#remontagem = true;
    this.#montadoEmMs = null;
  }

  #descartar(): void {
    this.#consultas.clear();
    this.#indexadas.clear();
    this.#mensagens = 0;
    try {
      this.#db?.close();
    } catch {
      // já fechado
    }
    this.#db = null;
  }

  buscar(banco: Banco, consulta: Consulta): Promise<ResultadoDaBusca> {
    const vez = this.#fila.then(() => this.#buscarAgora(banco, consulta));
    this.#fila = vez.catch(() => undefined);
    return vez;
  }

  /**
   * 0.12.0: as mensagens RECEBIDAS (nunca as do dono) parecidas com um texto, para o wa_exemplos_do_meu_jeito pegar a
   * rajada do dono que veio logo depois. Qualquer um dos termos (OR) no campo de texto, pela relevância (bm25), só nas
   * conversas de `jids`. null quando o motor é a varredura ou o índice falha: quem chama cai na seleção por variedade.
   */
  parecidas(banco: Banco, termos: readonly string[], jids: ReadonlySet<string>, limite: number): Promise<Array<{ jid: string; id: string; ts: number }> | null> {
    if (this.motor !== "fts5" || this.#fechada) return Promise.resolve(null);
    const uteis = termos.filter(temLetraOuNumero);
    if (uteis.length === 0 || jids.size === 0) return Promise.resolve([]);
    const vez = this.#fila.then(async () => {
      await this.#sincronizar(banco);
      const expressao = `texto : (${uteis.map(aspas).join(" OR ")})`;
      const linhas = this.#preparar(`SELECT l.conversa, l.mid, l.ts FROM palavras JOIN linhas l ON l.id = palavras.rowid WHERE palavras MATCH ? AND l.de_mim = 0 ORDER BY bm25(palavras, ${PESOS}), l.ts DESC, l.id DESC LIMIT 2000`).all(expressao) as Array<{ conversa: string; mid: string; ts: number }>;
      return linhas.filter((l) => jids.has(l.conversa)).slice(0, limite).map((l) => ({ jid: l.conversa, id: l.mid, ts: l.ts }));
    });
    this.#fila = vez.catch(() => undefined);
    return vez.catch((erro: unknown) => {
      if (erro instanceof Error && erro.name === "ErroDeBanco") throw erro;
      log("[whatsapp-claude] a busca de mensagens parecidas falhou; os exemplos saíram pela variedade.");
      return null;
    });
  }

  /**
   * 0.13.0: as recebidas parecidas em qualquer motor (wa_como_eu_respondi). Pelo índice quando dá (`parecidas`); com o
   * motor na varredura, ou o índice falhando, decifra e percorre as mensagens como a varredura de sempre: qualquer um
   * dos termos como palavra inteira (sem acento) no texto, só recebidas, só nas conversas de `jids`; a ordem é quantos
   * termos casam e, no empate, a mais recente. `posicao` é a relevância (0 = a melhor).
   */
  async parecidasEmQualquerMotor(
    banco: Banco,
    termos: readonly string[],
    jids: ReadonlySet<string>,
    limite: number,
  ): Promise<{ achadas: Array<{ jid: string; id: string; ts: number }>; caminho: "indice" | "varredura" }> {
    const peloIndice = await this.parecidas(banco, termos, jids, limite);
    if (peloIndice !== null) return { achadas: peloIndice, caminho: "indice" };
    const procurados = [...new Set(termos.map(normalizarTexto).filter(temLetraOuNumero))];
    if (procurados.length === 0 || jids.size === 0) return { achadas: [], caminho: "varredura" };
    const achadas: Array<{ jid: string; id: string; ts: number; casam: number }> = [];
    let passos = 0;
    for (const conversa of banco.listarConversas()) {
      if (!jids.has(conversa.jid) || !banco.aceitaGravar(conversa.jid)) continue;
      for (const m of banco.lerMensagens(conversa.jid)) {
        if (m.de_mim || !m.texto) continue;
        const palavras = new Set(normalizarTexto(m.texto).split(/[^\p{L}\p{N}]+/u));
        const casam = procurados.filter((t) => palavras.has(t)).length;
        if (casam > 0) achadas.push({ jid: conversa.jid, id: m.id, ts: m.ts, casam });
      }
      if (++passos % CEDER_A_CADA === 0) await cederAoLaco();
    }
    achadas.sort((a, b) => b.casam - a.casam || b.ts - a.ts);
    return { achadas: achadas.slice(0, limite).map(({ jid, id, ts }) => ({ jid, id, ts })), caminho: "varredura" };
  }

  #varreduraNaoAchaMais(termos: readonly string[]): boolean {
    return varreduraNaoAchaMais({ trigram: this.trigram, ...(this.#tokenizadorDoPedaco ? { tokenizadorDoPedaco: this.#tokenizadorDoPedaco } : {}) }, termos);
  }

  async #buscarAgora(banco: Banco, c: Consulta): Promise<ResultadoDaBusca> {
    const termos = termosDe(c.texto.trim());
    if (termos.length === 0) return VAZIO(this.motor === "fts5" ? "indice" : "varredura");
    let espalharNaVarredura = true;
    if (this.motor === "fts5" && !this.#fechada) {
      let feito: ResultadoDaBusca | null = null;
      let falhou = false;
      try {
        await this.#sincronizar(banco);
        feito = this.#peloIndice(c, termos);
      } catch (erro) {
        // Erro do banco cifrado (chave perdida) sobe como sempre. Erro do SQLite: a varredura responde. Sem a mensagem
        // do erro no log: ela pode citar a consulta.
        if (erro instanceof Error && erro.name === "ErroDeBanco") throw erro;
        log("[whatsapp-claude] a busca pelo índice falhou; respondi pela varredura.");
        falhou = true;
      }
      if (feito) return feito;
      if (!falhou) {
        if (this.#varreduraNaoAchaMais(termos)) return VAZIO("pedaco");
        // O índice já procurou os espalhados: a varredura de reserva só procura por mensagem (juntada por bloco).
        espalharNaVarredura = false;
      }
    }
    const inicio = Date.now();
    const r = await this.#varrer(banco, c, termos, espalharNaVarredura);
    if (!this.#registrouPrimeira) {
      this.#registrouPrimeira = true;
      this.#caixa?.registrar("indice_de_busca", { motor: this.motor, trigram: this.trigram, mensagens: null, conversas: null, duracao_ms: Date.now() - inicio });
    }
    return r;
  }

  // ---------- índice ----------

  #abrir(): DatabaseSync {
    if (this.#db) return this.#db;
    const db = new this.#sqlite!.DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE linhas(id INTEGER PRIMARY KEY, conversa TEXT NOT NULL, mid TEXT NOT NULL, ts INTEGER NOT NULL,
                          de_mim INTEGER NOT NULL, tipo TEXT NOT NULL, rem_nome TEXT, rem_numero TEXT, rem_part TEXT, bloco INTEGER NOT NULL);
      CREATE INDEX linhas_da_conversa ON linhas(conversa);
      CREATE INDEX linhas_do_bloco ON linhas(bloco);
      CREATE TABLE blocos(id INTEGER PRIMARY KEY, conversa TEXT NOT NULL, inicio INTEGER NOT NULL, fim INTEGER NOT NULL,
                          mensagens INTEGER NOT NULL, primeira TEXT NOT NULL, ultima TEXT NOT NULL);
      CREATE INDEX blocos_da_conversa ON blocos(conversa);
      CREATE VIRTUAL TABLE palavras USING fts5(texto, arquivo, transcricao, tokenize='${TOKENIZADOR}', prefix='2 3');
      CREATE VIRTUAL TABLE textos_dos_blocos USING fts5(texto, tokenize='${TOKENIZADOR}', prefix='2 3');
    `);
    if (this.trigram) db.exec(`CREATE VIRTUAL TABLE pedacos USING fts5(tudo, tokenize='${this.#tokenizadorDoPedaco}')`);
    this.#db = db;
    return db;
  }

  #preparar(sql: string): StatementSync {
    let s = this.#consultas.get(sql);
    if (!s) {
      s = this.#abrir().prepare(sql);
      this.#consultas.set(sql, s);
    }
    return s;
  }

  #apagarConversa(jid: string): void {
    const ids = this.#preparar("SELECT id FROM linhas WHERE conversa = ?").all(jid) as Array<{ id: number }>;
    const apagarPalavras = this.#preparar("DELETE FROM palavras WHERE rowid = ?");
    const apagarPedacos = this.trigram ? this.#preparar("DELETE FROM pedacos WHERE rowid = ?") : null;
    for (const { id } of ids) {
      apagarPalavras.run(id);
      apagarPedacos?.run(id);
    }
    this.#preparar("DELETE FROM linhas WHERE conversa = ?").run(jid);
    const blocos = this.#preparar("SELECT id FROM blocos WHERE conversa = ?").all(jid) as Array<{ id: number }>;
    const apagarTexto = this.#preparar("DELETE FROM textos_dos_blocos WHERE rowid = ?");
    for (const { id } of blocos) apagarTexto.run(id);
    this.#preparar("DELETE FROM blocos WHERE conversa = ?").run(jid);
    this.#mensagens -= ids.length;
  }

  #indexarConversa(jid: string, mensagens: readonly MensagemGuardada[]): void {
    const inserirBloco = this.#preparar("INSERT INTO blocos(conversa, inicio, fim, mensagens, primeira, ultima) VALUES (?, ?, ?, ?, ?, ?)");
    const inserirTexto = this.#preparar("INSERT INTO textos_dos_blocos(rowid, texto) VALUES (?, ?)");
    const inserirLinha = this.#preparar("INSERT INTO linhas(conversa, mid, ts, de_mim, tipo, rem_nome, rem_numero, rem_part, bloco) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const inserirPalavras = this.#preparar("INSERT INTO palavras(rowid, texto, arquivo, transcricao) VALUES (?, ?, ?, ?)");
    const inserirPedacos = this.trigram ? this.#preparar("INSERT INTO pedacos(rowid, tudo) VALUES (?, ?)") : null;
    for (const b of dividirEmBlocos(mensagens)) {
      const primeira = mensagens[b.inicio]!;
      const ultima = mensagens[b.fim]!;
      const idBloco = Number(inserirBloco.run(jid, primeira.ts, ultima.ts, b.fim - b.inicio + 1, primeira.id, ultima.id).lastInsertRowid);
      const textoDoBloco: string[] = [];
      for (let i = b.inicio; i <= b.fim; i++) {
        const m = mensagens[i]!;
        const textos = textosDe(m);
        if (textos.length === 0) continue; // figurinha, mídia sem legenda: está no bloco, sem texto para indexar
        textoDoBloco.push(...textos);
        const c = camposDe(m);
        const id = Number(inserirLinha.run(jid, m.id, m.ts, m.de_mim ? 1 : 0, m.tipo, m.remetente?.nome ?? null, m.remetente?.numero ?? null, m.participante ?? null, idBloco).lastInsertRowid);
        inserirPalavras.run(id, c.texto, c.arquivo, c.transcricao);
        inserirPedacos?.run(id, textos.join("\n"));
        this.#mensagens++;
      }
      if (textoDoBloco.length > 0) inserirTexto.run(idBloco, textoDoBloco.join("\n"));
    }
  }

  /** Compara cada conversa do banco com o que está indexado, pelo carimbo do arquivo. */
  async #sincronizar(banco: Banco): Promise<void> {
    if (this.#banco !== banco) {
      // Outro Banco (o núcleo foi aberto de novo): começa do zero.
      this.#descartar();
      this.#banco = banco;
      this.#montadoEmMs = null;
    }
    const db = this.#abrir();
    const inicio = Date.now();
    const primeira = this.#montadoEmMs === null;
    const vistas = new Set<string>();
    let passos = 0;
    let mudou = false;
    for (const conversa of banco.listarConversas()) {
      const jid = conversa.jid;
      if (!banco.aceitaGravar(jid)) continue; // defesa em profundidade: bloqueada ou grupo fora da lista não entra
      vistas.add(jid);
      // O carimbo ANTES de ler: se o arquivo mudar no meio, o carimbo guardado fica velho e a próxima busca reindexa.
      const marca = banco.marcaDaConversa(jid);
      if (this.#indexadas.get(jid) === marca) continue;
      const mensagens = banco.lerMensagens(jid);
      db.exec("BEGIN");
      try {
        if (this.#indexadas.has(jid)) this.#apagarConversa(jid);
        this.#indexarConversa(jid, mensagens);
        db.exec("COMMIT");
      } catch (erro) {
        db.exec("ROLLBACK");
        throw erro;
      }
      this.#indexadas.set(jid, marca);
      mudou = true;
      if (++passos % CEDER_A_CADA === 0) {
        await cederAoLaco();
        // Esvaziado enquanto cedia (o Banco apagou algo): recomeça do zero, com o índice novo.
        if (this.#db !== db) return this.#sincronizar(banco);
      }
    }
    for (const jid of [...this.#indexadas.keys()]) {
      if (vistas.has(jid)) continue;
      db.exec("BEGIN");
      try {
        this.#apagarConversa(jid);
        db.exec("COMMIT");
      } catch (erro) {
        db.exec("ROLLBACK");
        throw erro;
      }
      this.#indexadas.delete(jid);
      mudou = true;
    }
    const duracao = Date.now() - inicio;
    if (primeira) this.#montadoEmMs = duracao;
    if ((primeira && !this.#remontagem) || (mudou && duracao > SINCRONIZACAO_LENTA_MS)) {
      this.#registrouPrimeira = true;
      this.#caixa?.registrar("indice_de_busca", { motor: this.motor, trigram: this.trigram, mensagens: this.#mensagens, conversas: this.#indexadas.size, duracao_ms: duracao });
    }
    if (primeira) this.#remontagem = false;
  }

  #filtrosSql(c: Consulta, comPeriodo = true): { sql: string; valores: Array<string | number> } {
    const partes: string[] = [];
    const valores: Array<string | number> = [];
    if (c.jid !== undefined) {
      partes.push("l.conversa = ?");
      valores.push(c.jid);
    }
    if (c.de_mim !== undefined) {
      partes.push("l.de_mim = ?");
      valores.push(c.de_mim ? 1 : 0);
    }
    if (comPeriodo && c.desde !== undefined) {
      partes.push("l.ts >= ?");
      valores.push(c.desde);
    }
    if (comPeriodo && c.ate !== undefined) {
      partes.push("l.ts <= ?");
      valores.push(c.ate);
    }
    return { sql: partes.map((p) => ` AND ${p}`).join(""), valores };
  }

  #peloIndice(c: Consulta, termos: readonly string[]): ResultadoDaBusca | null {
    const porMensagem = c.agrupar === "mensagem";
    const expressao = expressaoDoIndice(termos);
    if (expressao) {
      const ordem = c.ordem === "recentes" ? "l.ts DESC, l.id DESC" : `bm25(palavras, ${PESOS}), l.ts DESC, l.id DESC`;
      // O período fica fora do SQL: um bloco com achado fora do período também não pode virar "espalhado".
      const f = this.#filtrosSql(c, false);
      const todas = this.#preparar(`SELECT l.id, l.bloco, l.conversa, l.ts FROM palavras JOIN linhas l ON l.id = palavras.rowid WHERE palavras MATCH ?${f.sql} ORDER BY ${ordem}`).all(expressao, ...f.valores) as unknown as LinhaAchada[];
      let candidatos = juntarPorBloco(todas.filter((l) => dentroDoPeriodo(c, l.ts)), porMensagem);
      // Com `de_mim`, os espalhados não rodam: o bloco mistura mensagens das duas pessoas.
      if (!porMensagem && c.de_mim === undefined && termos.filter(temLetraOuNumero).length >= 2) {
        const espalhados = this.#espalhados(c, termos, new Set(todas.map((l) => l.bloco)));
        candidatos = c.ordem === "recentes" ? porData([...candidatos, ...espalhados]) : [...candidatos, ...espalhados];
      }
      if (candidatos.length > 0) return this.#pagina(candidatos, c, termos, "indice");
    }
    const pedaco = this.trigram ? expressaoDoPedaco(termos) : null;
    if (pedaco) {
      const ordem = c.ordem === "recentes" ? "l.ts DESC, l.id DESC" : "bm25(pedacos), l.ts DESC, l.id DESC";
      const f = this.#filtrosSql(c);
      const linhas = this.#preparar(`SELECT l.id, l.bloco, l.conversa, l.ts, pedacos.tudo FROM pedacos JOIN linhas l ON l.id = pedacos.rowid WHERE pedacos MATCH ?${f.sql} ORDER BY ${ordem}`).all(pedaco, ...f.valores) as unknown as Array<LinhaAchada & { tudo: string }>;
      // Todos os termos precisam estar lá (inclusive os curtos, que o trigram não procura).
      const agulhas = termos.map(normalizarTexto);
      const achadas = linhas.filter((x) => agulhas.every((a) => normalizarTexto(x.tudo).includes(a))).map(({ tudo: _t, ...l }) => l);
      if (achadas.length > 0) return this.#pagina(juntarPorBloco(achadas, porMensagem), c, termos, "pedaco");
    }
    return null;
  }

  /**
   * Os blocos em que todas as palavras aparecem, mas não numa mensagem só (os de `excluir` já têm achado por
   * mensagem). Representa cada um a primeira mensagem do bloco, no período, que tem alguma das palavras; `achados` conta
   * as mensagens do bloco com alguma delas.
   */
  #espalhados(c: Consulta, termos: readonly string[], excluir: ReadonlySet<number>): Candidato[] {
    const todas = expressaoDoIndice(termos);
    const qualquer = expressaoDeQualquer(termos);
    if (!todas || !qualquer) return [];
    const doBloco = c.jid !== undefined ? { sql: " AND b.conversa = ?", valores: [c.jid] } : { sql: "", valores: [] };
    const ordem = c.ordem === "recentes" ? "b.fim DESC, b.id DESC" : "bm25(textos_dos_blocos), b.fim DESC, b.id DESC";
    const blocos = (this.#preparar(`SELECT b.id FROM textos_dos_blocos JOIN blocos b ON b.id = textos_dos_blocos.rowid WHERE textos_dos_blocos MATCH ?${doBloco.sql} ORDER BY ${ordem}`).all(todas, ...doBloco.valores) as Array<{ id: number }>)
      .map((x) => x.id)
      .filter((id) => !excluir.has(id));
    if (blocos.length === 0) return [];
    const procurados = new Set(blocos);
    const f = this.#filtrosSql({ ...c, de_mim: undefined } as Consulta, false);
    const linhas = this.#preparar(`SELECT l.id, l.bloco, l.conversa, l.ts FROM palavras JOIN linhas l ON l.id = palavras.rowid WHERE palavras MATCH ?${f.sql} ORDER BY l.ts, l.id`).all(qualquer, ...f.valores) as unknown as LinhaAchada[];
    const porBloco = new Map<number, { representa?: LinhaAchada; achados: number }>();
    for (const l of linhas) {
      if (!procurados.has(l.bloco)) continue;
      const p = porBloco.get(l.bloco) ?? { achados: 0 };
      p.achados++;
      if (!p.representa && dentroDoPeriodo(c, l.ts)) p.representa = l;
      porBloco.set(l.bloco, p);
    }
    return blocos.flatMap((id): Candidato[] => {
      const p = porBloco.get(id);
      return p?.representa ? [{ ...p.representa, achados: p.achados, espalhado: true }] : [];
    });
  }

  #pagina(candidatos: readonly Candidato[], c: Consulta, termos: readonly string[], caminho: Caminho): ResultadoDaBusca {
    const agulhas = agulhasDe(termos);
    const ler = this.#preparar(
      "SELECT l.id, l.conversa, l.mid, l.ts, l.de_mim, l.rem_nome, l.rem_numero, l.rem_part, p.texto, p.arquivo, p.transcricao FROM linhas l JOIN palavras p ON p.rowid = l.id WHERE l.id = ?",
    );
    const lerBloco = this.#preparar("SELECT inicio, fim, mensagens FROM blocos WHERE id = ?");
    const achados: Achado[] = [];
    for (const cand of candidatos.slice(c.inicio, c.inicio + c.limite)) {
      const l = ler.get(cand.id) as LinhaDoIndice | undefined;
      if (!l) continue;
      const b = lerBloco.get(cand.bloco) as { inicio: number; fim: number; mensagens: number } | undefined;
      const { achado_em, trecho } = localizar({ texto: l.texto ?? "", arquivo: l.arquivo ?? "", transcricao: l.transcricao ?? "" }, agulhas);
      const remetente = l.rem_nome !== null || l.rem_numero !== null ? { ...(l.rem_nome !== null ? { nome: l.rem_nome } : {}), ...(l.rem_numero !== null ? { numero: l.rem_numero } : {}) } : undefined;
      achados.push({
        jid: l.conversa,
        mensagem: { id: l.mid, ts: l.ts, de_mim: l.de_mim === 1, ...(remetente ? { remetente } : {}), ...(l.rem_part !== null ? { participante: l.rem_part } : {}) },
        trecho,
        achado_em,
        bloco: { inicio: b?.inicio ?? l.ts, fim: b?.fim ?? l.ts, mensagens: b?.mensagens ?? 1, achados: cand.achados },
        ...(cand.espalhado ? { espalhado: true as const } : {}),
      });
    }
    return { achados, total: candidatos.length, caminho, por_conversa: contarPorConversa(candidatos.map((x) => x.conversa)) };
  }

  // ---------- varredura (plano B, o comportamento de antes, com os blocos calculados aqui) ----------

  /**
   * Decifra e percorre as mensagens: todos os termos (sem acento nem maiúscula) precisam aparecer como pedaço de
   * texto, na mensagem, na transcrição ou no nome do arquivo. Sem relevância: a mais recente primeiro. Os blocos saem
   * da mesma função do índice (blocos.ts); com `espalhar`, procura também os espalhados.
   */
  async #varrer(banco: Banco, c: Consulta, termos: readonly string[], espalhar: boolean): Promise<ResultadoDaBusca> {
    const porMensagem = c.agrupar === "mensagem";
    const procurados = termos.map(normalizarTexto);
    const agulhas = agulhasDe(termos);
    const procurarEspalhados = espalhar && !porMensagem && c.de_mim === undefined && termos.length >= 2;
    const conversas = banco.listarConversas().filter((e) => (c.jid === undefined || e.jid === c.jid) && banco.aceitaGravar(e.jid));
    type Achada = { jid: string; m: MensagemGuardada; campos: Campos; ts: number; bloco: BlocoDoAchado; espalhado?: true };
    const diretos: Achada[] = [];
    const espalhados: Achada[] = [];
    const temAlguma = (m: MensagemGuardada) => {
      const n = normalizarTexto(textosDe(m).join("\n"));
      return procurados.some((t) => n.includes(t));
    };
    let passos = 0;
    for (const conversa of conversas) {
      const mensagens = banco.lerMensagens(conversa.jid);
      for (const b of dividirEmBlocos(mensagens)) {
        const doBloco = mensagens.slice(b.inicio, b.fim + 1);
        const info = { inicio: doBloco[0]!.ts, fim: doBloco[doBloco.length - 1]!.ts, mensagens: doBloco.length };
        const casam = doBloco.filter((m) => passaNosFiltros(c, m) && contemTodos(camposDe(m), procurados));
        if (casam.length > 0) {
          const bloco = { ...info, achados: casam.length };
          // Sem relevância na varredura: a mais nova do bloco representa.
          for (const m of porMensagem ? casam : [casam[casam.length - 1]!]) diretos.push({ jid: conversa.jid, m, campos: camposDe(m), ts: m.ts, bloco });
          continue;
        }
        if (!procurarEspalhados || doBloco.some((m) => contemTodos(camposDe(m), procurados))) continue;
        const texto = normalizarTexto(doBloco.flatMap(textosDe).join("\n"));
        if (!procurados.every((t) => texto.includes(t))) continue;
        const comAlguma = doBloco.filter(temAlguma);
        const representa = comAlguma.find((m) => passaNosFiltros(c, m));
        if (representa) espalhados.push({ jid: conversa.jid, m: representa, campos: camposDe(representa), ts: representa.ts, bloco: { ...info, achados: comAlguma.length }, espalhado: true });
      }
      if (++passos % CEDER_A_CADA === 0) await cederAoLaco();
    }
    const todos = c.ordem === "recentes" ? porData([...diretos, ...espalhados]) : [...porData(diretos), ...porData(espalhados)];
    const achados = todos.slice(c.inicio, c.inicio + c.limite).map(({ jid, m, campos, bloco, espalhado }): Achado => {
      const { achado_em, trecho } = localizar(campos, agulhas);
      return { jid, mensagem: { id: m.id, ts: m.ts, de_mim: m.de_mim, ...(m.remetente ? { remetente: m.remetente } : {}), ...(m.participante ? { participante: m.participante } : {}) }, trecho, achado_em, bloco, ...(espalhado ? { espalhado } : {}) };
    });
    return { achados, total: todos.length, caminho: "varredura", por_conversa: contarPorConversa(todos.map((x) => x.jid)) };
  }
}
