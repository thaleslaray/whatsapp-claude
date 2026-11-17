// Banco cifrado, sem dependência nativa. Tudo em arquivos dentro da pasta de dados (0700, arquivos 0600):
//   indice.enc              índice das conversas (jid, nome, última mensagem, não lidas), mapa LID->número
//                           e nomes de contatos conhecidos                                          AAD "indice"
//   config.enc              grupos permitidos, lista "nunca ler" (vazias) e envio ligado (desligado) AAD "config"
//                           e, desde a 0.15.1, a data da última agenda recebida do celular
//   grupos.enc              metadados dos grupos: nome e nº de participantes (cache de 1 h)        AAD "grupos"
//   envios.enc              as contagens do dia: respostas (limite diário), e desde a 0.7.0 conversas novas,
//                           reações e pedidos de histórico                                         AAD "envios"
//                           Só dia e números, sem dado de conversa: SOBREVIVE ao apagarTudo (wa_desconectar e
//                           loggedOut), para desconectar e parear de novo não zerar o limite do dia (decisão da Fase 3).
//   marcas.enc              até onde cada grupo já foi resumido (roteiro wa_resumo_dos_grupos)     AAD "marcas"
//   memoria.enc             0.10.0: a memória escrita pela IA (wa_anotar): um resumo por conversa e os
//                           compromissos (promessa, pedido, pergunta) com a citação conferida      AAD "memoria"
//                           Mesmo mecanismo das marcas (cache pela marca do arquivo, gravação atômica dentro da
//                           trava): o que um processo grava o outro lê. Apagar conversa, bloquear, tirar grupo,
//                           desconectar e loggedOut apagam a memória junto; mensagem apagada para todos leva os
//                           compromissos que a citam e o resumo que a cobre; mensagem editada leva os compromissos.
//   jeito.enc               0.12.0: o modo de aprendizado: o tipo de cada conversa (dado pelo dono), as regras de
//                           forma (propostas, ativas, recusadas, desligadas), as edições não mínimas dos cartões
//                           (rascunho da IA e texto enviado, até 2.000 caracteres cada, no máximo 500: saem primeiro
//                           as mais antigas já vistas) e a medida de cada envio a partir de rascunho (sem texto) AAD "jeito"
//                           Mesmo mecanismo da memória. Apagar conversa, bloquear, tirar grupo, desconectar e loggedOut
//                           levam o que se aprendeu dela; mensagem do dono apagada para todos leva as edições ligadas a ela;
//                           no mapeamento LID -> número, vai para o número. Desligado (config.enc) não guarda par novo.
//   conversas/<hmac>.jsonl  JSON Lines por conversa: CADA LINHA cifrada com AES-256-GCM,         AAD "msg:" + jid
//                           IV aleatório. No máximo `maxMensagens` (MAXIMO_DE_MENSAGENS_POR_CONVERSA, 5.000
//                           desde a 0.9.2) por conversa; sem apagar por tempo.
//   banco.trava             trava entre processos de quem grava (pasta.ts, comTravaDeArquivo)
// Tudo síncrono (arquivos pequenos): cada mudança lê, muda e grava de uma vez, dentro da trava.
// Quem lê (inclusive os processos leitores) não precisa da trava: toda gravação é atômica (rename).
//
// Defesa em profundidade: `gravarMensagens` recusa conversa bloqueada, grupo fora da lista, status, canal e
// lista de transmissão, mesmo que o transporte deixe passar.

import { createHmac, randomBytes } from "node:crypto";
import { abrir, selar, ErroDeLeitura } from "./cripto.ts";
import { ABERTURAS_POR_DIA, ATUALIZACOES_DE_CONTATOS_POR_DIA, LIMITE_DIARIO_MAXIMO, LIMITE_NOVAS_CONVERSAS_MAXIMO, MAXIMO_DE_MENSAGENS_POR_CONVERSA, PEDIDOS_DE_HISTORICO_MAXIMO } from "./config.ts";
import { ehGrupo, ehIndividual, ehLid, ehSempreIgnorado, jidDoNumero, normalizar, numeroDe } from "./jid.ts";
import {
  ABERTOS_POR_CONVERSA,
  comecoDoDia,
  DIAS_PARA_ESQUECER_FECHADOS,
  ondeEstaACitacao,
  normalizarEspacos,
  resolverPrazo,
  TAMANHO_MAXIMO_DA_CITACAO,
  TAMANHO_MAXIMO_DO_O_QUE,
  TAMANHO_MAXIMO_DO_RESUMO,
  type Compromisso,
  type EstadoDoCompromisso,
  type QuemDeve,
  type ResumoDaConversa,
  type TipoDeCompromisso,
} from "./memoria.ts";
import {
  chaveDaRegra,
  chaveDoTipo,
  MAXIMO_DE_EDICOES,
  MAXIMO_DE_PROPOSTAS_PENDENTES,
  MAXIMO_DE_REGRAS_ATIVAS,
  marcaDoRascunho,
  medirEdicao,
  normalizarTipo,
  TAMANHO_MAXIMO_DO_TEXTO_DA_EDICAO,
  type EdicaoGuardada,
  type EnvioDoRascunho,
  type EscopoDaRegra,
  type FerramentaDoRascunho,
  type MarcaDoRascunho,
  type Regra,
} from "./jeito.ts";
import { apagarArquivo, apagarPasta, comTravaDeArquivo, garantirPasta, gravarAtomico, lerOuNulo, listar, marcaDoArquivo, nomeDoArquivo, unir } from "./pasta.ts";

export type TipoMensagem = "texto" | "imagem" | "video" | "audio" | "nota_de_voz" | "documento" | "figurinha" | "localizacao" | "contato" | "enquete";

export interface MidiaMeta {
  mimetype?: string;
  tamanho?: number;
  nome?: string;
  duracao_s?: number;
  /** O endereço passou nas travas de mídia (midia.ts) e cabe no limite. Baixar fica para a Fase 4. */
  baixavel: boolean;
  /**
   * Para baixar (0.7.0, parte 2): a chave da mídia (base64), o caminho (`directPath`), o endereço (`url`) e os hashes
   * do arquivo e do arquivo cifrado (base64). Ficam só aqui dentro, na linha cifrada do banco; NUNCA saem para o modelo
   * (apresentacao.ts escolhe campo a campo o que mostra). `url` e os hashes só nas mensagens que chegam desde a 0.7.0.
   */
  chave?: string;
  caminho?: string;
  url?: string;
  sha256?: string;
  sha256_cifrado?: string;
}

export interface MensagemGuardada {
  id: string;
  /** Milissegundos desde 1970. */
  ts: number;
  de_mim: boolean;
  tipo: TipoMensagem;
  texto?: string;
  midia?: MidiaMeta;
  citada?: { id: string; texto?: string };
  /** Só em grupo e só em mensagem de outra pessoa: quem escreveu (nome público e dígitos do número, se conhecidos). */
  remetente?: { nome?: string; numero?: string };
  /** Quem escreveu editou depois: o texto guardado é o da última edição. */
  editada?: boolean;
  /**
   * Só em grupo e só em mensagem de outra pessoa: o jid de quem escreveu, como veio na chave (número ou LID). Citar,
   * reagir e apagar em grupo precisam dele na chave da mensagem. Nunca sai para o modelo.
   */
  participante?: string;
  /**
   * 0.7.0, parte 3: a transcrição automática do áudio (wa_transcrever), guardada cifrada junto com a mensagem. Feita
   * por máquina a partir da voz de quem mandou: pode ter erros, e sai para o modelo como conteúdo de terceiros.
   */
  transcricao?: { texto: string; idioma: string; em: number };
  /**
   * 0.12.0: mensagem minha enviada a partir de um rascunho da IA (cartão de wa_responder, wa_iniciar_conversa ou a
   * legenda de wa_enviar_arquivo): sem edição, com edição mínima ou editada pelo dono. As duas primeiras ficam fora da
   * medida do jeito e dos exemplos (a IA não aprende com ela mesma).
   */
  rascunho_da_ia?: MarcaDoRascunho;
}

export interface EntradaIndice {
  jid: string;
  grupo: boolean;
  /** Dígitos do número, quando se sabe. */
  numero?: string;
  nome?: string;
  prioridade_nome: number;
  /** 0.15.0: de onde veio o nome (só em conversa individual e só nos nomes gravados desde a 0.15.0). */
  origem_do_nome?: OrigemDoNome;
  ultima_ts: number;
  ultima_de_mim: boolean;
  /** Até 200 caracteres. */
  ultima_texto: string;
  nao_lidas: number;
  total: number;
  /**
   * Data da primeira mensagem recebida depois da última minha (ms): desde quando a pessoa espera resposta.
   * Ausente quando a última mensagem é minha (ou quando não há nenhuma recebida).
   */
  aguardando_desde?: number;
}

interface Indice {
  versao: 1;
  conversas: Record<string, EntradaIndice>;
  ultima_recebida_ts: number | null;
  lid_para_pn: Record<string, string>;
  /** Nomes de contatos individuais conhecidos antes de haver mensagem (até 5.000). */
  nomes: Record<string, { nome: string; prioridade: number; origem_do_nome?: OrigemDoNome }>;
}

export interface ConfigDoBanco {
  versao: 1;
  grupos_permitidos: string[];
  /** Lista "nunca ler": jids de pessoa (número e LID, quando conhecidos). */
  bloqueados: string[];
  /** wa_responder só envia com o envio ligado. Começa desligado; muda só com o clique no cartão do wa_envio. */
  envio_ligado?: boolean;
  /** 0.12.0: o modo de aprendizado começa ligado; `true` aqui = desligado pelo dono (wa_aprender com ligar: false). */
  aprendizado_desligado?: boolean;
  /** 0.15.1: quando (ms) a agenda do celular chegou inteira pela última vez (automática ou wa_atualizar_contatos). */
  agenda_atualizada_em?: number;
}

/**
 * Contagens do dia. `dia` = AAAA-MM-DD no relógio deste computador. `quantidade` = respostas (o nome antigo fica, para o
 * arquivo da 0.6.0 continuar valendo); `novas`, `reacoes` e `historico` desde a 0.7.0.
 */
interface Envios {
  dia: string;
  quantidade: number;
  novas?: number;
  reacoes?: number;
  historico?: number;
  /** 0.7.0, parte 2: mídias abertas (wa_abrir_midia). */
  aberturas?: number;
  /** 0.15.0: pedidos da agenda ao celular (wa_atualizar_contatos). */
  contatos?: number;
}

/** O que se conta por dia: respostas (inclui grupo, conversa nova e arquivo), conversas novas, reações, pedidos de histórico, mídias abertas e pedidos da agenda. */
export type Contagem = "envios" | "novas" | "reacoes" | "historico" | "aberturas" | "contatos";
const CAMPO_DA_CONTAGEM = { envios: "quantidade", novas: "novas", reacoes: "reacoes", historico: "historico", aberturas: "aberturas", contatos: "contatos" } as const;

/** Validade do cache dos metadados dos grupos. */
export const VALIDADE_DO_CACHE_DE_GRUPOS_MS = 60 * 60_000;

/** Dia local (AAAA-MM-DD) de uma data em ms. */
export function diaLocal(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export interface MetaDeGrupo {
  nome: string;
  participantes: number;
}
export interface CacheDeGrupos {
  em: number;
  grupos: Record<string, MetaDeGrupo>;
}

export class ErroDeBanco extends Error {
  override name = "ErroDeBanco";
}

export const TAMANHO_DA_ULTIMA = 200;
const MAXIMO_DE_NOMES = 5_000;

/**
 * Prioridade dos nomes: 3 contato salvo pelo dono na agenda do WhatsApp / assunto do grupo, 2 nome da conversa e nome de
 * empresa verificada (`verifiedName`, desde a 0.15.0), 1 nome público da pessoa.
 */
export const PRIORIDADE = { contato: 3, conversa: 2, publico: 1 } as const;

/**
 * 0.15.0: de onde veio o nome de uma conversa individual. `nome_da_conversa` é o nome que o WhatsApp dá à conversa no
 * histórico (`chat.name`), que não se sabe se é da agenda ou não.
 */
export const ORIGENS_DO_NOME = ["agenda_do_whatsapp", "empresa", "publico", "nome_da_conversa"] as const;
export type OrigemDoNome = (typeof ORIGENS_DO_NOME)[number];

/** 0.15.0: o que aconteceu com um nome pedido (`definirNome`): entrou onde não havia, trocou outro, já era esse, havia um melhor, ou recusado. */
export type ResultadoDoNome = "novo" | "atualizado" | "igual" | "pior" | "recusado";

/**
 * 0.15.0: o "nome" que é só um número (o WhatsApp mostra "+55∙∙∙∙∙∙∙∙∙87" para quem não está na agenda; ou um telefone
 * digitado como nome). Continua guardado e mostrado, mas marcado como número, e qualquer nome de verdade o substitui.
 */
export function nomeEhNumero(nome: string | undefined): boolean {
  if (!nome) return false;
  return /^[\s+()\-.\d∙•·*‧⋅●]+$/u.test(nome) && (nome.match(/\d/g)?.length ?? 0) >= 2;
}

/** 0.15.0: a origem de um nome guardado; sem a origem gravada (nomes de antes da 0.15.0), pela prioridade. */
export function origemDoNome(e: { nome?: string; prioridade_nome?: number; origem_do_nome?: OrigemDoNome }): OrigemDoNome | undefined {
  if (!e.nome || nomeEhNumero(e.nome)) return undefined;
  if (e.origem_do_nome) return e.origem_do_nome;
  const p = e.prioridade_nome ?? 0;
  if (p >= PRIORIDADE.contato) return "agenda_do_whatsapp";
  if (p >= PRIORIDADE.conversa) return "nome_da_conversa";
  if (p >= PRIORIDADE.publico) return "publico";
  return undefined;
}

/** 0.15.2: um contato para `aplicarContatos`: o par LID -> número (se vier) e o nome com a prioridade e a origem. */
export interface ContatoParaAplicar {
  lid?: string;
  pn?: string;
  nome?: string;
  prioridade: number;
  origem?: OrigemDoNome;
}

/** Um nome já limpo e conferido, pronto para o índice. */
interface NomePreparado {
  jid: string;
  limpo: string;
  prioridade: number;
  origem: OrigemDoNome | undefined;
}

/** 0.15.0: um nome a gravar (`definirNomes`). */
export interface NomeParaGravar {
  jid: string;
  nome: string | null | undefined;
  prioridade: number;
  origem?: OrigemDoNome;
}

const semAcento = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
export const normalizarTexto = semAcento;

/**
 * 0.11.0: o nome como o filtro por nome compara. NFKD (e não só NFD): letras "estilizadas" que se usa em nome de grupo
 * (𝗜𝗠𝗣𝗟𝗘𝗠𝗘𝗡𝗧𝗔𝗖̧𝗔̃𝗢, ｆｕｌｌｗｉｄｔｈ) viram as letras comuns; sem acento, sem seletor de variação e sem o juntador do emoji
 * (U+200D: "🤖" e "🤖️" são o mesmo emoji), espaços seguidos viram um.
 */
const paraFiltro = (s: string): string =>
  s
    .normalize("NFKD")
    .replace(/[\p{M}\u200d\ufe0e\ufe0f]/gu, "")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
/** Só letras e números (o emoji e a pontuação saem), para o filtro digitado sem o emoji do começo do nome. */
const soLetras = (s: string): string => s.replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/gu, " ").trim();

