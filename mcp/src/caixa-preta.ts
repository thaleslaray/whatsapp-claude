// 0.7.3: caixa-preta do processo. Por quê: a cópia dona da conexão saiu sozinha (13/11/2026, 17:45) sem deixar NENHUMA
// linha no stderr e sem relatório de travamento; não havia como saber se foi sinal, entrada padrão fechada, exceção,
// laço de eventos travado ou morte nativa (o whisper.cpp). Esta versão só OBSERVA: nada aqui muda quando ou como o
// processo sai.
//
// Dois arquivos na pasta de logs (Mac: ~/Library/Logs/whatsapp-claude; ver config.ts), SEM cifra:
// - `caixa-preta.jsonl`: uma linha JSON por evento, de todas as cópias da extensão, com `quando`, `pid`, `versao`,
//   `papel` e `evento`. Teto de 256 KB: ao passar, fica só a metade mais recente. Escrita SÍNCRONA (appendFileSync),
//   porque precisa funcionar dentro do `process.on("exit")`.
// - `vivo-<pid>.json`: o que ESTE processo está fazendo agora (papel, ferramentas e etapas pesadas em andamento),
//   reescrito de forma síncrona e atômica só quando algo muda, e apagado na saída limpa. Morte nativa, SIGKILL e falta
//   de memória não rodam código nosso: o arquivo fica, e a próxima cópia que partir registra `morreu_sem_aviso` com o
//   que ele dizia.
//
// NUNCA entra aqui: jid, número, LID, id de mensagem ou de conversa, nome, texto, caminho de arquivo do usuário,
// argumentos de ferramenta, código de confirmação ou chave. Só nomes de ferramenta e de etapa, tipos de erro,
// contagens, durações, códigos de saída e nomes de sinal. Frase de erro: só a que já passou pela linhaSegura (do
// saida-segura.ts), limpa de novo, sem números longos e cortada em 200.
// Toda falha de escrita é engolida: a caixa-preta nunca derruba nem atrasa o servidor.

import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inicioDesteProcesso, inicioPeloSistema, processoVivo, TOLERANCIA_DO_INICIO_MS, type InicioDe } from "./lock.ts";
import { log } from "./log.ts";
import { protegerPermissao } from "./pasta.ts";
import { limpar, linhaDeRegistro } from "./segredos.ts";
import { VERSAO_SERVIDOR } from "./versao.ts";

export const ARQUIVO_DA_CAIXA_PRETA = "caixa-preta.jsonl";
export const TETO_DA_CAIXA_PRETA = 256 * 1024;
export const PADRAO_DO_VIVO = /^vivo-(\d{1,10})\.json$/;
export const nomeDoVivo = (pid: number): string => `vivo-${pid}.json`;
/** Frase de erro: no máximo isto. */
export const TAMANHO_DA_FRASE = 200;
/** Laço de eventos: mede a cada 1 s; atraso acima de 2 s é trava; no máximo um registro a cada 10 s. */
export const VIGIA_DO_LACO = { intervaloMs: 1_000, limiteMs: 2_000, entreRegistrosMs: 10_000 };
/** A mesma exceção solta não é registrada de novo antes disto (protege o histórico do teto de tamanho). */
const ENTRE_ERROS_IGUAIS_MS = 60_000;
const DIA_MS = 24 * 3_600_000;

/** As etapas pesadas do motor nativo e do modelo (os únicos nomes de etapa que existem). */
export const ETAPAS = {
  carregarModelo: "carregando o modelo de transcrição",
  decodificar: "decodificando o áudio",
  transcrever: "transcrevendo",
  soltarModelo: "soltando o modelo de transcrição",
  baixarModelo: "baixando o modelo de transcrição",
} as const;

export type PapelDoProcesso = "dono" | "leitor" | "indefinido";

/** O relógio da vigia do laço (injetável: os testes controlam o tempo). */
export interface RelogioDaVigia {
  agora(): number;
  setInterval(f: () => void, ms: number): unknown;
  clearInterval(t: unknown): void;
}