/** 0.11.0: o nome casa com o filtro? Com o emoji, sem ele, e filtro só de emoji (ver `paraFiltro`). */
export function nomeCasaComFiltro(nome: string, filtro: string): boolean {
  const f = paraFiltro(filtro);
  if (f === "") return true;
  const n = paraFiltro(nome);
  if (n.includes(f)) return true;
  const fl = soLetras(f);
  // Filtro sem letra nem número (só emoji): já foi comparado acima, sem espaços que atrapalhem.
  if (fl === "") return n.replace(/\s/gu, "").includes(f.replace(/\s/gu, ""));
  return soLetras(n).includes(fl);
}

export function descricaoCurta(m: Pick<MensagemGuardada, "tipo" | "texto">): string {
  const rotulo: Record<TipoMensagem, string> = {
    texto: "", imagem: "[imagem]", video: "[vídeo]", audio: "[áudio]", nota_de_voz: "[nota de voz]",
    documento: "[documento]", figurinha: "[figurinha]", localizacao: "[localização]", contato: "[contato]", enquete: "[enquete]",
  };
  return `${rotulo[m.tipo]}${rotulo[m.tipo] && m.texto ? " " : ""}${m.texto ?? ""}`.slice(0, TAMANHO_DA_ULTIMA);
}

/** Primeira recebida depois da última minha, se a última mensagem não é minha. */
function aguardandoDesde(mensagens: readonly MensagemGuardada[]): number | undefined {
  let desde: number | undefined;
  for (let i = mensagens.length - 1; i >= 0; i--) {
    const m = mensagens[i]!;
    if (m.de_mim) break;
    desde = m.ts;
  }
  return desde;
}

export interface OpcoesBanco {
  dir: string;
  chave: Buffer;
  maxMensagens?: number;
}

export interface OpcoesGravacao {
  /** Mensagens novas (não histórico) contam como não lidas quando não são minhas. */
  contarNaoLidas?: boolean;
}

interface Derivado {
  marca: string;
  grupos: Set<string>;
  /** Bloqueados mais os apelidos (LID <-> número) conhecidos. */
  bloqueados: Set<string>;
  /** Há número na lista "nunca ler" sem LID conhecido (a pessoa pode escrever por um LID que não sabemos de quem é). */
  bloqueioSemLid: boolean;
}

/** 0.10.0: a memória escrita pela IA (ver o topo e memoria.ts). */
interface Memoria {
  versao: 1;
  resumos: Record<string, ResumoDaConversa>;
  compromissos: Compromisso[];
}

/** O que a IA pede para anotar numa conversa (wa_anotar): tudo de uma vez, dentro da trava. */
export interface PedidoDeAnotacao {
  resumo?: { texto: string; ate: number };
  compromissos?: ReadonlyArray<{ tipo: TipoDeCompromisso; quem_deve: QuemDeve; o_que: string; mensagem_id: string; citacao: string; prazo?: string }>;
  fechar?: ReadonlyArray<{ id: string; estado: Exclude<EstadoDoCompromisso, "aberto">; evidencia_mensagem_id?: string }>;
}

export interface ResultadoDaAnotacao {
  resumo?: { ate: number };
  gravados: Array<{ posicao: number; compromisso: Compromisso; novo: boolean }>;
  fechados: Array<{ posicao: number; compromisso: Compromisso }>;
  recusados: Array<{ lista: "compromissos" | "fechar"; posicao: number; motivo: string }>;
}

/** 0.11.0: o valor de `prazo` que tira o prazo de um compromisso já gravado. */
export const PRAZO_NENHUM = "nenhum";

/** 0.12.0: o modo de aprendizado (ver o topo e jeito.ts). */
interface Jeito {
  versao: 1;
  tipos: Record<string, string>;
  regras: Regra[];
  edicoes: EdicaoGuardada[];
  envios: EnvioDoRascunho[];
  /** Cartões de rascunho cancelados ou vencidos: só a contagem, nunca o texto. */
  desistencias: { cancelados: number; expirados: number };
}

const JEITO_VAZIO = (): Jeito => ({ versao: 1, tipos: {}, regras: [], edicoes: [], envios: [], desistencias: { cancelados: 0, expirados: 0 } });
/** Quantos envios a partir de rascunho ficam medidos (a estatística usa os últimos 40). */
const MAXIMO_DE_ENVIOS_MEDIDOS = 500;

/** O escopo de uma regra como chega ao banco (jid já resolvido). */
export interface EscopoPedido {
  escopo: EscopoDaRegra;
  tipo?: string;
  conversa?: string;
}

/** O que a IA pede ao aprendizado numa chamada (wa_aprender): tudo de uma vez, dentro da trava. */
export interface PedidoDeAprendizado {
  propor?: ReadonlyArray<EscopoPedido & { texto: string; edicoes: readonly string[] }>;
  decidir?: { id: string; decisao: "aceitar" | "recusar" };
  regra_do_dono?: EscopoPedido & { texto: string };
  desligar?: readonly string[];
  apagar?: readonly string[];
  tipos?: ReadonlyArray<{ conversa: string; tipo: string | null }>;
  marcar_vistas?: readonly string[];
}

export interface ResultadoDoAprendizado {
  propostas: Array<{ posicao: number; id: string }>;
  decidida?: { id: string; estado: Regra["estado"] };
  regra_do_dono?: { id: string };
  desligadas: string[];
  apagadas: string[];
  tipos: number;
  vistas: number;
  recusados: Array<{ lista: string; posicao: number; motivo: string }>;
}

const MEMORIA_VAZIA = (): Memoria => ({ versao: 1, resumos: {}, compromissos: [] });

const INDICE_VAZIO = (): Indice => ({ versao: 1, conversas: {}, ultima_recebida_ts: null, lid_para_pn: {}, nomes: {} });
const CONFIG_VAZIA = (): ConfigDoBanco => ({ versao: 1, grupos_permitidos: [], bloqueados: [] });

export class Banco {
  readonly dir: string;
  readonly #chave: Buffer;
  readonly #max: number;
  readonly #cache = new Map<string, { marca: string; valor: unknown }>();
  #derivado: Derivado | null = null;
  #travas = 0;
  /** 0.9.0: quem quer saber, na hora, que este Banco apagou conversa ou tudo (ver `aoApagar`). */
  readonly #ouvintesDeApagar = new Set<() => void>();
  /** 0.15.2: quantas vezes este Banco gravou o índice (só conta; os testes conferem que a agenda grava por lote). */
  gravacoesDoIndice = 0;
  /** Linhas que não abriram (adulteradas ou de outra chave) desde a partida. */
  linhasIlegiveis = 0;

  constructor(opcoes: OpcoesBanco) {
    this.dir = opcoes.dir;
    this.#chave = opcoes.chave;
    this.#max = opcoes.maxMensagens ?? MAXIMO_DE_MENSAGENS_POR_CONVERSA;
    garantirPasta(this.dir);
    garantirPasta(unir(this.dir, "conversas"));
  }

  get maxMensagens(): number {
    return this.#max;
  }

  /**
   * 0.9.0: avisa quando ESTE Banco apaga uma conversa ou tudo (desconectar, bloquear, tirar grupo, última mensagem
   * apagada), para a busca e a triagem esquecerem na hora o que guardam em memória. Só o que este processo apaga: o que
   * outro processo apaga continua saindo na leitura seguinte, pelo carimbo do arquivo. Devolve como cancelar.
   */
  aoApagar(ouvinte: () => void): () => void {
    this.#ouvintesDeApagar.add(ouvinte);
    return () => this.#ouvintesDeApagar.delete(ouvinte);
  }

  #avisarQueApagou(): void {
    for (const o of this.#ouvintesDeApagar) {
      try {
        o();
      } catch {
        // quem ouve não impede o apagar
      }
    }
  }

  // ---------- arquivos cifrados de um só valor (com cache pela marca do arquivo) ----------

  /** O valor em cache é compartilhado: só leitura. Para mudar, use `structuredClone`. */
  #ler<T>(nome: string, aad: string, padrao: () => T): T {
    const caminho = unir(this.dir, nome);
    const marca = marcaDoArquivo(caminho);
    const emCache = this.#cache.get(nome);
    if (emCache && emCache.marca === marca) return emCache.valor as T;
    const bruto = marca === "ausente" ? null : lerOuNulo(caminho);
    let valor: T;
    if (bruto === null) valor = padrao();
    else {
      try {
        valor = JSON.parse(abrir(this.#chave, aad, bruto.trim())) as T;
      } catch (erro) {
        if (erro instanceof ErroDeLeitura) {
          throw new ErroDeBanco("A chave do cofre deste computador se perdeu (ou um arquivo foi alterado): ela não abre o banco. Use wa_desconectar (a prévia aparece mesmo assim) e depois wa_parear.");
        }
        throw erro;
      }
    }
    this.#cache.set(nome, { marca, valor });
    return valor;
  }

  #gravar(nome: string, aad: string, valor: unknown): void {
    gravarAtomico(unir(this.dir, nome), selar(this.#chave, aad, JSON.stringify(valor)));
    this.#cache.delete(nome);
  }

  #indice(): Indice {
    const i = this.#ler<Indice>("indice.enc", "indice", INDICE_VAZIO);
    i.nomes ??= {};
    return i;
  }
  #indiceParaMudar(): Indice {
    return structuredClone(this.#indice());
  }
  #gravarIndice(i: Indice): void {
    this.gravacoesDoIndice++;
    this.#gravar("indice.enc", "indice", i);
  }

  /** Toda mudança passa por aqui: trava entre processos, reentrante dentro do mesmo processo. */
  #mudar<T>(trabalho: () => T): T {
    if (this.#travas > 0) return trabalho();
    this.#travas++;
    try {
      return comTravaDeArquivo(unir(this.dir, "banco.trava"), trabalho);
    } finally {
      this.#travas--;
    }
  }

  // ---------- config: grupos permitidos e lista "nunca ler" ----------

  config(): ConfigDoBanco {
    return this.#ler<ConfigDoBanco>("config.enc", "config", CONFIG_VAZIA);
  }

  #gravarConfig(c: ConfigDoBanco): void {
    this.#gravar("config.enc", "config", c);
  }

  #listas(): Derivado {
    const marca = `${marcaDoArquivo(unir(this.dir, "config.enc"))}|${marcaDoArquivo(unir(this.dir, "indice.enc"))}`;
    if (this.#derivado && this.#derivado.marca === marca) return this.#derivado;
    const c = this.config();
    const mapa = this.#indice().lid_para_pn;
    const bloqueados = new Set(c.bloqueados);
    const comLid = new Set<string>();
    for (const [lid, pn] of Object.entries(mapa)) {
      if (bloqueados.has(lid)) bloqueados.add(pn);
      if (bloqueados.has(pn)) bloqueados.add(lid);
      comLid.add(pn);
    }
    const bloqueioSemLid = c.bloqueados.some((b) => numeroDe(b) !== undefined && !comLid.has(b));
    this.#derivado = { marca, grupos: new Set(c.grupos_permitidos), bloqueados, bloqueioSemLid };
    return this.#derivado;
  }

  /**
   * O `shouldIgnoreJid` da Baileys (Nod whatsapp.ts:344-349, com as listas do dono no lugar da lista do Nod):
   * status, canais e listas de transmissão sempre; grupo fora da lista; pessoa da lista "nunca ler".
   * O que volta true nem é decifrado.
   */
  deveIgnorar(jidBruto: string): boolean {
    const jid = normalizar(jidBruto);
    if (ehSempreIgnorado(jid)) return true;
    const l = this.#listas();
    if (jid.endsWith("@g.us")) return !l.grupos.has(jid);
    return l.bloqueados.has(jid);
  }

  /**
   * Só se grava conversa individual fora da lista "nunca ler" e grupo da lista. Um LID sem número conhecido também é
   * recusado quando há bloqueio por número sem LID conhecido: pode ser a pessoa bloqueada (o transporte pergunta o
   * número à Baileys antes; isto é a defesa em profundidade).
   */
  aceitaGravar(jid: string): boolean {
    if (ehSempreIgnorado(jid)) return false;
    const l = this.#listas();
    if (ehGrupo(jid)) return l.grupos.has(jid);
    if (!ehIndividual(jid)) return false;
    if (l.bloqueados.has(jid)) return false;
    if (ehLid(jid) && l.bloqueioSemLid && this.#indice().lid_para_pn[jid] === undefined) return false;
    return true;
  }

  /** Há número na lista "nunca ler" sem LID conhecido? (Ver `aceitaGravar`.) */
  haBloqueioSemLid(): boolean {
    return this.#listas().bloqueioSemLid;
  }

  envioLigado(): boolean {
    return this.config().envio_ligado === true;
  }

  /** Liga ou desliga o envio. Só o clique no cartão do wa_envio chega aqui. Devolve se mudou. */
  definirEnvio(ligado: boolean): boolean {
    return this.#mudar(() => {
      const c = structuredClone(this.config());
      if ((c.envio_ligado === true) === ligado) return false;
      c.envio_ligado = ligado;
      this.#gravarConfig(c);
      return true;
    });
  }

  // ---------- limite diário ----------

  #envios(agora: number): Envios {
    const e = this.#ler<Envios | null>("envios.enc", "envios", () => null);
    return e && e.dia === diaLocal(agora) ? e : { dia: diaLocal(agora), quantidade: 0 };
  }

  /** Quantas já foram contadas no dia de `agora`. */
  contagemDoDia(tipo: Contagem, agora: number): number {
    return this.#envios(agora)[CAMPO_DA_CONTAGEM[tipo]] ?? 0;
  }

  /** Quantas respostas já saíram no dia de `agora`. */
  enviosDoDia(agora: number): number {
    return this.contagemDoDia("envios", agora);
  }

  /**
   * Reserva de uma vez, ANTES de agir, uma unidade em cada contagem pedida (uma ação que falha no meio também conta:
   * na dúvida, conta). Se alguma já está no limite, lança com a frase dela e NÃO conta nenhuma. Devolve as contagens novas.
   */
  reservarContagens(agora: number, pedidos: ReadonlyArray<{ tipo: Contagem; limite: number; frase: string }>): Record<Contagem, number> {
    return this.#mudar(() => {
      const e = structuredClone(this.#envios(agora));
      for (const p of pedidos) {
        const atual = e[CAMPO_DA_CONTAGEM[p.tipo]] ?? 0;
        if (atual >= p.limite) throw new ErroDeBanco(p.frase);
      }
      for (const p of pedidos) e[CAMPO_DA_CONTAGEM[p.tipo]] = (e[CAMPO_DA_CONTAGEM[p.tipo]] ?? 0) + 1;
      this.#gravar("envios.enc", "envios", e satisfies Envios);
      return { envios: e.quantidade, novas: e.novas ?? 0, reacoes: e.reacoes ?? 0, historico: e.historico ?? 0, aberturas: e.aberturas ?? 0, contatos: e.contatos ?? 0 };
    });
  }

  /**
   * Reserva um envio no limite do dia, ANTES de enviar (um envio que falha no meio também conta: na dúvida, conta).
   * Lança se o limite já foi atingido. Devolve quantos ficam contados no dia.
   */
  reservarEnvio(agora: number, limite: number): number {
    const hoje = this.enviosDoDia(agora);
    return this.reservarContagens(agora, [{ tipo: "envios", limite, frase: `O limite de ${limite} respostas por dia foi atingido (${hoje} hoje). Nada foi enviado; o limite volta amanhã.` }]).envios;
  }

  // ---------- marcas do resumo dos grupos ----------

  #marcas(): Record<string, number> {
    return this.#ler<Record<string, number>>("marcas.enc", "marcas", () => ({}));
  }

  /** Até onde a conversa já foi resumida (ms da última mensagem incluída no resumo), ou undefined. */
  marcaDoResumo(jid: string): number | undefined {
    return this.#marcas()[normalizar(jid)];
  }

  guardarMarcaDoResumo(jid: string, ts: number): void {
    this.#mudar(() => {
      const m = structuredClone(this.#marcas());
      m[normalizar(jid)] = ts;
      this.#gravar("marcas.enc", "marcas", m);
    });
  }

  #apagarMarca(jid: string): void {
    const m = this.#marcas();
    if (m[jid] === undefined) return;
    const c = structuredClone(m);
    delete c[jid];
    this.#gravar("marcas.enc", "marcas", c);
  }

  // ---------- memória (0.10.0): resumos e compromissos escritos pela IA ----------

  #memoria(): Memoria {
    return this.#ler<Memoria>("memoria.enc", "memoria", MEMORIA_VAZIA);
  }

  /** Grava tirando os fechados há mais de 90 dias; memória vazia não deixa arquivo. */
  #gravarMemoria(m: Memoria, agora = Date.now()): void {
    const corte = agora - DIAS_PARA_ESQUECER_FECHADOS * 86_400_000;
    m.compromissos = m.compromissos.filter((c) => c.estado === "aberto" || (c.fechado_em ?? c.criado_em) >= corte);
    if (Object.keys(m.resumos).length === 0 && m.compromissos.length === 0) {
      apagarArquivo(unir(this.dir, "memoria.enc"));
      this.#cache.delete("memoria.enc");
      return;
    }
    this.#gravar("memoria.enc", "memoria", m);
  }

  /** O resumo guardado da conversa, ou undefined. Só leitura. */
  resumoDaConversa(jid: string): ResumoDaConversa | undefined {
    return this.#memoria().resumos[normalizar(jid)];
  }

  /** Os compromissos (de uma conversa, ou de todas), em cópia. */
  compromissos(jid?: string): Compromisso[] {
    const alvo = jid === undefined ? undefined : normalizar(jid);
    return structuredClone(this.#memoria().compromissos.filter((c) => alvo === undefined || c.conversa === alvo));
  }

  /** Quantas conversas têm resumo e quantos compromissos estão abertos (para o wa_estado e a lista). */
  contagemDaMemoria(): { conversas_com_resumo: number; compromissos_abertos: number } {
    const m = this.#memoria();
    return { conversas_com_resumo: Object.keys(m.resumos).length, compromissos_abertos: m.compromissos.filter((c) => c.estado === "aberto").length };
  }

  /** Compromissos abertos por conversa (jid -> quantos). */
  abertosPorConversa(): Map<string, number> {
    const n = new Map<string, number>();
    for (const c of this.#memoria().compromissos) if (c.estado === "aberto") n.set(c.conversa, (n.get(c.conversa) ?? 0) + 1);
    return n;
  }

  /**
   * wa_anotar, numa conversa e de uma vez (dentro da trava, lendo as mensagens uma vez só): o resumo (que também guarda
   * a marca do resumo em `ate`), os compromissos (citação conferida na mensagem, prazo resolvido pela data dela) e os
   * fechamentos. `ate` inválido lança antes de gravar qualquer coisa; um compromisso ou fechamento que não confere é
   * recusado com o motivo e os outros entram.
   */
  anotar(jidBruto: string, pedido: PedidoDeAnotacao, agora: number): ResultadoDaAnotacao {
    const jid = normalizar(jidBruto);
    return this.#mudar(() => {
      const mensagens = this.lerMensagens(jid);
      if (mensagens.length === 0) throw new ErroDeBanco("Não há mensagens guardadas dessa conversa. Veja wa_listar_conversas.");
      const ultima = mensagens[mensagens.length - 1]!;
      if (pedido.resumo) {
        const { texto, ate } = pedido.resumo;
        if (ate > agora + 300_000) throw new ErroDeBanco("`ate` está no futuro: use a `marca` que wa_ler_conversa ou wa_listar_conversas devolveu. Nada foi gravado.");
        if (ate > ultima.ts) throw new ErroDeBanco("`ate` é depois da última mensagem guardada desta conversa: use a `marca` que wa_ler_conversa ou wa_listar_conversas devolveu. Nada foi gravado.");
        if (texto.trim() === "" || texto.length > TAMANHO_MAXIMO_DO_RESUMO) throw new ErroDeBanco(`O resumo tem de ter de 1 a ${TAMANHO_MAXIMO_DO_RESUMO} caracteres. Nada foi gravado.`);
      }
      const porId = new Map(mensagens.map((m) => [m.id, m]));
      const mem = structuredClone(this.#memoria());
      const r: ResultadoDaAnotacao = { gravados: [], fechados: [], recusados: [] };
      if (pedido.resumo) {
        mem.resumos[jid] = { texto: pedido.resumo.texto.trim(), ate: pedido.resumo.ate, escrito_em: agora };
        r.resumo = { ate: pedido.resumo.ate };
      }
      for (const [i, c] of (pedido.compromissos ?? []).entries()) {
        const recusar = (motivo: string) => r.recusados.push({ lista: "compromissos", posicao: i + 1, motivo });
        const o_que = c.o_que.trim();
        const citacao = normalizarEspacos(c.citacao);
        if (o_que === "" || o_que.length > TAMANHO_MAXIMO_DO_O_QUE) { recusar(`o_que tem de ter de 1 a ${TAMANHO_MAXIMO_DO_O_QUE} caracteres`); continue; }
        if (citacao === "" || citacao.length > TAMANHO_MAXIMO_DA_CITACAO) { recusar(`citacao tem de ter de 1 a ${TAMANHO_MAXIMO_DA_CITACAO} caracteres`); continue; }
        const m = porId.get(c.mensagem_id);
        if (!m) { recusar("a mensagem não está guardada nesta conversa: use o id que wa_ler_conversa devolveu, da mesma conversa"); continue; }
        const onde = ondeEstaACitacao(m, citacao);
        if (!onde) { recusar("a citação não está nessa mensagem: copie a frase exata (com maiúsculas e acentos; só os espaços podem variar), do texto ou da transcrição"); continue; }
        // 0.11.0: `prazo: "nenhum"` tira o prazo; sem o campo, regravar mantém o prazo que já havia (o modelo costuma
        // regravar só para corrigir o texto, e perdia o prazo sem querer).
        const semPrazo = c.prazo !== undefined && c.prazo.trim().toLowerCase() === PRAZO_NENHUM;
        let prazo: number | undefined;
        if (c.prazo !== undefined && !semPrazo) {
          const p = resolverPrazo(c.prazo, m.ts);
          if (!p.ok) { recusar(p.motivo); continue; }
          prazo = p.prazo;
        }
        const existente = mem.compromissos.find((x) => x.conversa === jid && x.mensagem_id === m.id && x.quem_deve === c.quem_deve);
        if (existente) {
          existente.tipo = c.tipo;
          existente.o_que = o_que;
          existente.citacao = citacao;
          existente.citacao_em = onde;
          if (semPrazo) delete existente.prazo;
          else if (prazo !== undefined) existente.prazo = prazo;
          r.gravados.push({ posicao: i + 1, compromisso: structuredClone(existente), novo: false });
          continue;
        }
        const abertos = mem.compromissos.filter((x) => x.conversa === jid && x.estado === "aberto").length;
        if (abertos >= ABERTOS_POR_CONVERSA) { recusar(`esta conversa já tem ${ABERTOS_POR_CONVERSA} compromissos abertos (o máximo): feche os cumpridos ou cancelados com \`fechar\` antes`); continue; }
        const ids = new Set(mem.compromissos.map((x) => x.id));
        let id: string;
        do id = `k_${randomBytes(4).toString("hex")}`;
        while (ids.has(id));
        const novo: Compromisso = {
          id,
          conversa: jid,
          tipo: c.tipo,
          quem_deve: c.quem_deve,
          o_que,
          citacao,
          citacao_em: onde,
          mensagem_id: m.id,
          mensagem_ts: m.ts,
          mensagem_de_mim: m.de_mim,
          ...(m.remetente ? { remetente: { ...m.remetente } } : {}),
          // 0.11.0: quem escreveu (jid, número ou LID) fica guardado cifrado para mostrar o número quando o mapa o conhecer
          // e o rótulo estável da pessoa; nunca sai para o modelo.
          ...(m.participante ? { participante: m.participante } : {}),
          ...(prazo !== undefined ? { prazo } : {}),
          estado: "aberto",
          criado_em: agora,
        };
        mem.compromissos.push(novo);
        r.gravados.push({ posicao: i + 1, compromisso: structuredClone(novo), novo: true });
      }
      for (const [i, f] of (pedido.fechar ?? []).entries()) {
        const recusar = (motivo: string) => r.recusados.push({ lista: "fechar", posicao: i + 1, motivo });
        const c = mem.compromissos.find((x) => x.id === f.id && x.conversa === jid);
        if (!c) { recusar("não há compromisso com esse id nesta conversa: veja wa_memoria"); continue; }
        if (f.evidencia_mensagem_id !== undefined) {
          const ev = porId.get(f.evidencia_mensagem_id);
          if (!ev) { recusar("a mensagem de evidência não está guardada nesta conversa"); continue; }
          if (ev.ts < comecoDoDia(c.mensagem_ts)) { recusar("a mensagem de evidência é de antes do compromisso"); continue; }
        }
        c.estado = f.estado;
        c.fechado_em = agora;
        if (f.evidencia_mensagem_id !== undefined) c.evidencia_mensagem_id = f.evidencia_mensagem_id;
        else delete c.evidencia_mensagem_id;
        r.fechados.push({ posicao: i + 1, compromisso: structuredClone(c) });
      }
      if (r.resumo || r.gravados.length > 0 || r.fechados.length > 0) this.#gravarMemoria(mem, agora);
      if (r.resumo) {
        // Uma chamada faz as duas coisas: o resumo e a marca de até onde a IA leu.
        const marcas = structuredClone(this.#marcas());
        marcas[jid] = r.resumo.ate;
        this.#gravar("marcas.enc", "marcas", marcas);
      }
      return r;
    });
  }

  /** wa_esquecer: apaga a memória de uma conversa (ou toda), sem tocar nas mensagens nem na marca do resumo. Devolve as contagens. */
  esquecerMemoria(jid?: string): { resumos: number; compromissos: number } {
    return this.#mudar(() => {
      if (jid === undefined) {
        const m = this.#memoria();
        const n = { resumos: Object.keys(m.resumos).length, compromissos: m.compromissos.length };
        apagarArquivo(unir(this.dir, "memoria.enc"));
        this.#cache.delete("memoria.enc");
        return n;
      }
      const tirada = this.#tirarMemoria(normalizar(jid));
      return { resumos: tirada.resumo ? 1 : 0, compromissos: tirada.compromissos.length };
    });
  }

  /** Tira (e grava sem) a memória de uma conversa; devolve o que tirou (para o mapeamento LID -> número levar junto). */
  #tirarMemoria(jid: string): { resumo?: ResumoDaConversa; compromissos: Compromisso[] } {
    const atual = this.#memoria();
    const resumo = atual.resumos[jid];
    const compromissos = atual.compromissos.filter((c) => c.conversa === jid);
    if (!resumo && compromissos.length === 0) return { compromissos: [] };
    const m = structuredClone(atual);
    delete m.resumos[jid];
    m.compromissos = m.compromissos.filter((c) => c.conversa !== jid);
    this.#gravarMemoria(m);
    return { ...(resumo ? { resumo: structuredClone(resumo) } : {}), compromissos: structuredClone(compromissos) };
  }

  /**
   * Uma mensagem saiu (apagada para todos) ou mudou (editada): os compromissos que a citam saem (a citação ficou velha
   * ou apagada) e a evidência que apontava para ela também. Apagada e coberta pelo resumo (`ts <= ate`): o resumo sai
   * (pode conter o que a pessoa quis apagar; a IA refaz depois).
   */
  #memoriaDaMensagem(jid: string, alvo: MensagemGuardada, apagada: boolean): void {
    const atual = this.#memoria();
    const resumo = atual.resumos[jid];
    const tiraResumo = apagada && resumo !== undefined && alvo.ts <= resumo.ate;
    const cita = (c: Compromisso) => c.conversa === jid && c.mensagem_id === alvo.id;
    const evidencia = (c: Compromisso) => apagada && c.conversa === jid && c.evidencia_mensagem_id === alvo.id;
    if (!tiraResumo && !atual.compromissos.some((c) => cita(c) || evidencia(c))) return;
    const m = structuredClone(atual);
    if (tiraResumo) delete m.resumos[jid];
    m.compromissos = m.compromissos.filter((c) => !cita(c));
    for (const c of m.compromissos) if (evidencia(c)) delete c.evidencia_mensagem_id;
    this.#gravarMemoria(m);
  }

  // ---------- aprendizado (0.12.0): tipos das conversas, regras de forma e edições dos cartões ----------

  #jeito(): Jeito {
    return this.#ler<Jeito>("jeito.enc", "jeito", JEITO_VAZIO);
  }

  /** Aprendizado vazio (nem contagem) não deixa arquivo. */
  #gravarJeito(j: Jeito): void {
    const vazio = Object.keys(j.tipos).length === 0 && j.regras.length === 0 && j.edicoes.length === 0 && j.envios.length === 0;
    if (vazio && j.desistencias.cancelados === 0 && j.desistencias.expirados === 0) {
      apagarArquivo(unir(this.dir, "jeito.enc"));
      this.#cache.delete("jeito.enc");
      return;
    }
    this.#gravar("jeito.enc", "jeito", j);
  }

  /** O modo de aprendizado está ligado? Começa ligado. */
  aprendizadoLigado(): boolean {
    return this.config().aprendizado_desligado !== true;
  }

  /** Liga ou desliga o aprendizado (persiste no config.enc). Devolve se mudou. */
  /** 0.15.1: a data (ms) da última ressincronização da agenda que terminou sem erro, se houver. */
  agendaAtualizadaEm(): number | undefined {
    const ms = this.config().agenda_atualizada_em;
    return typeof ms === "number" && Number.isFinite(ms) ? ms : undefined;
  }

  /** 0.15.1: grava a data da ressincronização bem-sucedida (no config.enc: o desconectar apaga junto). */
  definirAgendaAtualizadaEm(ms: number): void {
    this.#mudar(() => {
      const c = structuredClone(this.config());
      c.agenda_atualizada_em = ms;
      this.#gravarConfig(c);
    });
  }

  definirAprendizado(ligado: boolean): boolean {
    return this.#mudar(() => {
      const c = structuredClone(this.config());
      if (this.aprendizadoLigado() === ligado) return false;
      if (ligado) delete c.aprendizado_desligado;
      else c.aprendizado_desligado = true;
      this.#gravarConfig(c);
      return true;
    });
  }

  /** Conversa (jid) -> tipo dado pelo dono, em cópia. */
  tiposDasConversas(): Record<string, string> {
    return { ...this.#jeito().tipos };
  }

  tipoDaConversa(jid: string): string | undefined {
    return this.#jeito().tipos[normalizar(jid)];
  }

  /** As regras (todas, em cópia). */
  regras(): Regra[] {
    return structuredClone(this.#jeito().regras);
  }

  /** As edições guardadas (em cópia), da mais antiga para a mais nova. */
  edicoes(): EdicaoGuardada[] {
    return structuredClone(this.#jeito().edicoes);
  }

  /** Os envios a partir de rascunho (só medidas) e as desistências, para a estatística do aprendizado. */
  enviosDeRascunho(): { envios: EnvioDoRascunho[]; desistencias: { cancelados: number; expirados: number } } {
    const j = this.#jeito();
    return { envios: structuredClone(j.envios), desistencias: { ...j.desistencias } };
  }

  /** Só contagens (wa_estado). */
  contagemDoAprendizado(): { regras_ativas: number; propostas_pendentes: number; edicoes_guardadas: number } {
    const j = this.#jeito();
    return {
      regras_ativas: j.regras.filter((r) => r.estado === "ativa").length,
      propostas_pendentes: j.regras.filter((r) => r.estado === "proposta").length,
      edicoes_guardadas: j.edicoes.length,
    };
  }

  /**
   * Um cartão de rascunho foi confirmado e a mensagem saiu: guarda a medida do envio e, se o dono editou de verdade
   * (edição não mínima), o par rascunho/enviado. Devolve a marca. Quem chama confere se o aprendizado está ligado.
   */
  guardarEnvioDeRascunho(par: { conversa: string; mensagem_id: string; ferramenta: FerramentaDoRascunho; rascunho: string; enviado: string; em: number }): MarcaDoRascunho {
    const conversa = normalizar(par.conversa);
    const marca = marcaDoRascunho(par.rascunho, par.enviado);
    const medida = marca === "sem_edicao" ? undefined : medirEdicao(par.rascunho, par.enviado);
    this.#mudar(() => {
      const j = structuredClone(this.#jeito());
      j.envios.push({ em: par.em, conversa, distancia: medida?.distancia ?? 0, marca });
      if (j.envios.length > MAXIMO_DE_ENVIOS_MEDIDOS) j.envios.splice(0, j.envios.length - MAXIMO_DE_ENVIOS_MEDIDOS);
      if (marca === "editado" && medida) {
        const ids = new Set(j.edicoes.map((e) => e.id));
        let id: string;
        do id = `e_${randomBytes(4).toString("hex")}`;
        while (ids.has(id));
        j.edicoes.push({
          id,
          conversa,
          mensagem_id: par.mensagem_id,
          em: par.em,
          ferramenta: par.ferramenta,
          rascunho: par.rascunho.slice(0, TAMANHO_MAXIMO_DO_TEXTO_DA_EDICAO),
          enviado: par.enviado.slice(0, TAMANHO_MAXIMO_DO_TEXTO_DA_EDICAO),
          distancia: medida.distancia,
          resumo: medida.resumo,
          vista: false,
        });
        // Teto: saem primeiro as mais antigas já vistas; sem vistas, as mais antigas.
        while (j.edicoes.length > MAXIMO_DE_EDICOES) {
          const vista = j.edicoes.findIndex((e) => e.vista);
          j.edicoes.splice(vista >= 0 ? vista : 0, 1);
        }
        Banco.#podarPropostas(j);
      }
      this.#gravarJeito(j);
    });
    return marca;
  }

  /** Cartão de rascunho cancelado ou vencido: só a contagem (o texto nunca é guardado). */
  contarRascunhoSemEnvio(motivo: "cancelado" | "expirado"): void {
    this.#mudar(() => {
      const j = structuredClone(this.#jeito());
      if (motivo === "cancelado") j.desistencias.cancelados++;
      else j.desistencias.expirados++;
      this.#gravarJeito(j);
    });
  }

  /** Proposta aprendida cujas edições sumiram (conversa apagada, mensagem apagada, teto) e ficaram menos de duas: sai. */
  static #podarPropostas(j: Jeito): void {
    const existem = new Set(j.edicoes.map((e) => e.id));
    j.regras = j.regras.filter((r) => {
      if (r.origem !== "edicoes") return true;
      r.edicoes = (r.edicoes ?? []).filter((id) => existem.has(id));
      return r.estado !== "proposta" || r.edicoes.length >= 2;
    });
  }

  /**
   * wa_aprender, de uma vez (dentro da trava): propostas (conferidas contra as edições guardadas), a decisão do dono,
   * a regra ditada por ele, desligar, apagar, os tipos das conversas e as edições vistas. O que não confere é recusado
   * com o motivo e o resto entra.
   */
  aprender(pedido: PedidoDeAprendizado, agora: number): ResultadoDoAprendizado {
    return this.#mudar(() => {
      const j = structuredClone(this.#jeito());
      const r: ResultadoDoAprendizado = { propostas: [], desligadas: [], apagadas: [], tipos: 0, vistas: 0, recusados: [] };
      const novoId = () => {
        const ids = new Set(j.regras.map((x) => x.id));
        let id: string;
        do id = `r_${randomBytes(4).toString("hex")}`;
        while (ids.has(id));
        return id;
      };
      const mesmoEscopo = (x: Regra, e: EscopoPedido) =>
        x.escopo === e.escopo && (e.escopo !== "tipo" || chaveDoTipo(x.tipo ?? "") === chaveDoTipo(e.tipo ?? "")) && (e.escopo !== "conversa" || x.conversa === e.conversa);
      const ativas = () => j.regras.filter((x) => x.estado === "ativa").length;
      const TETO = `já há ${MAXIMO_DE_REGRAS_ATIVAS} regras ativas (o máximo): desligue ou apague alguma antes`;
      const conferirEscopo = (e: EscopoPedido): string | undefined => {
        if (e.escopo === "tipo" && (e.tipo === undefined || normalizarTipo(e.tipo) === "")) return "escopo `tipo` precisa do nome do tipo em `tipo`";
        if (e.escopo === "conversa" && e.conversa === undefined) return "escopo `conversa` precisa de `conversa`";
        return undefined;
      };
      const escopoGuardado = (e: EscopoPedido) => ({
        escopo: e.escopo,
        ...(e.escopo === "tipo" ? { tipo: normalizarTipo(e.tipo!) } : {}),
        ...(e.escopo === "conversa" ? { conversa: normalizar(e.conversa!) } : {}),
      });

      // Tipos primeiro: uma regra de escopo tipo pode vir na mesma chamada.
      for (const [i, t] of (pedido.tipos ?? []).entries()) {
        const jid = normalizar(t.conversa);
        const tipo = t.tipo === null ? "" : normalizarTipo(t.tipo);
        if (tipo === "") delete j.tipos[jid];
        else j.tipos[jid] = tipo;
        r.tipos++;
        void i;
      }

      for (const [i, p] of (pedido.propor ?? []).entries()) {
        const recusar = (motivo: string) => r.recusados.push({ lista: "propor", posicao: i + 1, motivo });
        const e = { escopo: p.escopo, ...(p.tipo !== undefined ? { tipo: p.tipo } : {}), ...(p.conversa !== undefined ? { conversa: normalizar(p.conversa) } : {}) };
        const erro = conferirEscopo(e);
        if (erro) { recusar(erro); continue; }
        const texto = p.texto.trim();
        if (texto === "") { recusar("texto vazio"); continue; }
        const ids = [...new Set(p.edicoes)];
        const achadas = ids.map((id) => j.edicoes.find((x) => x.id === id));
        if (achadas.some((x) => x === undefined)) { recusar("há edição que não existe (ou já saiu): use os ids de wa_edicoes_dos_rascunhos"); continue; }
        const eds = achadas as EdicaoGuardada[];
        if (eds.length < 2) { recusar("uma regra aprendida precisa de pelo menos DUAS edições que mostrem o padrão; com uma só, não vira regra"); continue; }
        const variadas = eds.some((a, x) => eds.some((b, y) => y > x && (diaLocal(a.em) !== diaLocal(b.em) || a.conversa !== b.conversa)));
        if (!variadas) { recusar("as edições têm de ser de dias ou de conversas diferentes (duas edições do mesmo momento não mostram um padrão)"); continue; }
        if (e.escopo === "conversa" && eds.some((x) => x.conversa !== e.conversa)) { recusar("regra de uma conversa só sai de edições dessa conversa"); continue; }
        const chave = chaveDaRegra(texto);
        const igual = j.regras.find((x) => chaveDaRegra(x.texto) === chave && mesmoEscopo(x, e));
        if (igual) {
          if (igual.estado === "recusada") { recusar(`o dono já recusou essa regra (${igual.id}): não proponha de novo`); continue; }
          // Igual já existe: não duplica; as edições novas entram como mais evidência.
          if (igual.origem === "edicoes") igual.edicoes = [...new Set([...(igual.edicoes ?? []), ...ids])];
          r.propostas.push({ posicao: i + 1, id: igual.id });
          continue;
        }
        if (j.regras.filter((x) => x.estado === "proposta").length >= MAXIMO_DE_PROPOSTAS_PENDENTES) { recusar(`já há ${MAXIMO_DE_PROPOSTAS_PENDENTES} propostas esperando o dono: peça a decisão dele antes`); continue; }
        const nova: Regra = { id: novoId(), texto, ...escopoGuardado(e), origem: "edicoes", estado: "proposta", edicoes: ids, criada_em: agora, entregue: 0 };
        j.regras.push(nova);
        r.propostas.push({ posicao: i + 1, id: nova.id });
      }

      if (pedido.decidir) {
        const recusar = (motivo: string) => r.recusados.push({ lista: "decidir", posicao: 1, motivo });
        const regra = j.regras.find((x) => x.id === pedido.decidir!.id);
        if (!regra) recusar("não há regra com esse id: veja wa_meu_jeito");
        else if (pedido.decidir.decisao === "recusar") {
          if (regra.estado !== "proposta") recusar(`só se recusa proposta (esta está ${regra.estado}); para tirar uma ativa, use desligar ou apagar`);
          else {
            regra.estado = "recusada";
            regra.decidida_em = agora;
            r.decidida = { id: regra.id, estado: regra.estado };
          }
        } else if (regra.estado === "ativa") r.decidida = { id: regra.id, estado: regra.estado };
        else if (regra.estado === "recusada") recusar("o dono recusou essa regra; para valer, ele dita de novo (regra_do_dono)");
        else if (ativas() >= MAXIMO_DE_REGRAS_ATIVAS) recusar(TETO);
        else {
          regra.estado = "ativa";
          regra.ativa_desde = agora;
          regra.decidida_em = agora;
          r.decidida = { id: regra.id, estado: regra.estado };
        }
      }

      if (pedido.regra_do_dono) {
        const p = pedido.regra_do_dono;
        const recusar = (motivo: string) => r.recusados.push({ lista: "regra_do_dono", posicao: 1, motivo });
        const e = { escopo: p.escopo, ...(p.tipo !== undefined ? { tipo: p.tipo } : {}), ...(p.conversa !== undefined ? { conversa: normalizar(p.conversa) } : {}) };
        const erro = conferirEscopo(e);
        const texto = p.texto.trim();
        const igual = j.regras.find((x) => chaveDaRegra(x.texto) === chaveDaRegra(texto) && mesmoEscopo(x, e));
        if (erro) recusar(erro);
        else if (texto === "") recusar("texto vazio");
        else if (igual?.estado === "ativa") r.regra_do_dono = { id: igual.id };
        else if (ativas() >= MAXIMO_DE_REGRAS_ATIVAS) recusar(TETO);
        else if (igual) {
          // A mesma regra proposta, recusada ou desligada: o dono disse, vale (e passa a ser dele).
          igual.estado = "ativa";
          igual.origem = "dono";
          igual.ativa_desde = agora;
          igual.decidida_em = agora;
          r.regra_do_dono = { id: igual.id };
        } else {
          const nova: Regra = { id: novoId(), texto, ...escopoGuardado(e), origem: "dono", estado: "ativa", criada_em: agora, ativa_desde: agora, entregue: 0 };
          j.regras.push(nova);
          r.regra_do_dono = { id: nova.id };
        }
      }

      for (const [i, id] of (pedido.desligar ?? []).entries()) {
        const regra = j.regras.find((x) => x.id === id);
        if (!regra) r.recusados.push({ lista: "desligar", posicao: i + 1, motivo: "não há regra com esse id" });
        else if (regra.estado !== "ativa") r.recusados.push({ lista: "desligar", posicao: i + 1, motivo: `a regra não está ativa (está ${regra.estado})` });
        else {
          regra.estado = "desligada";
          delete regra.ativa_desde;
          r.desligadas.push(id);
        }
      }

      for (const [i, id] of (pedido.apagar ?? []).entries()) {
        const antes = j.regras.length;
        j.regras = j.regras.filter((x) => x.id !== id);
        if (j.regras.length === antes) r.recusados.push({ lista: "apagar", posicao: i + 1, motivo: "não há regra com esse id" });
        else r.apagadas.push(id);
      }

      for (const [i, id] of (pedido.marcar_vistas ?? []).entries()) {
        const e = j.edicoes.find((x) => x.id === id);
        if (!e) r.recusados.push({ lista: "marcar_vistas", posicao: i + 1, motivo: "não há edição com esse id" });
        else if (!e.vista) {
          e.vista = true;
          r.vistas++;
        }
      }

      this.#gravarJeito(j);
      return r;
    });
  }

  /** Conta uma entrega das regras ao modelo (só o dono da conexão chama: o leitor não grava). */
  contarEntregas(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const alvo = new Set(ids);
    this.#mudar(() => {
      const j = structuredClone(this.#jeito());
      let mudou = false;
      for (const r of j.regras) {
        if (!alvo.has(r.id)) continue;
        r.entregue++;
        mudou = true;
      }
      if (mudou) this.#gravarJeito(j);
    });
  }

  /** wa_esquecer com `aprendizado`: o de uma conversa (tipo, regras dela, edições e medidas) ou tudo (jeito.enc sai). */
  esquecerAprendizado(jid?: string): { tipos: number; regras: number; edicoes: number } {
    return this.#mudar(() => {
      if (jid === undefined) {
        const j = this.#jeito();
        const n = { tipos: Object.keys(j.tipos).length, regras: j.regras.length, edicoes: j.edicoes.length };
        apagarArquivo(unir(this.dir, "jeito.enc"));
        this.#cache.delete("jeito.enc");
        return n;
      }
      const t = this.#tirarJeito(normalizar(jid));
      return { tipos: t.tipo !== undefined ? 1 : 0, regras: t.regras.length, edicoes: t.edicoes.length };
    });
  }

  /** Há algo aprendido sob este jid? (Para o mapeamento LID -> número saber se tem o que mover.) */
  #temJeito(jid: string): boolean {
    const j = this.#jeito();
    return j.tipos[jid] !== undefined || j.regras.some((r) => r.conversa === jid) || j.edicoes.some((e) => e.conversa === jid) || j.envios.some((e) => e.conversa === jid);
  }

  /** Tira (e grava sem) o que se aprendeu de uma conversa; devolve o que tirou (para o mapeamento LID -> número). */
  #tirarJeito(jid: string): { tipo?: string; regras: Regra[]; edicoes: EdicaoGuardada[]; envios: EnvioDoRascunho[] } {
    if (!this.#temJeito(jid)) return { regras: [], edicoes: [], envios: [] };
    const atual = this.#jeito();
    const tirado = {
      ...(atual.tipos[jid] !== undefined ? { tipo: atual.tipos[jid] } : {}),
      regras: structuredClone(atual.regras.filter((r) => r.conversa === jid)),
      edicoes: structuredClone(atual.edicoes.filter((e) => e.conversa === jid)),
      envios: structuredClone(atual.envios.filter((e) => e.conversa === jid)),
    };
    const j = structuredClone(atual);
    delete j.tipos[jid];
    j.regras = j.regras.filter((r) => r.conversa !== jid);
    j.edicoes = j.edicoes.filter((e) => e.conversa !== jid);
    j.envios = j.envios.filter((e) => e.conversa !== jid);
    Banco.#podarPropostas(j);
    this.#gravarJeito(j);
    return tirado;
  }

  /** Põe sob `jid` o aprendizado tirado de outra forma da mesma conversa; o que já existe sob `jid` vence no empate. */
  #juntarJeito(jid: string, tirado: { tipo?: string; regras: Regra[]; edicoes: EdicaoGuardada[]; envios: EnvioDoRascunho[] }): void {
    if (tirado.tipo === undefined && tirado.regras.length === 0 && tirado.edicoes.length === 0 && tirado.envios.length === 0) return;
    const j = structuredClone(this.#jeito());
    if (tirado.tipo !== undefined && j.tipos[jid] === undefined) j.tipos[jid] = tirado.tipo;
    for (const r of tirado.regras) {
      if (j.regras.some((x) => x.conversa === jid && chaveDaRegra(x.texto) === chaveDaRegra(r.texto))) continue;
      j.regras.push({ ...r, conversa: jid });
    }
    for (const e of tirado.edicoes) j.edicoes.push({ ...e, conversa: jid });
    j.edicoes.sort((a, b) => a.em - b.em);
    for (const e of tirado.envios) j.envios.push({ ...e, conversa: jid });
    j.envios.sort((a, b) => a.em - b.em);
    this.#gravarJeito(j);
  }

  /** Mensagem minha apagada para todos: as edições ligadas a ela saem (e a proposta que ficar com menos de duas). */
  #jeitoDaMensagem(jid: string, id: string): void {
    const atual = this.#jeito();
    if (!atual.edicoes.some((e) => e.conversa === jid && e.mensagem_id === id)) return;
    const j = structuredClone(atual);
    j.edicoes = j.edicoes.filter((e) => !(e.conversa === jid && e.mensagem_id === id));
    Banco.#podarPropostas(j);
    this.#gravarJeito(j);
  }

  grupoPermitido(jid: string): boolean {
    return this.#listas().grupos.has(jid);
  }
  estaBloqueado(jid: string): boolean {
    return this.#listas().bloqueados.has(normalizar(jid));
  }
  bloqueados(): string[] {
    return [...this.config().bloqueados];
  }
  gruposPermitidos(): string[] {
    return [...this.config().grupos_permitidos];
  }

  permitirGrupo(jid: string): boolean {
    if (!ehGrupo(jid)) throw new ErroDeBanco("Isso não é um grupo.");
    return this.#mudar(() => {
      const c = structuredClone(this.config());
      if (c.grupos_permitidos.includes(jid)) return false;
      c.grupos_permitidos.push(jid);
      this.#gravarConfig(c);
      return true;
    });
  }

  /** Tira da lista e apaga as mensagens do grupo. Devolve quantas mensagens foram apagadas (-1 se o grupo não estava na lista). */
  removerGrupo(jid: string): number {
    return this.#mudar(() => {
      const c = structuredClone(this.config());
      if (!c.grupos_permitidos.includes(jid)) return -1;
      c.grupos_permitidos = c.grupos_permitidos.filter((g) => g !== jid);
      this.#gravarConfig(c);
      const ind = this.#indiceParaMudar();
      if (ind.nomes[jid]) {
        delete ind.nomes[jid];
        this.#gravarIndice(ind);
      }
      return this.apagarConversa(jid);
    });
  }

  /** Todas as formas conhecidas do jid de uma pessoa (número e LID). */
  aliasesDe(jidBruto: string): string[] {
    const jid = normalizar(jidBruto);
    const todos = new Set([jid]);
    for (const [lid, pn] of Object.entries(this.#indice().lid_para_pn)) {
      if (lid === jid || pn === jid) {
        todos.add(lid);
        todos.add(pn);
      }
    }
    return [...todos];
  }

  /**
   * Põe na lista "nunca ler" (com os apelidos conhecidos e os `extras`, ex.: o LID pedido à Baileys) e apaga o que
   * estava gravado. Devolve quantas mensagens foram apagadas.
   */
  bloquear(jidBruto: string, extras: readonly string[] = []): number {
    const jid = normalizar(jidBruto);
    if (!ehIndividual(jid)) throw new ErroDeBanco("Só conversa individual entra na lista \"nunca ler\"; para grupo, use wa_escolher_grupos.");
    return this.#mudar(() => {
      const aliases = new Set([...this.aliasesDe(jid), ...extras.map(normalizar).filter((e) => ehIndividual(e))]);
      const c = structuredClone(this.config());
      for (const a of aliases) if (!c.bloqueados.includes(a)) c.bloqueados.push(a);
      this.#gravarConfig(c);
      let apagadas = 0;
      for (const a of aliases) apagadas += this.apagarConversa(a);
      const ind = this.#indiceParaMudar();
      let mudou = false;
      // O LID que veio de fora (pedido à Baileys) passa a constar no mapa, para a lista mostrar uma pessoa só.
      if (numeroDe(jid)) {
        for (const a of aliases) {
          if (ehLid(a) && ind.lid_para_pn[a] !== jid) {
            ind.lid_para_pn[a] = jid;
            mudou = true;
          }
        }
      }
      for (const a of aliases) {
        if (ind.nomes[a]) {
          delete ind.nomes[a];
          mudou = true;
        }
      }
      if (mudou) this.#gravarIndice(ind);
      return apagadas;
    });
  }

  liberar(jidBruto: string): boolean {
    const jid = normalizar(jidBruto);
    return this.#mudar(() => {
      const c = structuredClone(this.config());
      const aliases = new Set(this.aliasesDe(jid));
      const restantes = c.bloqueados.filter((b) => !aliases.has(b));
      if (restantes.length === c.bloqueados.length) return false;
      c.bloqueados = restantes;
      this.#gravarConfig(c);
      return true;
    });
  }

  // ---------- cache dos grupos ----------

  cacheDeGrupos(): CacheDeGrupos | null {
    return this.#ler<CacheDeGrupos | null>("grupos.enc", "grupos", () => null);
  }
  guardarCacheDeGrupos(c: CacheDeGrupos): void {
    this.#mudar(() => this.#gravar("grupos.enc", "grupos", c));
  }

  /** O cache existe e tem menos de 1 h? */
  cacheDeGruposFresco(agora: number): boolean {
    const c = this.cacheDeGrupos();
    return c !== null && agora - c.em < VALIDADE_DO_CACHE_DE_GRUPOS_MS;
  }

  /** Guarda os metadados buscados no WhatsApp e atualiza o nome dos grupos escolhidos. */
  guardarGrupos(grupos: Record<string, MetaDeGrupo>, em: number): CacheDeGrupos {
    const cache = { em, grupos };
    this.guardarCacheDeGrupos(cache);
    for (const [jid, g] of Object.entries(grupos)) if (g.nome && this.grupoPermitido(jid)) this.definirNome(jid, g.nome, PRIORIDADE.contato);
    return cache;
  }

  // ---------- mensagens ----------

  #arquivoDe(jid: string): string {
    return unir(this.dir, "conversas", `${nomeDoArquivo(this.#chave, `conversa:${jid}`)}.jsonl`);
  }

  /**
   * 0.8.0: o carimbo barato do arquivo da conversa (inode, mtime e tamanho; "ausente" sem arquivo), para o índice de
   * busca (busca.ts) saber se precisa ler de novo. Não diz o nome do arquivo nem nada do conteúdo.
   */
  marcaDaConversa(jid: string): string {
    return marcaDoArquivo(this.#arquivoDe(jid));
  }

  lerMensagens(jid: string): MensagemGuardada[] {
    const bruto = lerOuNulo(this.#arquivoDe(jid));
    if (bruto === null) return [];
    const saida: MensagemGuardada[] = [];
    for (const linha of bruto.split("\n")) {
      if (linha === "") continue;
      try {
        saida.push(JSON.parse(abrir(this.#chave, `msg:${jid}`, linha)) as MensagemGuardada);
      } catch {
        this.linhasIlegiveis++;
      }
    }
    return saida;
  }

  /**
   * Junta, tira repetidas (por id), ordena por data e guarda só as últimas `max`. Devolve quantas são novas.
   * Recusa (devolve 0) conversa que não pode ser gravada (ver `aceitaGravar`).
   */
  gravarMensagens(jidBruto: string, novas: readonly MensagemGuardada[], opcoes: OpcoesGravacao = {}): number {
    if (novas.length === 0) return 0;
    return this.gravarEmSequencia(jidBruto, [{ novas, opcoes }])[0]!;
  }

  /**
   * 0.9.2: o mesmo que chamar `gravarMensagens` uma vez para cada passo, na ordem, mas gravando o arquivo da conversa e
   * o índice UMA vez no fim. Cada passo vê o resultado do anterior (em memória), com a mesma lógica: o resultado é
   * idêntico ao de uma por uma (mensagens, ordem, não lidas, `aguardando_desde`, última do índice). Por quê: com o teto
   * de 5.000, regravar o arquivo inteiro a cada mensagem de um lote ao vivo custava segundos. Devolve quantas novas em
   * cada passo.
   */
  gravarEmSequencia(jidBruto: string, passos: ReadonlyArray<{ novas: readonly MensagemGuardada[]; opcoes?: OpcoesGravacao }>): number[] {
    return this.#gravarPassos(jidBruto, passos).aceitas;
  }

  /**
   * 0.11.0: `gravarMensagens` que diz também quantas das novas FICARAM depois do teto (as mais antigas que as guardadas
   * podem ser cortadas na hora). O wa_buscar_historico decifrava o arquivo três vezes (antes, na gravação e depois)
   * para saber isso; aqui é uma leitura só, com o mesmo resultado.
   */
  gravarMensagensContando(jidBruto: string, novas: readonly MensagemGuardada[], opcoes: OpcoesGravacao = {}): { aceitas: number; ficaram: number } {
    if (novas.length === 0) return { aceitas: 0, ficaram: 0 };
    const r = this.#gravarPassos(jidBruto, [{ novas, opcoes }]);
    return { aceitas: r.aceitas[0]!, ficaram: r.ficaram };
  }

  #gravarPassos(jidBruto: string, passos: ReadonlyArray<{ novas: readonly MensagemGuardada[]; opcoes?: OpcoesGravacao }>): { aceitas: number[]; ficaram: number } {
    const jid = normalizar(jidBruto);
    if (passos.every((p) => p.novas.length === 0)) return { aceitas: passos.map(() => 0), ficaram: 0 };
    return this.#mudar(() => {
      if (!this.aceitaGravar(jid)) return { aceitas: passos.map(() => 0), ficaram: 0 };
      let atuais = this.lerMensagens(jid);
      const ind = this.#indiceParaMudar();
      let mudou = false;
      const entraram = new Set<string>();
      const aceitasPorPasso = passos.map((p) => {
        const r = this.#aplicarNovas(jid, atuais, ind, p.novas, p.opcoes ?? {});
        if (r.aceitas.length === 0) return 0;
        for (const m of r.aceitas) entraram.add(m.id);
        atuais = r.guardadas;
        mudou = true;
        return r.aceitas.length;
      });
      if (mudou) {
        gravarAtomico(this.#arquivoDe(jid), atuais.map((m) => selar(this.#chave, `msg:${jid}`, JSON.stringify(m))).join("\n") + "\n");
        this.#gravarIndice(ind);
      }
      return { aceitas: aceitasPorPasso, ficaram: entraram.size === 0 ? 0 : atuais.filter((m) => entraram.has(m.id)).length };
    });
  }

  /** Um passo de `gravarEmSequencia`, sem disco: muda `ind` e devolve as mensagens guardadas e quantas eram novas. */
  #aplicarNovas(jid: string, atuais: MensagemGuardada[], ind: Indice, novas: readonly MensagemGuardada[], opcoes: OpcoesGravacao): { guardadas: MensagemGuardada[]; aceitas: MensagemGuardada[] } {
    const ids = new Set(atuais.map((m) => m.id));
    const aceitas: MensagemGuardada[] = [];
    for (const m of novas) {
      if (ids.has(m.id)) continue;
      ids.add(m.id);
      aceitas.push(m);
    }
    if (aceitas.length === 0) return { guardadas: atuais, aceitas: [] };
    const todas = [...atuais, ...aceitas].map((m, i) => ({ m, i })).sort((a, b) => a.m.ts - b.m.ts || a.i - b.i).map((x) => x.m);
    const guardadas = todas.slice(-this.#max);

    const ultima = guardadas[guardadas.length - 1]!;
    const anterior = ind.conversas[jid];
    const grupo = ehGrupo(jid);
    const numero = grupo ? undefined : numeroDe(jid);
    const nomeConhecido: { nome: string; prioridade: number; origem_do_nome?: OrigemDoNome } | undefined =
      anterior?.nome !== undefined
        ? { nome: anterior.nome, prioridade: anterior.prioridade_nome, ...(anterior.origem_do_nome ? { origem_do_nome: anterior.origem_do_nome } : {}) }
        : ind.nomes[jid];
    const recebidasAgora = aceitas.filter((m) => !m.de_mim).length;
    const entrada: EntradaIndice = {
      jid,
      grupo,
      ...(numero ? { numero } : {}),
      ...(nomeConhecido ? { nome: nomeConhecido.nome } : {}),
      prioridade_nome: nomeConhecido?.prioridade ?? 0,
      ...(nomeConhecido?.origem_do_nome ? { origem_do_nome: nomeConhecido.origem_do_nome } : {}),
      ultima_ts: ultima.ts,
      ultima_de_mim: ultima.de_mim,
      ultima_texto: descricaoCurta(ultima),
      nao_lidas: opcoes.contarNaoLidas ? (anterior?.nao_lidas ?? 0) + recebidasAgora : (anterior?.nao_lidas ?? 0),
      total: guardadas.length,
    };
    const desde = aguardandoDesde(guardadas);
    if (desde !== undefined) entrada.aguardando_desde = desde;
    // Mensagem minha que chega ao vivo (escrita no celular) quer dizer que o dono viu a conversa:
    // só contam como não lidas as recebidas depois dela.
    const minhasNovas = aceitas.filter((m) => m.de_mim).map((m) => m.ts);
    if (opcoes.contarNaoLidas && minhasNovas.length > 0) {
      const corte = Math.max(...minhasNovas);
      entrada.nao_lidas = guardadas.filter((m) => !m.de_mim && m.ts > corte).length;
    }
    ind.conversas[jid] = entrada;
    const recebidas = aceitas.filter((m) => !m.de_mim).map((m) => m.ts);
    if (recebidas.length > 0) ind.ultima_recebida_ts = Math.max(ind.ultima_recebida_ts ?? 0, ...recebidas);
    return { guardadas, aceitas };
  }

  /**
   * Regrava as mensagens de uma conversa (depois de apagar ou editar uma) e refaz o resumo dela no índice.
   * Sem mensagem nenhuma, a conversa sai do índice. As não lidas nunca passam do que sobrou de recebidas.
   */
  #regravar(jid: string, guardadas: readonly MensagemGuardada[]): void {
    if (guardadas.length === 0) {
      this.apagarConversa(jid);
      return;
    }
    gravarAtomico(this.#arquivoDe(jid), guardadas.map((m) => selar(this.#chave, `msg:${jid}`, JSON.stringify(m))).join("\n") + "\n");
    const ind = this.#indiceParaMudar();
    const e = ind.conversas[jid];
    if (!e) return;
    const ultima = guardadas[guardadas.length - 1]!;
    e.ultima_ts = ultima.ts;
    e.ultima_de_mim = ultima.de_mim;
    e.ultima_texto = descricaoCurta(ultima);
    e.total = guardadas.length;
    e.nao_lidas = Math.min(e.nao_lidas, guardadas.filter((m) => !m.de_mim).length);
    const desde = aguardandoDesde(guardadas);
    if (desde === undefined) delete e.aguardando_desde;
    else e.aguardando_desde = desde;
    this.#gravarIndice(ind);
  }

  /** A mensagem guardada é de quem está apagando ou editando? Em grupo, o número também tem de bater (quando se sabe). */
  static #mesmoAutor(m: MensagemGuardada, autor: { de_mim: boolean; numero?: string }): boolean {
    if (m.de_mim !== autor.de_mim) return false;
    if (m.de_mim) return true;
    const guardado = m.remetente?.numero;
    return guardado === undefined || autor.numero === undefined || guardado === autor.numero;
  }

  /** Apagada para todos por quem escreveu: a linha sai do banco. Devolve se apagou. */
  apagarMensagem(jidBruto: string, id: string, autor: { de_mim: boolean; numero?: string }): boolean {
    const jid = normalizar(jidBruto);
    return this.#mudar(() => {
      const atuais = this.lerMensagens(jid);
      const alvo = atuais.find((m) => m.id === id);
      if (!alvo || !Banco.#mesmoAutor(alvo, autor)) return false;
      this.#memoriaDaMensagem(jid, alvo, true);
      // 0.12.0: o par rascunho/enviado de uma mensagem que o dono apagou para todos sai junto.
      if (alvo.de_mim) this.#jeitoDaMensagem(jid, alvo.id);
      this.#regravar(jid, atuais.filter((m) => m !== alvo));
      return true;
    });
  }

  /** Editada por quem escreveu: o texto guardado vira o novo, com a marca `editada`. Devolve se mudou. */
  editarMensagem(jidBruto: string, id: string, texto: string, autor: { de_mim: boolean; numero?: string }): boolean {
    const jid = normalizar(jidBruto);
    return this.#mudar(() => {
      const atuais = this.lerMensagens(jid);
      const alvo = atuais.find((m) => m.id === id);
      if (!alvo || !Banco.#mesmoAutor(alvo, autor)) return false;
      this.#memoriaDaMensagem(jid, alvo, false);
      this.#regravar(jid, atuais.map((m) => (m === alvo ? { ...m, texto, editada: true } : m)));
      return true;
    });
  }

  /** Guarda a transcrição de um áudio guardado (0.7.0, parte 3). Devolve se achou a mensagem. */
  gravarTranscricao(jidBruto: string, id: string, transcricao: { texto: string; idioma: string; em: number }): boolean {
    const jid = normalizar(jidBruto);
    return this.#mudar(() => {
      const atuais = this.lerMensagens(jid);
      const alvo = atuais.find((m) => m.id === id);
      if (!alvo || !this.aceitaGravar(jid)) return false;
      this.#regravar(jid, atuais.map((m) => (m === alvo ? { ...m, transcricao } : m)));
      return true;
    });
  }

  /**
   * Nome só substitui um de prioridade menor ou igual (ver PRIORIDADE). Guarda também nome de contato ou grupo ainda sem
   * conversa. 0.15.0: guarda a origem (conversa individual) e devolve o que aconteceu (ver `definirNomes`).
   */
  definirNome(jidBruto: string, nome: string | null | undefined, prioridade: number, origem?: OrigemDoNome): ResultadoDoNome {
    return this.definirNomes([{ jid: jidBruto, nome, prioridade, ...(origem ? { origem } : {}) }])[0]!;
  }

  /**
   * 0.15.0: vários nomes numa gravação só do índice. As regras de sempre, um por um:
   * lista "nunca ler" e conversa que não pode ser gravada recusam; o nome só troca outro de prioridade menor ou igual.
   * Mais: o "nome" que é só um número (`nomeEhNumero`) entra com prioridade 0 e sem origem (qualquer nome de verdade o
   * troca), e o mesmo nome vindo de uma origem melhor sobe a prioridade e a origem (antes ficava a pior, e um nome público
   * diferente podia trocar o da agenda depois). O resultado de cada um vale pela conversa guardada; sem ela, pelo nome
   * guardado antes da primeira mensagem.
   */
  definirNomes(itens: readonly NomeParaGravar[]): ResultadoDoNome[] {
    const preparados = itens.map((it) => this.#prepararNome(it, (jid) => this.aceitaGravar(jid)));
    if (preparados.every((p) => p === undefined)) return itens.map(() => "recusado");
    return this.#mudar(() => {
      const ind = this.#indiceParaMudar();
      let mudou = false;
      const resultados = preparados.map((p): ResultadoDoNome => {
        if (!p) return "recusado";
        const r = this.#aplicarNome(ind, p);
        mudou ||= r.mudou;
        return r.resultado;
      });
      if (mudou) this.#gravarIndice(ind);
      return resultados;
    });
  }

  /** O nome limpo e a prioridade que vale (número no lugar do nome: 0 e sem origem), ou undefined se não grava. */
  #prepararNome(it: NomeParaGravar, aceita: (jid: string) => boolean): NomePreparado | undefined {
    const jid = normalizar(it.jid);
    const limpo = it.nome?.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 100);
    if (!limpo || !aceita(jid)) return undefined;
    const numero = nomeEhNumero(limpo);
    return { jid, limpo, prioridade: numero ? 0 : it.prioridade, origem: numero || ehGrupo(jid) ? undefined : it.origem };
  }

  /** Um nome aplicado ao índice em memória (sem disco), com as regras do `definirNomes`. */
  #aplicarNome(ind: Indice, p: NomePreparado): { resultado: ResultadoDoNome; mudou: boolean } {
    const { jid, limpo, prioridade, origem } = p;
    let mudou = false;
    const comOrigem = <T extends { origem_do_nome?: OrigemDoNome }>(alvo: T, o: OrigemDoNome | undefined): void => {
      if (o) alvo.origem_do_nome = o;
      else delete alvo.origem_do_nome;
    };
    let resultado: ResultadoDoNome | undefined;
    const e = ind.conversas[jid];
    if (e) {
      // Um número guardado como nome (antes da 0.15.0, com a prioridade de quem mandou) vale como nenhum nome.
      const atual = nomeEhNumero(e.nome) ? 0 : e.prioridade_nome;
      if (prioridade >= atual && e.nome !== limpo) {
        resultado = e.nome === undefined || nomeEhNumero(e.nome) ? "novo" : "atualizado";
        e.nome = limpo;
        e.prioridade_nome = prioridade;
        comOrigem(e, origem);
        mudou = true;
      } else if (e.nome === limpo) {
        if (prioridade > atual || (prioridade === atual && origem !== undefined && e.origem_do_nome !== origem)) {
          e.prioridade_nome = prioridade;
          comOrigem(e, origem);
          mudou = true;
        }
        resultado = "igual";
      } else resultado = "pior";
    }
    // Contato individual ou grupo da lista: o nome fica guardado mesmo antes da primeira mensagem.
    const n = ind.nomes[jid];
    const atualN = n && nomeEhNumero(n.nome) ? 0 : (n?.prioridade ?? 0);
    if ((!n || prioridade >= atualN) && n?.nome !== limpo && (n || Object.keys(ind.nomes).length < MAXIMO_DE_NOMES)) {
      resultado ??= n === undefined || nomeEhNumero(n.nome) ? "novo" : "atualizado";
      ind.nomes[jid] = { nome: limpo, prioridade, ...(origem ? { origem_do_nome: origem } : {}) };
      mudou = true;
    } else if (n && n.nome === limpo) {
      if (prioridade > atualN || (prioridade === atualN && origem !== undefined && n.origem_do_nome !== origem)) {
        n.prioridade = prioridade;
        comOrigem(n, origem);
        mudou = true;
      }
      resultado ??= "igual";
    } else resultado ??= n ? "pior" : "recusado";
    return { resultado, mudou };
  }

  /**
   * 0.15.2: muitos contatos de uma vez (a agenda do celular, o histórico do pareamento, os `lid-mapping.update` em
   * rajada), com o MESMO resultado de aplicar um por um, na ordem: para cada um, `mapearLid(lid, pn)` se vier o par, e
   * depois, se a chave (o número, ou o LID) pode ser gravada, `definirNome`. Antes, cada contato decifrava, clonava,
   * cifrava e regravava o índice inteiro (4.000 contatos: dezenas de segundos sem ceder ao laço). Aqui o índice é clonado
   * uma vez e gravado uma vez por chamada. O par simples (sem conversa, marca ou aprendizado sob o LID, e nem o LID nem o
   * número na lista "nunca ler", direta ou pelo mapa) muda só o índice em memória, e não muda as listas derivadas (quem
   * não estava bloqueado continua não estando). O par complicado grava o que já foi aplicado, passa pelo `mapearLid` de
   * sempre (bloqueio, conversa, memória e marca que mudam de lugar) e o lote segue do índice que ele deixou.
   * Cada par complicado move conversa e regrava arquivos (uns 10 ms): depois de `complicadosPorVez` deles, para e diz
   * quantos contatos aplicou (`aplicados`), para quem chama ceder ao laço e seguir do próximo.
   * Devolve, por contato aplicado, o resultado do nome (undefined: sem nome ou chave recusada).
   */
  aplicarContatos(itens: readonly ContatoParaAplicar[], complicadosPorVez = Number.POSITIVE_INFINITY): { resultados: Array<ResultadoDoNome | undefined>; aplicados: number } {
    if (itens.length === 0) return { resultados: [], aplicados: 0 };
    return this.#mudar(() => {
      let ind = this.#indiceParaMudar();
      let listas = this.#listas();
      let bloqueadosDaConfig = new Set(this.config().bloqueados);
      let marcas = this.#marcas();
      let sujo = false;
      const descarregar = () => {
        if (sujo) this.#gravarIndice(ind);
        sujo = false;
      };
      // O `aceitaGravar` contra o índice em memória (as listas derivadas não mudam com os pares simples).
      const aceita = (jid: string): boolean => {
        if (ehSempreIgnorado(jid)) return false;
        if (ehGrupo(jid)) return listas.grupos.has(jid);
        if (!ehIndividual(jid)) return false;
        if (listas.bloqueados.has(jid)) return false;
        if (ehLid(jid) && listas.bloqueioSemLid && ind.lid_para_pn[jid] === undefined) return false;
        return true;
      };
      let complicados = 0;
      const resultados: Array<ResultadoDoNome | undefined> = [];
      const aplicar = (it: ContatoParaAplicar): ResultadoDoNome | undefined => {
        const lid = it.lid !== undefined ? normalizar(it.lid) : undefined;
        const pn = it.pn !== undefined ? normalizar(it.pn) : undefined;
        if (lid && pn && ehLid(lid) && numeroDe(pn)) {
          const jaEsta = ind.lid_para_pn[lid] === pn && !ind.conversas[lid] && marcas[lid] === undefined && !this.#temJeito(lid);
          if (!jaEsta) {
            const simples =
              !ind.conversas[lid] &&
              marcas[lid] === undefined &&
              !this.#temJeito(lid) &&
              !bloqueadosDaConfig.has(lid) &&
              !bloqueadosDaConfig.has(pn) &&
              !listas.bloqueados.has(lid) &&
              !listas.bloqueados.has(pn);
            if (simples) {
              // O mesmo que o `mapearLid` faz no índice: o par entra e o nome guardado do LID vai para o número.
              ind.lid_para_pn[lid] = pn;
              const n = ind.nomes[lid];
              if (n) {
                if (!ind.nomes[pn] || ind.nomes[pn]!.prioridade <= n.prioridade) ind.nomes[pn] = n;
                delete ind.nomes[lid];
              }
              sujo = true;
            } else {
              descarregar();
              complicados++;
              this.mapearLid(lid, pn);
              ind = this.#indiceParaMudar();
              listas = this.#listas();
              bloqueadosDaConfig = new Set(this.config().bloqueados);
              marcas = this.#marcas();
            }
          }
        }
        // Como o transporte fazia: a chave é o número (ou o LID), e só ganha nome se pode ser gravada.
        const chave = pn ?? lid;
        if (!chave || !aceita(chave) || it.nome === undefined) return undefined;
        const p = this.#prepararNome({ jid: chave, nome: it.nome, prioridade: it.prioridade, ...(it.origem ? { origem: it.origem } : {}) }, aceita);
        if (!p) return "recusado";
        const r = this.#aplicarNome(ind, p);
        if (r.mudou) sujo = true;
        return r.resultado;
      };
      for (const it of itens) {
        resultados.push(aplicar(it));
        if (complicados >= complicadosPorVez) break;
      }
      descarregar();
      return { resultados, aplicados: resultados.length };
    });
  }

  /** 0.15.0: as conversas individuais guardadas sem nome de verdade (sem nome, ou só um número no lugar do nome). */
  conversasIndividuaisSemNome(): Set<string> {
    return new Set(Object.values(this.#indice().conversas).filter((c) => !c.grupo && (!c.nome || nomeEhNumero(c.nome))).map((c) => c.jid));
  }

  /** 0.15.0: contagem dos nomes das conversas individuais guardadas (wa_estado). */
  contagemDosContatos(): { com_nome: number; sem_nome: number; por_origem: Record<OrigemDoNome, number> } {
    const por_origem = Object.fromEntries(ORIGENS_DO_NOME.map((o) => [o, 0])) as Record<OrigemDoNome, number>;
    let com = 0;
    let sem = 0;
    for (const c of Object.values(this.#indice().conversas)) {
      if (c.grupo) continue;
      const origem = origemDoNome(c);
      if (!origem) {
        sem++;
        continue;
      }
      com++;
      por_origem[origem]++;
    }
    return { com_nome: com, sem_nome: sem, por_origem };
  }

  definirNaoLidas(jidBruto: string, n: number): void {
    const jid = normalizar(jidBruto);
    if (!Number.isFinite(n)) return;
    this.#mudar(() => {
      const ind = this.#indiceParaMudar();
      const e = ind.conversas[jid];
      const valor = Math.max(0, Math.floor(n));
      if (!e || e.nao_lidas === valor) return;
      e.nao_lidas = valor;
      this.#gravarIndice(ind);
    });
  }

  /**
   * Guarda que o LID é o mesmo contato que o número. Se um dos dois está na lista "nunca ler", o outro entra também
   * (e o que estava gravado sai). Se havia conversa guardada sob o LID, ela passa para o número.
   */
  mapearLid(lidBruto: string, pnBruto: string): void {
    const lid = normalizar(lidBruto);
    const pn = normalizar(pnBruto);
    if (!ehLid(lid) || !numeroDe(pn)) return;
    const ind0 = this.#indice();
    if (ind0.lid_para_pn[lid] === pn && !ind0.conversas[lid] && this.#marcas()[lid] === undefined && !this.#temJeito(lid)) return;
    this.#mudar(() => {
      const ind = this.#indiceParaMudar();
      ind.lid_para_pn[lid] = pn;
      if (ind.nomes[lid]) {
        const n = ind.nomes[lid]!;
        if (!ind.nomes[pn] || ind.nomes[pn]!.prioridade <= n.prioridade) ind.nomes[pn] = n;
        delete ind.nomes[lid];
      }
      this.#gravarIndice(ind);
      const c = this.config();
      if (c.bloqueados.includes(lid) || c.bloqueados.includes(pn)) {
        this.bloquear(pn, [lid]);
        return;
      }
      // 0.11.0: a marca do resumo acompanha o mapeamento, como a memória: o número sem marca herda a do LID; com as duas,
      // vale a mais adiantada (o que já foi lido por uma das formas não volta a contar como novo).
      this.#moverMarca(lid, pn);
      // 0.12.0: o aprendizado também (tipo, regras da conversa, edições), antes de a conversa do LID ser apagada.
      this.#juntarJeito(pn, this.#tirarJeito(lid));
      const doLid = ind.conversas[lid];
      if (!doLid) return;
      const mensagens = this.lerMensagens(lid);
      // 0.10.0: a memória do LID acompanha a conversa.
      const memoria = this.#tirarMemoria(lid);
      this.apagarConversa(lid);
      this.gravarMensagens(pn, mensagens);
      this.#juntarMemoria(pn, memoria);
      const ind2 = this.#indiceParaMudar();
      const e = ind2.conversas[pn];
      if (e) {
        e.nao_lidas += doLid.nao_lidas;
        if (doLid.nome && doLid.prioridade_nome >= e.prioridade_nome) {
          e.nome = doLid.nome;
          e.prioridade_nome = doLid.prioridade_nome;
          // 0.15.0: a origem do nome vai junto.
          if (doLid.origem_do_nome) e.origem_do_nome = doLid.origem_do_nome;
          else delete e.origem_do_nome;
        }
        this.#gravarIndice(ind2);
      }
    });
  }

  /** A marca do resumo do LID vai para o número (vence a maior). Sem marca no LID, nada muda. */
  #moverMarca(lid: string, pn: string): void {
    const m = this.#marcas();
    const doLid = m[lid];
    if (doLid === undefined) return;
    const c = structuredClone(m);
    c[pn] = Math.max(c[pn] ?? Number.NEGATIVE_INFINITY, doLid);
    delete c[lid];
    this.#gravar("marcas.enc", "marcas", c);
  }

  /**
   * 0.11.0: vários pares LID -> número de uma vez (os participantes dos grupos escolhidos). O par que já está no mapa não
   * custa nada; os novos simples (sem conversa, nome ou marca sob o LID, e ninguém na lista "nunca ler") entram numa
   * gravação só do índice; o resto passa pelo `mapearLid`, um por um, com as mesmas regras (lista "nunca ler", conversa
   * e memória que mudam de lugar). Devolve quantos pares eram novos.
   */
  mapearLids(pares: ReadonlyArray<{ lid: string; pn: string }>): number {
    const normalizados = pares
      .map((p) => ({ lid: normalizar(p.lid), pn: normalizar(p.pn) }))
      .filter((p) => ehLid(p.lid) && numeroDe(p.pn) !== undefined);
    const ind0 = this.#indice();
    const marcas0 = this.#marcas();
    const novos = normalizados.filter((p) => ind0.lid_para_pn[p.lid] !== p.pn || ind0.conversas[p.lid] !== undefined || marcas0[p.lid] !== undefined || this.#temJeito(p.lid));
    if (novos.length === 0) return 0;
    this.#mudar(() => {
      const c = this.config();
      const bloqueados = new Set(c.bloqueados);
      const ind = this.#indiceParaMudar();
      const marcas = this.#marcas();
      const complicados: Array<{ lid: string; pn: string }> = [];
      let mudou = false;
      for (const p of novos) {
        const simples = !ind.conversas[p.lid] && !ind.nomes[p.lid] && marcas[p.lid] === undefined && !this.#temJeito(p.lid) && !bloqueados.has(p.lid) && !bloqueados.has(p.pn);
        if (!simples) complicados.push(p);
        else if (ind.lid_para_pn[p.lid] !== p.pn) {
          ind.lid_para_pn[p.lid] = p.pn;
          mudou = true;
        }
      }
      if (mudou) this.#gravarIndice(ind);
      for (const p of complicados) this.mapearLid(p.lid, p.pn);
    });
    return novos.length;
  }

  /**
   * 0.11.0: quem escreveu uma mensagem de grupo, como o modelo pode ver: o nome público, o número (o guardado, ou o do
   * mapa LID -> número, que pode ter aprendido depois da gravação) e um rótulo estável por conversa (`p_` + 8 hex do
   * HMAC com a chave do banco), para distinguir e contar pessoas sem ver número nem LID. O rótulo vem do número quando
   * ele é conhecido e, senão, do jid como veio (o LID); então a mesma pessoa tem o mesmo rótulo em toda a resposta.
   * undefined para mensagem minha ou de conversa individual.
   */
  quemEscreveu(conversa: string, m: { de_mim: boolean; remetente?: { nome?: string; numero?: string }; participante?: string }): { nome?: string; numero?: string; participante?: string } | undefined {
    if (m.de_mim || (!m.remetente && !m.participante)) return undefined;
    const p = m.participante ? normalizar(m.participante) : undefined;
    const numero = m.remetente?.numero ?? (p ? (numeroDe(p) ?? numeroDe(this.numeroDoLid(p))) : undefined);
    const base = numero ? `${numero}@s.whatsapp.net` : p;
    const rotulo = base ? `p_${createHmac("sha256", this.#chave).update(`participante:${normalizar(conversa)}:${base}`).digest("hex").slice(0, 8)}` : undefined;
    return {
      ...(m.remetente?.nome ? { nome: m.remetente.nome } : {}),
      ...(numero ? { numero } : {}),
      ...(rotulo ? { participante: rotulo } : {}),
    };
  }

  /** Põe sob `jid` a memória tirada de outra forma da mesma conversa; o que já existe sob `jid` vence no empate. */
  #juntarMemoria(jid: string, tirada: { resumo?: ResumoDaConversa; compromissos: Compromisso[] }): void {
    if (!tirada.resumo && tirada.compromissos.length === 0) return;
    const m = structuredClone(this.#memoria());
    if (tirada.resumo && !m.resumos[jid]) m.resumos[jid] = tirada.resumo;
    for (const c of tirada.compromissos) {
      if (m.compromissos.some((x) => x.conversa === jid && x.mensagem_id === c.mensagem_id && x.quem_deve === c.quem_deve)) continue;
      m.compromissos.push({ ...c, conversa: jid });
    }
    this.#gravarMemoria(m);
  }

  /** O número de um LID, se conhecido. */
  numeroDoLid(lid: string): string | undefined {
    return this.#indice().lid_para_pn[normalizar(lid)];
  }

  /** 0.7.2: o LID de um número, se conhecido (busca inversa no mapa; usado nas variações do pedido de histórico). */
  lidDoNumero(pnBruto: string): string | undefined {
    const pn = normalizar(pnBruto);
    for (const [lid, numero] of Object.entries(this.#indice().lid_para_pn)) if (numero === pn) return lid;
    return undefined;
  }

  /** O jid sob o qual a conversa é guardada: número quando o LID é conhecido, senão o próprio. */
  chaveDaConversa(jidBruto: string): string {
    const jid = normalizar(jidBruto);
    return this.#indice().lid_para_pn[jid] ?? jid;
  }

  /** Apaga as mensagens e a entrada do índice. Devolve quantas mensagens havia. */
  apagarConversa(jidBruto: string): number {
    const jid = normalizar(jidBruto);
    return this.#mudar(() => {
      const n = this.lerMensagens(jid).length;
      apagarArquivo(this.#arquivoDe(jid));
      this.#apagarMarca(jid);
      this.#tirarMemoria(jid);
      // 0.12.0: apagar a conversa apaga o que se aprendeu dela.
      this.#tirarJeito(jid);
      const ind = this.#indiceParaMudar();
      if (ind.conversas[jid]) {
        delete ind.conversas[jid];
        this.#gravarIndice(ind);
      }
      this.#avisarQueApagou();
      return n;
    });
  }

  /**
   * Apaga conversas, índice, listas, cache, marcas, memória e aprendizado. A contagem de envios do dia (envios.enc) fica: ver o topo.
   * Se a chave mudou (o item do cofre sumiu) e a contagem não abre mais, ela é trocada por "limite atingido hoje"
   * (na dúvida, conta; volta amanhã). Sem isso, o arquivo ilegível travaria o wa_estado e o wa_responder para sempre.
   */
  apagarTudo(): void {
    // Apaga tudo o que conseguir (um arquivo que falha não impede os outros) e só depois diz o que ficou.
    const falhas: string[] = [];
    const tentar = (nome: string, f: () => void) => {
      try {
        f();
      } catch {
        falhas.push(nome);
      }
    };
    this.#mudar(() => {
      tentar("conversas", () => apagarPasta(unir(this.dir, "conversas")));
      for (const f of ["indice.enc", "config.enc", "grupos.enc", "marcas.enc", "memoria.enc", "jeito.enc"]) tentar(f, () => apagarArquivo(unir(this.dir, f)));
      // Temporários de uma gravação interrompida (pasta.ts, gravarAtomico): também levam dado cifrado.
      for (const f of listar(this.dir)) if (f.endsWith(".tmp")) tentar(f, () => apagarArquivo(unir(this.dir, f)));
      tentar("envios.enc", () => {
        try {
          this.enviosDoDia(Date.now());
        } catch (erro) {
          if (!(erro instanceof ErroDeBanco)) throw erro;
          this.#gravar("envios.enc", "envios", {
            dia: diaLocal(Date.now()),
            quantidade: LIMITE_DIARIO_MAXIMO,
            novas: LIMITE_NOVAS_CONVERSAS_MAXIMO,
            reacoes: LIMITE_DIARIO_MAXIMO,
            // 0.13.0: o limite é configurável; o teto do campo cobre qualquer valor.
            historico: PEDIDOS_DE_HISTORICO_MAXIMO,
            aberturas: ABERTURAS_POR_DIA,
            contatos: ATUALIZACOES_DE_CONTATOS_POR_DIA,
          } satisfies Envios);
        }
      });
      tentar("conversas", () => garantirPasta(unir(this.dir, "conversas")));
      this.#cache.clear();
      this.#derivado = null;
    });
    // Mesmo se algo falhou: o que estava em memória sai de qualquer jeito.
    this.#avisarQueApagou();
    if (falhas.length > 0) throw new ErroDeBanco(`Não consegui apagar tudo deste computador (ficou: ${[...new Set(falhas)].join(", ")}). Feche o Claude Desktop e tente de novo.`);
  }

  /** O banco abre com a chave atual? false se a chave se perdeu ou um arquivo foi alterado (ErroDeBanco). */
  legivel(): boolean {
    try {
      this.estatisticas();
      this.envioLigado();
      return true;
    } catch (erro) {
      if (erro instanceof ErroDeBanco) return false;
      throw erro;
    }
  }

  // ---------- ids públicos (o modelo nunca vê o jid, que tem o número inteiro) ----------

  idPublico(jid: string): string {
    const h = createHmac("sha256", this.#chave).update(`id:${jid}`).digest("hex").slice(0, 12);
    return `${ehGrupo(jid) ? "g" : "c"}_${h}`;
  }

  /** Acha o jid de um id público entre as conversas, as listas e o cache de grupos. */
  jidDoId(id: string): string | undefined {
    const candidatos = new Set<string>([
      ...Object.keys(this.#indice().conversas),
      ...this.config().bloqueados,
      ...this.config().grupos_permitidos,
      ...Object.keys(this.cacheDeGrupos()?.grupos ?? {}),
    ]);
    for (const jid of candidatos) if (this.idPublico(jid) === id) return jid;
    return undefined;
  }

  // ---------- consultas ----------

  /** 0.11.0: a entrada de um grupo escolhido ainda sem mensagem guardada (não vai para o índice: só para escrever nele). */
  #entradaDeGrupoVazio(jid: string): EntradaIndice {
    const nome = this.#indice().nomes[jid]?.nome ?? this.cacheDeGrupos()?.grupos[jid]?.nome;
    return { jid, grupo: true, ...(nome ? { nome } : {}), prioridade_nome: 0, ultima_ts: 0, ultima_de_mim: false, ultima_texto: "", nao_lidas: 0, total: 0 };
  }

  entrada(jid: string): EntradaIndice | undefined {
    return this.#indice().conversas[normalizar(jid)];
  }

  nomeConhecido(jid: string): string | undefined {
    const j = normalizar(jid);
    const ind = this.#indice();
    return ind.conversas[j]?.nome ?? ind.nomes[j]?.nome;
  }

  /** Jids individuais com este nome exato (sem acento nem maiúscula), entre conversas e contatos conhecidos. */
  jidsPeloNome(nome: string): string[] {
    const alvo = semAcento(nome.trim());
    if (alvo === "") return [];
    const ind = this.#indice();
    const achados = new Set<string>();
    for (const c of Object.values(ind.conversas)) if (semAcento(c.nome ?? "") === alvo) achados.add(c.jid);
    for (const [jid, n] of Object.entries(ind.nomes)) if (semAcento(n.nome) === alvo) achados.add(this.chaveDaConversa(jid));
    return [...achados];
  }

  estatisticas(): { conversas: number; grupos: number; ultima_recebida_ts: number | null; bloqueadas: number; grupos_permitidos: number } {
    const ind = this.#indice();
    const todas = Object.values(ind.conversas);
    const c = this.config();
    return {
      conversas: todas.filter((x) => !x.grupo).length,
      grupos: todas.filter((x) => x.grupo).length,
      ultima_recebida_ts: ind.ultima_recebida_ts,
      bloqueadas: c.bloqueados.filter((b) => !ehLid(b) || !ind.lid_para_pn[b]).length,
      grupos_permitidos: c.grupos_permitidos.length,
    };
  }

  listarConversas(filtro?: string): EntradaIndice[] {
    // 0.11.0: o nome comparado é o MESMO que a lista mostra (o do índice e, num grupo sem nome no índice, o do cache dos
    // grupos, como em conversaPublica): antes, grupo com o nome só no cache aparecia na lista e não no filtro.
    const grupos = filtro ? (this.cacheDeGrupos()?.grupos ?? {}) : {};
    const nomeDe = (c: EntradaIndice) => c.nome ?? (c.grupo ? grupos[c.jid]?.nome : undefined) ?? "";
    return Object.values(this.#indice().conversas)
      .filter((c) => !filtro || nomeCasaComFiltro(nomeDe(c), filtro))
      .sort((a, b) => b.ultima_ts - a.ultima_ts);
  }

  /**
   * Acha a conversa guardada por id público, jid, número digitado ou nome
   * (igual, sem acento nem maiúscula; senão contendo, se for único).
   */
  resolver(ref: string, opcoes: { grupoEscolhidoVazio?: boolean } = {}): EntradaIndice {
    const ind = this.#indice();
    const texto = ref.trim();
    const porJid = (jid: string): EntradaIndice => {
      const chave = this.chaveDaConversa(jid);
      const e = ind.conversas[chave];
      if (e) return e;
      // 0.11.0: grupo que o dono ESCOLHEU e ainda não tem mensagem guardada (wa_responder, wa_enviar_arquivo).
      if (opcoes.grupoEscolhidoVazio && ehGrupo(chave) && this.grupoPermitido(chave)) return this.#entradaDeGrupoVazio(chave);
      if (ehIndividual(chave) && this.estaBloqueado(chave)) throw new ErroDeBanco("Essa conversa está na lista \"nunca ler\": nada dela é lido nem guardado.");
      if (ehGrupo(chave) && !this.grupoPermitido(chave)) throw new ErroDeBanco("Esse grupo não está entre os escolhidos; veja wa_listar_grupos e wa_escolher_grupos.");
      throw new ErroDeBanco("Não há mensagens guardadas dessa conversa. Veja wa_listar_conversas.");
    };
    if (/^[cg]_[0-9a-f]{12}$/.test(texto)) {
      const jid = this.jidDoId(texto);
      if (!jid) throw new ErroDeBanco("Não achei conversa com esse id. Veja wa_listar_conversas.");
      return porJid(jid);
    }
    if (texto.includes("@")) return porJid(normalizar(texto));
    const doNumero = jidDoNumero(texto);
    if (doNumero) return porJid(doNumero);
    const alvo = semAcento(texto.trim());
    const grupos = this.cacheDeGrupos()?.grupos ?? {};
    const nomeDe = (c: EntradaIndice) => semAcento(c.nome ?? (c.grupo ? grupos[c.jid]?.nome : undefined) ?? "");
    const todas = Object.values(ind.conversas);
    const iguais = todas.filter((c) => nomeDe(c) === alvo);
    let achadas = iguais.length > 0 ? iguais : todas.filter((c) => alvo !== "" && nomeDe(c).includes(alvo));
    if (achadas.length === 0 && opcoes.grupoEscolhidoVazio) {
      // Pelo nome: os grupos escolhidos ainda sem mensagem (nome do cache dos grupos ou o guardado antes da 1ª mensagem).
      const vazios = this.gruposPermitidos()
        .filter((g) => !ind.conversas[g])
        .map((g) => this.#entradaDeGrupoVazio(g));
      const iguaisVazios = vazios.filter((c) => nomeDe(c) === alvo);
      achadas = iguaisVazios.length > 0 ? iguaisVazios : vazios.filter((c) => alvo !== "" && nomeDe(c).includes(alvo));
    }
    if (achadas.length === 1) return achadas[0]!;
    if (achadas.length === 0) throw new ErroDeBanco("Não achei conversa com esse nome. Veja wa_listar_conversas.");
    throw new ErroDeBanco(`Há ${achadas.length} conversas com esse nome; use o id de wa_listar_conversas.`);
  }
}