const RELOGIO_REAL: RelogioDaVigia = {
  agora: () => Date.now(),
  setInterval: (f, ms) => setInterval(f, ms),
  clearInterval: (t) => clearInterval(t as ReturnType<typeof setInterval>),
};

export interface OpcoesDaCaixaPreta {
  /** Pasta de logs. Sem ela, nada vai para o disco (os testes que não injetam uma caixa-preta). */
  dir?: string;
  pid?: number;
  versao?: string;
  /** Hora de início deste processo (ms desde 1970). */
  inicio?: number;
  agora?: () => number;
  tetoBytes?: number;
  /** Uma linha por evento no stderr (padrão: `log`, só quando há pasta). */
  saida?: (linha: string) => void;
  /** Os testes trocam: PID vivo e hora de início de outro PID (padrão: os do lock). */
  processoVivo?: (pid: number) => boolean;
  inicioDe?: InicioDe;
}

/** A última queda, como o wa_estado mostra (sem pid e sem caminho). */
export interface Queda {
  quando: string;
  como: string;
  papel: string;
  versao: string;
  fazendo: string[];
}

interface ConteudoDoVivo {
  pid: number;
  versao: string;
  inicio: number;
  papel: PapelDoProcesso;
  ferramentas: Record<string, number>;
  em_andamento: number;
  etapas: string[];
  saindo?: string;
  mudou_em: number;
}

const NOME_DE_FERRAMENTA = /^wa_[a-z_]{1,40}$/;
const NOME_DE_ERRO = /^[A-Za-z][A-Za-z0-9_.]{0,59}$/;
const CODIGO_DE_ERRO = /^[A-Z][A-Z0-9_]{1,39}$/;
const MOTIVOS_DE_SAIDA = new Set(["SIGTERM", "SIGINT", "SIGHUP", "SIGBREAK", "entrada padrão terminou", "entrada padrão fechou", "entrada padrão falhou", "transporte fechou"]);
/** 0.11.0: motivos em que quem fechou foi o Claude Desktop (a entrada padrão ou o transporte). */
const FECHADA_PELO_APP = new Set(["entrada padrão terminou", "entrada padrão fechou", "transporte fechou", "SIGTERM"]);
/** 0.11.0: abaixo disto no ar, a cópia fechada pelo app é a da troca de versão (ou uma sondagem): normal. */
export const SAIDA_CURTA_S = 5;
const ETAPAS_CONHECIDAS = new Set<string>(Object.values(ETAPAS));

/** Frase de erro já passada pela linhaSegura: limpa de novo, sem números longos (telefone sem @), cortada em 200. */
export function fraseDaCaixaPreta(frase: string): string {
  return limpar(frase.split(/\r?\n/, 1)[0] ?? "")
    .replace(/\d{8,}/g, "‹número›")
    .trim()
    .slice(0, TAMANHO_DA_FRASE);
}

const segundos = (ms: number): number => Math.max(0, Math.round(ms / 1000));
const iso = (ms: number): string => new Date(ms).toISOString();

export class CaixaPreta {
  readonly caminho: string | undefined;
  readonly caminhoDoVivo: string | undefined;
  readonly pid: number;
  readonly versao: string;
  readonly inicio: number;
  readonly #dir: string | undefined;
  readonly #agora: () => number;
  readonly #teto: number;
  readonly #saida: (linha: string) => void;
  readonly #vivo: (pid: number) => boolean;
  readonly #inicioDe: InicioDe | undefined;
  #papel: PapelDoProcesso = "indefinido";
  readonly #ferramentas = new Map<string, number>();
  readonly #etapas = new Map<string, number>();
  /** O que esteve em andamento desde o último tique da vigia (uma trava síncrona termina antes de o tique rodar). */
  #desdeOUltimoTique = new Set<string>();
  #saindo: string | undefined;
  /** 0.11.0: saída sem passar pelo `saindo`: `process.exit` chamado direto, ou o laço de eventos que esvaziou. */
  #semSaindo: string | undefined;
  #saiu = false;
  #erroDeEscritaVisto = false;
  readonly #errosVistos = new Map<string, { em: number; suprimidos: number }>();
  /** Quantas vezes o laço de eventos travou neste processo. */
  lacoTravadoVezes = 0;

  constructor(opcoes: OpcoesDaCaixaPreta = {}) {
    this.#dir = opcoes.dir;
    this.caminho = opcoes.dir ? join(opcoes.dir, ARQUIVO_DA_CAIXA_PRETA) : undefined;
    this.pid = opcoes.pid ?? process.pid;
    this.caminhoDoVivo = opcoes.dir ? join(opcoes.dir, nomeDoVivo(this.pid)) : undefined;
    this.versao = opcoes.versao ?? VERSAO_SERVIDOR;
    this.inicio = opcoes.inicio ?? inicioDesteProcesso();
    this.#agora = opcoes.agora ?? Date.now;
    this.#teto = opcoes.tetoBytes ?? TETO_DA_CAIXA_PRETA;
    this.#saida = opcoes.saida ?? (opcoes.dir ? log : () => {});
    this.#vivo = opcoes.processoVivo ?? processoVivo;
    this.#inicioDe = opcoes.inicioDe;
  }

  get papel(): PapelDoProcesso {
    return this.#papel;
  }

  /** Uma linha na caixa-preta e no stderr. Nunca lança. */
  registrar(evento: string, campos: Record<string, unknown> = {}): void {
    try {
      const linha = linhaDeRegistro({ quando: iso(this.#agora()), pid: this.pid, versao: this.versao, papel: this.#papel, evento, ...campos });
      try {
        this.#saida(`[whatsapp-claude] caixa-preta: ${linha}`);
      } catch {
        /* stderr fechado: segue */
      }
      if (!this.caminho || !this.#dir) return;
      mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
      appendFileSync(this.caminho, `${linha}\n`, { mode: 0o600 });
      protegerPermissao(this.caminho, 0o600);
      this.#aparar();
    } catch {
      /* a caixa-preta nunca derruba nada */
    }
  }

  /** Passou do teto: fica só a metade mais recente (cortada no começo de uma linha), por arquivo temporário + rename. */
  #aparar(): void {
    if (!this.caminho) return;
    if (statSync(this.caminho).size <= this.#teto) return;
    const tudo = readFileSync(this.caminho);
    let corte = tudo.length - Math.floor(this.#teto / 2);
    const fimDeLinha = tudo.indexOf(0x0a, corte);
    corte = fimDeLinha < 0 ? tudo.length : fimDeLinha + 1;
    const temporario = `${this.caminho}.${this.pid}.tmp`;
    writeFileSync(temporario, tudo.subarray(corte), { mode: 0o600 });
    renameSync(temporario, this.caminho);
  }

  /** O que está em andamento agora: nomes de ferramenta (com a contagem) e etapas. */
  emAndamento(): { ferramentas: Record<string, number>; em_andamento: number; etapas: string[] } {
    let total = 0;
    for (const n of this.#ferramentas.values()) total += n;
    return { ferramentas: Object.fromEntries(this.#ferramentas), em_andamento: total, etapas: [...this.#etapas.keys()] };
  }

  #fazendoAgora(): string[] {
    return [...this.#ferramentas.keys(), ...this.#etapas.keys()];
  }

  // ---------- o arquivo "vivo" ----------

  #gravarVivo(): void {
    if (!this.caminhoDoVivo || !this.#dir || this.#saiu) return;
    try {
      const a = this.emAndamento();
      const conteudo: ConteudoDoVivo = {
        pid: this.pid,
        versao: this.versao,
        inicio: this.inicio,
        papel: this.#papel,
        ferramentas: a.ferramentas,
        em_andamento: a.em_andamento,
        etapas: a.etapas,
        ...(this.#saindo ? { saindo: this.#saindo } : {}),
        mudou_em: this.#agora(),
      };
      mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
      const temporario = `${this.caminhoDoVivo}.tmp`;
      writeFileSync(temporario, JSON.stringify(conteudo), { mode: 0o600 });
      renameSync(temporario, this.caminhoDoVivo);
    } catch {
      /* segue */
    }
  }

  /**
   * Partida do processo: o arquivo "vivo" deste pid que sobrou de outro processo (pid reaproveitado: ele com certeza
   * morreu) é registrado antes de ser trocado pelo nosso; depois, o evento `partida`.
   */
  partida(): void {
    if (this.caminhoDoVivo) {
      try {
        const velho = this.#lerVivo(this.caminhoDoVivo);
        if (velho && Math.abs(velho.inicio - this.inicio) > TOLERANCIA_DO_INICIO_MS) this.#registrarMorto(velho);
      } catch {
        /* ilegível: o nosso vai por cima */
      }
    }
    this.#gravarVivo();
    this.registrar("partida", { inicio: iso(this.inicio) });
  }

  #lerVivo(caminho: string): ConteudoDoVivo | null {
    let bruto: string;
    try {
      bruto = readFileSync(caminho, "utf8");
    } catch (erro) {
      if ((erro as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw erro;
    }
    const c = JSON.parse(bruto) as Partial<ConteudoDoVivo>;
    if (typeof c.pid !== "number" || typeof c.inicio !== "number") throw new Error("vivo ilegível");
    return {
      pid: c.pid,
      versao: typeof c.versao === "string" ? c.versao.slice(0, 20) : "?",
      inicio: c.inicio,
      papel: c.papel === "dono" || c.papel === "leitor" ? c.papel : "indefinido",
      ferramentas: Object.fromEntries(
        Object.entries(typeof c.ferramentas === "object" && c.ferramentas !== null ? c.ferramentas : {}).filter(([n, q]) => NOME_DE_FERRAMENTA.test(n) && typeof q === "number"),
      ),
      em_andamento: typeof c.em_andamento === "number" ? c.em_andamento : 0,
      etapas: Array.isArray(c.etapas) ? c.etapas.filter((e): e is string => typeof e === "string" && ETAPAS_CONHECIDAS.has(e)) : [],
      ...(typeof c.saindo === "string" && MOTIVOS_DE_SAIDA.has(c.saindo) ? { saindo: c.saindo } : {}),
      mudou_em: typeof c.mudou_em === "number" ? c.mudou_em : c.inicio,
    };
  }

  #registrarMorto(v: ConteudoDoVivo): void {
    this.registrar("morreu_sem_aviso", {
      morto: {
        pid: v.pid,
        papel: v.papel,
        versao: v.versao,
        inicio: iso(v.inicio),
        ultima_mudanca: iso(v.mudou_em),
        no_ar_pelo_menos_s: segundos(v.mudou_em - v.inicio),
        ferramentas_em_andamento: v.ferramentas,
        em_andamento: v.em_andamento,
        etapas_em_andamento: v.etapas,
        ...(v.saindo ? { estava_saindo: v.saindo } : {}),
      },
    });
  }

  /**
   * Varre os arquivos "vivo" de outros processos: de pid morto (ou reaproveitado, pela hora de início, como o lock
   * faz) vira `morreu_sem_aviso` e é apagado; de pid vivo fica em paz; ilegível é apagado. Devolve quantos registrou.
   * Para duas cópias que partem juntas não registrarem o mesmo morto, quem registra antes renomeia o arquivo.
   */
  async varrerMortos(): Promise<number> {
    if (!this.#dir) return 0;
    let nomes: string[];
    try {
      nomes = readdirSync(this.#dir);
    } catch {
      return 0;
    }
    let registrados = 0;
    for (const nome of nomes) {
      const m = PADRAO_DO_VIVO.exec(nome);
      if (!m || Number(m[1]) === this.pid) continue;
      const caminho = join(this.#dir, nome);
      try {
        let v: ConteudoDoVivo | null;
        try {
          v = this.#lerVivo(caminho);
        } catch {
          rmSync(caminho, { force: true });
          continue;
        }
        if (!v || (await this.#aindaVivo(v))) continue;
        const tomado = `${caminho}.${this.pid}.lendo`;
        try {
          renameSync(caminho, tomado);
        } catch {
          continue; // outra cópia já registrou
        }
        rmSync(tomado, { force: true });
        this.#registrarMorto(v);
        registrados++;
      } catch {
        /* segue para o próximo */
      }
    }
    return registrados;
  }

  async #aindaVivo(v: ConteudoDoVivo): Promise<boolean> {
    if (!this.#vivo(v.pid)) return false;
    const inicioDe = this.#inicioDe ?? inicioPeloSistema();
    const agora = await inicioDe(v.pid);
    if (agora === undefined) return true; // não deu para saber: na dúvida, vivo
    return Math.abs(agora - v.inicio) <= TOLERANCIA_DO_INICIO_MS;
  }

  // ---------- papel, ferramentas e etapas ----------

  /** Dono ou leitor. A primeira definição é `papel_definido`; a troca (leitor -> dono ou o contrário), `papel_mudou`. */
  definirPapel(novo: "dono" | "leitor"): void {
    const antes = this.#papel;
    if (antes === novo) return;
    this.#papel = novo;
    this.#gravarVivo();
    if (antes === "indefinido") this.registrar("papel_definido");
    else this.registrar("papel_mudou", { de: antes, para: novo, no_ar_ha_s: segundos(this.#agora() - this.inicio) });
  }

  #comecar(mapa: Map<string, number>, nome: string): void {
    mapa.set(nome, (mapa.get(nome) ?? 0) + 1);
    this.#desdeOUltimoTique.add(nome);
    this.#gravarVivo();
  }

  #terminar(mapa: Map<string, number>, nome: string): void {
    const n = (mapa.get(nome) ?? 1) - 1;
    if (n <= 0) mapa.delete(nome);
    else mapa.set(nome, n);
    this.#gravarVivo();
  }

  /** Acompanha uma ferramenta (só o nome) do começo ao fim. O resultado e os erros dela passam como vieram. */
  async acompanharFerramenta<T>(nome: string, trabalho: () => Promise<T>): Promise<T> {
    const n = NOME_DE_FERRAMENTA.test(nome) ? nome : "wa_outra";
    this.#comecar(this.#ferramentas, n);
    try {
      return await trabalho();
    } finally {
      this.#terminar(this.#ferramentas, n);
    }
  }

  /** Acompanha uma etapa pesada (ETAPAS). O trabalho roda na hora (a parte síncrona dele já conta). */
  async etapa<T>(nome: string, trabalho: () => Promise<T>): Promise<T> {
    this.#comecar(this.#etapas, nome);
    try {
      return await trabalho();
    } finally {
      this.#terminar(this.#etapas, nome);
    }
  }

  // ---------- saídas e erros ----------

  /** A saída começou (sinal, entrada padrão, transporte). Uma vez só. */
  saindo(motivo: string): void {
    if (this.#saindo) return;
    this.#saindo = MOTIVOS_DE_SAIDA.has(motivo) ? motivo : "outro";
    this.#gravarVivo();
    const a = this.emAndamento();
    this.registrar("saindo", { motivo: this.#saindo, no_ar_ha_s: segundos(this.#agora() - this.inicio), ...a });
  }

  /**
   * 0.11.0: `process.exit` chamado sem passar pelo `sair` do stdio (uma biblioteca, ou a falha na partida). Leva o código
   * e os NOMES das funções que chamaram (nomes do código, nunca caminho nem argumento), para a próxima saída misteriosa
   * dizer quem saiu.
   */
  exitDireto(codigo: number | string | null | undefined, chamadoPor: readonly string[]): void {
    if (this.#saindo || this.#semSaindo) return;
    this.#semSaindo = "process.exit chamado direto";
    this.registrar("exit_direto", {
      codigo: typeof codigo === "number" ? codigo : codigo === undefined || codigo === null ? null : String(codigo).slice(0, 10),
      chamado_por: chamadoPor.filter((n) => /^[A-Za-z_$][\w$.<>]{0,60}$/.test(n)).slice(0, 4),
    });
  }

  /** 0.11.0: o laço de eventos esvaziou (`beforeExit`): nada mais segurava o processo, e ele vai sair sozinho com 0. */
  lacoVazio(codigo: number): void {
    if (this.#saindo || this.#semSaindo) return;
    this.#semSaindo = "laço de eventos vazio";
    this.registrar("laco_vazio", { codigo });
  }

  /** `process.on("exit")`: síncrono. Registra e apaga o arquivo "vivo" (saída limpa: nada para a próxima cópia contar). */
  saiu(codigo: number): void {
    if (this.#saiu) return;
    const noAr = segundos(this.#agora() - this.inicio);
    // 0.11.0: o motivo legível no próprio `saiu`. A cópia que o Claude Desktop abre e fecha em segundos (troca de versão,
    // sondagem das ferramentas) saía com "código 0, 0 s no ar" e parecia queda: agora diz que é normal.
    const motivo = this.#saindo ?? this.#semSaindo ?? "sem motivo registrado";
    const normal = codigo === 0 && (this.#saindo !== undefined || this.#semSaindo === "laço de eventos vazio");
    const curta = normal && this.#saindo !== undefined && FECHADA_PELO_APP.has(this.#saindo) && noAr < SAIDA_CURTA_S;
    this.registrar("saiu", {
      codigo,
      no_ar_ha_s: noAr,
      motivo,
      normal,
      ...(curta ? { leitura: "fechada pelo Claude Desktop logo depois de abrir (troca de versão ou sondagem): normal, não é queda" } : {}),
      ...this.emAndamento(),
    });
    this.#saiu = true;
    if (this.caminhoDoVivo) {
      try {
        rmSync(this.caminhoDoVivo, { force: true });
      } catch {
        /* segue */
      }
    }
  }

  /** Exceção ou promessa rejeitada solta (pelo gancho do saida-segura.ts). EPIPE vira `erro_de_escrita`, uma vez. */
  erroSolto(tipo: string, nome: string, frase: string, codigo?: string): void {
    const cod = codigo && CODIGO_DE_ERRO.test(codigo) ? codigo : undefined;
    if (cod === "EPIPE") {
      this.erroDeEscrita("desconhecido", cod);
      return;
    }
    const n = NOME_DE_ERRO.test(nome) ? nome : "Error";
    const f = fraseDaCaixaPreta(frase);
    const assinatura = `${tipo}|${n}|${f}`;
    const agora = this.#agora();
    const visto = this.#errosVistos.get(assinatura);
    if (visto && agora - visto.em < ENTRE_ERROS_IGUAIS_MS) {
      visto.suprimidos++;
      return;
    }
    if (this.#errosVistos.size > 100) this.#errosVistos.clear();
    this.#errosVistos.set(assinatura, { em: agora, suprimidos: 0 });
    this.registrar("erro_solto", {
      tipo: tipo === "promessa_rejeitada" ? tipo : "excecao",
      nome: n,
      ...(cod ? { codigo_do_erro: cod } : {}),
      frase: f,
      ...(visto?.suprimidos ? { repeticoes_nao_registradas: visto.suprimidos } : {}),
      fazendo: this.#fazendoAgora(),
    });
  }

  /** Erro de escrita no stdout/stderr (EPIPE: o outro lado fechou o cano). Uma vez por processo. */
  erroDeEscrita(onde: "stdout" | "stderr" | "desconhecido", codigo: string): void {
    if (this.#erroDeEscritaVisto) return;
    this.#erroDeEscritaVisto = true;
    this.registrar("erro_de_escrita", { onde, codigo_do_erro: CODIGO_DE_ERRO.test(codigo) ? codigo : "outro" });
  }

  /** O leitor não falou com o dono: só o nome da ferramenta e o tipo da falha (nunca endereço nem conteúdo). */
  repasseFalhou(ferramenta: string, tipo: string): void {
    this.registrar("repasse_falhou", { ferramenta: NOME_DE_FERRAMENTA.test(ferramenta) ? ferramenta : "wa_outra", tipo: /^[a-z_]{1,40}$/.test(tipo) ? tipo : "outro" });
  }

  // ---------- laço de eventos ----------

  /**
   * Mede o atraso do laço de eventos com um temporizador leve (com `unref`). Atraso acima do limite vira `laco_travado`
   * (com a duração e o que esteve em andamento), no máximo um registro a cada `entreRegistrosMs`; o contador conta todas.
   * Devolve a função que para a vigia.
   */
  vigiarLaco(opcoes: Partial<typeof VIGIA_DO_LACO> & { relogio?: RelogioDaVigia } = {}): () => void {
    const { intervaloMs, limiteMs, entreRegistrosMs } = { ...VIGIA_DO_LACO, ...opcoes };
    const relogio = opcoes.relogio ?? RELOGIO_REAL;
    let esperado = relogio.agora() + intervaloMs;
    let ultimoRegistro = Number.NEGATIVE_INFINITY;
    const t = relogio.setInterval(() => {
      const agora = relogio.agora();
      const atraso = agora - esperado;
      esperado = agora + intervaloMs;
      const vistos = [...new Set([...this.#desdeOUltimoTique, ...this.#fazendoAgora()])];
      this.#desdeOUltimoTique = new Set(this.#fazendoAgora());
      if (atraso <= limiteMs) return;
      this.lacoTravadoVezes++;
      if (agora - ultimoRegistro < entreRegistrosMs) return;
      ultimoRegistro = agora;
      this.registrar("laco_travado", { atraso_ms: Math.round(atraso), vezes: this.lacoTravadoVezes, fazendo: vistos });
    }, intervaloMs);
    (t as { unref?: () => void } | undefined)?.unref?.();
    return () => relogio.clearInterval(t);
  }

  // ---------- leitura (wa_estado) ----------

  /** A queda mais recente da caixa-preta (de qualquer cópia): morte sem aviso, saída com código de erro, ou saída com trabalho em andamento. */
  ultimaQueda(): Queda | null {
    if (!this.caminho) return null;
    let linhas: string[];
    try {
      linhas = readFileSync(this.caminho, "utf8").split("\n");
    } catch {
      return null;
    }
    for (let i = linhas.length - 1; i >= 0; i--) {
      const texto = linhas[i]!.trim();
      if (!texto) continue;
      let l: Record<string, unknown>;
      try {
        l = JSON.parse(texto) as Record<string, unknown>;
      } catch {
        continue;
      }
      const q = quedaDa(l);
      if (q) return q;
    }
    return null;
  }

  /** O campo `processo` do wa_estado. */
  resumo(): { no_ar_ha_s: number; papel: PapelDoProcesso; laco_travado_vezes: number; ultima_queda: Queda | null } {
    return { no_ar_ha_s: segundos(this.#agora() - this.inicio), papel: this.#papel, laco_travado_vezes: this.lacoTravadoVezes, ultima_queda: this.ultimaQueda() };
  }

  /** A queda é das últimas 24 h? */
  quedaRecente(q: Queda | null): boolean {
    if (!q) return false;
    const em = Date.parse(q.quando);
    return Number.isFinite(em) && this.#agora() - em <= DIA_MS;
  }
}

const textos = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const nomesDe = (v: unknown): string[] => (typeof v === "object" && v !== null ? Object.keys(v).filter((n) => NOME_DE_FERRAMENTA.test(n)) : []);

/** A linha é uma queda? Devolve a forma do wa_estado (sem pid). */
function quedaDa(l: Record<string, unknown>): Queda | null {
  const quando = typeof l.quando === "string" ? l.quando : "";
  const papel = typeof l.papel === "string" ? l.papel : "indefinido";
  const versao = typeof l.versao === "string" ? l.versao : "?";
  if (l.evento === "morreu_sem_aviso" && typeof l.morto === "object" && l.morto !== null) {
    const m = l.morto as Record<string, unknown>;
    return {
      quando,
      como: "morreu sem aviso (sem rodar a saída: travamento nativo, SIGKILL ou falta de memória)",
      papel: typeof m.papel === "string" ? m.papel : "indefinido",
      versao: typeof m.versao === "string" ? m.versao : "?",
      fazendo: [...nomesDe(m.ferramentas_em_andamento), ...textos(m.etapas_em_andamento)],
    };
  }
  if (l.evento === "saiu" && typeof l.codigo === "number" && l.codigo !== 0) {
    return { quando, como: `saiu com código ${l.codigo}`, papel, versao, fazendo: [...nomesDe(l.ferramentas), ...textos(l.etapas)] };
  }
  if (l.evento === "saindo" && ((typeof l.em_andamento === "number" && l.em_andamento > 0) || textos(l.etapas).length > 0)) {
    const motivo = typeof l.motivo === "string" ? l.motivo : "outro";
    return { quando, como: `saiu (${motivo}) com trabalho em andamento`, papel, versao, fazendo: [...nomesDe(l.ferramentas), ...textos(l.etapas)] };
  }
  return null;
}

/** Os nomes das funções na pilha de quem chamou (sem caminho, linha nem argumento), pulando as primeiras `pular`. */
export function nomesNaPilha(pilha: string | undefined, pular: number): string[] {
  const nomes: string[] = [];
  for (const linha of (pilha ?? "").split("\n").slice(1 + pular)) {
    // "at nome (", "at async nome (" e "at Timeout.nome [as _onTimeout] (": só o nome.
    const m = /^\s*at (?:async )?([A-Za-z_$][\w$.<>]{0,60})(?: \[as [\w$]{1,40}\])? \(/.exec(linha);
    if (m) nomes.push(m[1]!);
    if (nomes.length >= 4) break;
  }
  return nomes;
}

/**
 * 0.11.0: os caminhos de saída que não passam pelo `sair` do stdio também deixam rastro:
 * - `process.exit` chamado direto (uma biblioteca, ou a falha na partida): `exit_direto`, com os nomes de quem chamou;
 * - o laço de eventos que esvazia (`beforeExit`): `laco_vazio`;
 * - toda saída: `saiu` no `exit` (síncrono), e depois `aoSair` (soltar o lock).
 * `estaSaindo` diz se a saída já começou pelo `sair` (aí o `process.exit` é o nosso). Instalado o mais cedo possível,
 * logo depois de a caixa-preta existir. Devolve como desinstalar (testes).
 */
export function instalarRastroDaSaida(caixa: CaixaPreta, opcoes: { estaSaindo: () => boolean; aoSair?: () => void }): () => void {
  const exitOriginal = process.exit;
  const exitComRastro = function (this: unknown, codigo?: number | string | null) {
    if (!opcoes.estaSaindo()) {
      try {
        caixa.exitDireto(codigo ?? process.exitCode ?? 0, nomesNaPilha(new Error().stack, 1));
      } catch {
        /* o rastro nunca impede a saída */
      }
    }
    return exitOriginal.call(process, codigo as number | undefined);
  } as typeof process.exit;
  process.exit = exitComRastro;
  const antesDeSair = (codigo: number) => caixa.lacoVazio(codigo);
  const aoExit = (codigo: number) => {
    caixa.saiu(codigo);
    try {
      opcoes.aoSair?.();
    } catch {
      /* segue */
    }
  };
  process.once("beforeExit", antesDeSair);
  process.on("exit", aoExit);
  return () => {
    if (process.exit === exitComRastro) process.exit = exitOriginal;
    process.off("beforeExit", antesDeSair);
    process.off("exit", aoExit);
  };
}
