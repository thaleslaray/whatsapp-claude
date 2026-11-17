// Estado compartilhado do servidor: config, cofre, banco, sessão, lock de dono da conexão e transporte.
// O servidor MCP é criado de novo a cada sessão (guia do SDK v2), o Contexto é um só por processo.
//
// Dono da conexão x leitor: só o processo que pega o lock (lock.ts) abre o socket. Os outros leem o banco
// e tentam pegar o lock de novo a cada 30 s (o dono pode ter fechado).
// Sem sessão pareada, nem o dono conecta: `wa_estado` diz "não pareado". O pareamento só começa com o clique no
// cartão do wa_parear (`iniciarPareamento`). Os pedidos de confirmação (cartões) vivem aqui, só em memória.
//
// Cofre que não abre na partida (Keychain trancado no Mac; PowerShell bloqueado ou lento no Windows): o dono do lock
// tenta ligar de novo sozinho, com espera crescente até 60 s, e as ferramentas dizem que o cofre não abriu (e por quê),
// não que outra sessão é a dona.
//
// 0.6.0, o leitor repassa ao dono: o Claude Desktop sobe mais de uma cópia da extensão ao mesmo tempo (conversa comum
// e aba Code). O dono escuta num canal local autenticado (canal.ts), com o endereço gravado no lock; o leitor repassa
// cada chamada de ferramenta inteira e devolve o resultado do dono como veio. Os pedidos de confirmação nascem e vivem
// SÓ no dono: um leitor nunca cria pedido enquanto houver dono. Se o canal não responde, o leitor responde só a
// leitura, localmente; o resto recusa com FRASE_DO_LEITOR, sem executar nada.
//
// 0.7.3: a caixa-preta (caixa-preta.ts) fica aqui: o papel (definido e trocado), o repasse que falhou (com o tipo da
// falha) e as etapas pesadas do motor nativo e do modelo. Só observa: nada do que ela faz muda o resultado.

import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { pastaDeDownloadsPadrao } from "./midia.ts";
import { apagarCanaisOrfaos, chamarPeloCanal, chaveDoCanal, enderecoDoCanal, ErroDoCanal, ServidorDoCanal, type PedidoDoCanal } from "./canal.ts";
import type { Cofre } from "./cofre.ts";
import type { Config } from "./config.ts";
import { Banco } from "./banco.ts";
import { Pedidos } from "./confirmacao.ts";
import { LockDeConexao, type InicioDe } from "./lock.ts";
import { log } from "./log.ts";
import { limpar } from "./segredos.ts";
import { RegistroAcoes } from "./registro-acoes.ts";
import { Sessao } from "./sessao.ts";
import { unir } from "./pasta.ts";
import { Modelo, type ModeloEsperado } from "./modelo.ts";
import { carregadorNativo, decodificarOggOpus, FilaDeTranscricao, planoDoMotor, type CarregarMotor, type DecodificarAudio } from "./transcricao.ts";
import { CaixaPreta, ETAPAS } from "./caixa-preta.ts";
import { Busca, type CarregarSqlite } from "./busca.ts";
import { Triagem } from "./triagem.ts";
import { CacheDoJeito } from "./jeito.ts";
import { TrabalhosDeHistorico } from "./historico-em-lote.ts";
import { AgendaAutomatica } from "./agenda.ts";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { criarTransporte, esperaDaReconexao, type CriarSocket, type EstadoDaConexao, type Temporizador, type Transporte } from "./transporte.ts";

export interface Nucleo {
  banco: Banco;
  sessao: Sessao;
  /** Chave do canal leitor -> dono, derivada da chave da instalação (nunca a chave AES direto). */
  chaveDoCanal: Buffer;
}

export interface OpcoesContexto {
  config: Config;
  cofre: Cofre;
  /** Testes: socket falso. */
  criarSocket?: CriarSocket;
  temporizador?: Temporizador;
  registro?: RegistroAcoes;
  /** Testes: PID gravado no lock. */
  pid?: number;
  /** Intervalo da nova tentativa de pegar o lock no modo leitor. */
  intervaloDoLockMs?: number;
  /** Testes: hora de início de outro PID (padrão: `ps`). */
  inicioDe?: InicioDe;
  /** Testes: quanto tempo fica "digitando…" antes de enviar. */
  esperaDigitandoMs?: () => number;
  /** Testes: relógio dos pedidos. */
  agora?: () => number;
  /** Quanto o wa_confirmar do pareamento espera o primeiro QR (padrão 20 s; os testes encurtam). */
  esperaDoQrMs?: number;
  /** Quanto o wa_buscar_historico espera a resposta do celular (padrão 20 s; os testes encurtam). */
  esperaDoHistoricoMs?: number;
  /** 0.7.0, parte 2: onde o wa_abrir_midia grava (padrão: Downloads/WhatsApp Claude na casa). Os testes trocam. */
  pastaDeDownloads?: string;
  /** 0.16.0: a casa do usuário, de onde saem as pastas permitidas do wa_enviar_arquivo (padrão: a de verdade). Os testes trocam. */
  casa?: string;
  /** 0.7.0, parte 2: o `fetch` do download de mídia (padrão: o do Node). Os testes injetam um servidor falso. */
  buscarMidia?: typeof fetch;
  /** 0.7.0, parte 3: carrega o motor de transcrição (padrão: o nativo do pacote, server/nativo). Os testes injetam um falso. */
  carregarMotor?: CarregarMotor;
  /** 0.7.0, parte 3: OGG/Opus -> PCM 16 kHz (padrão: ogg-opus-decoder). Os testes injetam um falso. */
  decodificarAudio?: DecodificarAudio;
  /** 0.7.0, parte 3: o `fetch` do download do modelo (padrão: o do Node). Os testes injetam um servidor falso. */
  buscarModelo?: typeof fetch;
  /** 0.7.0, parte 3: qual modelo baixar e conferir (padrão: o de verdade, 190 MB). Os testes usam um pequeno. */
  modeloEsperado?: ModeloEsperado;
  /** 0.7.0, parte 3: quanto o wa_transcrever espera o texto antes de responder "em andamento" (padrão 20 s). */
  esperaDaTranscricaoMs?: number;
  /** 0.7.3: a caixa-preta do processo (o stdio.ts passa a de verdade; sem ela, uma só na memória, que não grava nada). */
  caixaPreta?: CaixaPreta;
  /** 0.8.0: carrega o `node:sqlite` para a busca (padrão: o do Node). Os testes injetam uma que nega o módulo. */
  carregarSqlite?: CarregarSqlite;
  /** 0.15.0: quanto o pedido da agenda espera os contatos chegarem do celular (padrão 20 s; os testes encurtam). */
  esperaDosContatosMs?: number;
}

/** Quanto o wa_transcrever espera o texto antes de responder "em andamento". */
export const ESPERA_DA_TRANSCRICAO_MS = 20_000;

/** Quanto o wa_confirmar do pareamento espera o primeiro QR antes de devolver o cartão "gerando o QR". */
export const ESPERA_DO_PRIMEIRO_QR_MS = 20_000;
/** Quanto o wa_buscar_historico espera a resposta do celular. */
export const ESPERA_DO_HISTORICO_MS = 20_000;
/** 0.15.0: quanto o pedido da agenda (manual ou automático) espera os contatos chegarem do celular. */
export const ESPERA_DOS_CONTATOS_MS = 20_000;

export class ErroDePapel extends Error {
  override name = "ErroDePapel";
}

/** A frase do leitor quando o canal do dono não responde (0.6.0). Nada foi executado. */
export const FRASE_DO_LEITOR = "A conexão está com outra sessão do Claude e não consegui falar com ela agora; tente de novo em instantes.";

/** Como a chamada chegou ao manipulador: o cliente MCP mostra cartões? Veio pelo canal de um leitor? */
export interface Chamada {
  temTela: boolean;
  viaCanal: boolean;
}

/** Uma ferramenta no registro do processo: o que o canal pode executar (só o que está aqui, validado pelo mesmo zod). */
export interface FerramentaDoRegistro {
  /** Leitura pura: no leitor sem canal, responde localmente. */
  leitura: boolean;
  /** Valida os argumentos com o schema da ferramenta e executa. Erro de validação vira resultado isError. */
  executar(argumentos: unknown, chamada: Chamada): Promise<CallToolResult>;
}

/** Este processo é o dono da conexão, mas o cofre não abriu: é outra coisa, com outra saída. O motivo diz o sistema. */
export const fraseDoCofre = (motivo: string): string =>
  `Não consegui abrir o cofre deste computador: ${motivo} Tento de novo sozinho, com espera de até 60 s.`;

const RELOGIO_REAL: Pick<Temporizador, "setTimeout" | "clearTimeout"> = {
  setTimeout: (f, ms) => setTimeout(f, ms),
  clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
};

export type Papel = "dono_da_conexao" | "leitor";

export class Contexto {
  readonly config: Config;
  readonly cofre: Cofre;
  readonly registro: RegistroAcoes;
  readonly lock: LockDeConexao;
  readonly pedidos: Pedidos;
  readonly agora: () => number;
  readonly esperaDoQrMs: number;
  readonly esperaDoHistoricoMs: number;
  /** Onde o wa_abrir_midia grava os arquivos abertos (sem cifra, a pedido do dono). */
  readonly pastaDeDownloads: string;
  /** 0.16.0: a casa do usuário (as pastas permitidas do wa_enviar_arquivo ficam nela). */
  readonly casa: string;
  /** Último pedido de histórico de cada conversa (ms): no máximo um a cada 30 s. Só na memória. */
  readonly ultimoHistorico = new Map<string, number>();
  /** 0.13.1: a próxima âncora sintética do rodízio de cada grupo vazio (índice em ANCORAS_SINTETICAS). Só na memória. */
  readonly ancoraSinteticaAuto = new Map<string, number>();
  /** 0.15.0: o último pedido da agenda ao celular (ms, relógio `agora`): no máximo um a cada 10 min. Só na memória do dono. */
  ultimaAtualizacaoDeContatos: number | undefined;
  readonly esperaDosContatosMs: number;
  /** 0.15.1: a agenda pedida sozinha (depois do pareamento e uma vez por semana), no dono da conexão. */
  readonly agendaAutomatica: AgendaAutomatica;
  /** Endereço do canal deste processo (socket Unix ou named pipe, com parte aleatória a cada partida). */
  readonly enderecoDoCanal: string;
  /** Registro das ferramentas por nome, preenchido pelos registrar* de respostas.ts. */
  readonly ferramentas = new Map<string, FerramentaDoRegistro>();
  readonly #criarSocket: CriarSocket | undefined;
  readonly #esperaDigitando: (() => number) | undefined;
  readonly #buscarMidia: typeof fetch | undefined;
  /** Mídias já abertas neste processo (wa_abrir_midia): chave "jid|id" -> arquivo gravado e o hash dele (gancho da parte 3). */
  readonly midiasAbertas = new Map<string, { caminho: string; sha256: string }>();
  /** 0.7.0, parte 3: o modelo de transcrição (download e conferência) e a fila única de transcrições. */
  readonly modelo: Modelo;
  readonly fila: FilaDeTranscricao;
  readonly decodificarAudio: DecodificarAudio;
  readonly esperaDaTranscricaoMs: number;
  readonly caixaPreta: CaixaPreta;
  /** 0.8.0: a busca com índice em memória (um por processo; o motor é testado aqui, na partida). */
  readonly busca: Busca;
  /** 0.9.0: a triagem do wa_listar_conversas (cache em memória por conversa, sem texto). */
  readonly triagem = new Triagem();
  /** 0.12.0: as medidas do jeito do dono (cache em memória por conversa, sem texto de mensagem). */
  readonly jeito = new CacheDoJeito();
  /** 0.13.0: os pedidos de histórico em segundo plano (wa_buscar_historico com `ate_total`), só na memória. */
  readonly historicoEmLote: TrabalhosDeHistorico;
  /** 0.13.0: o relógio dos 30 s entre pedidos do `ate_total` (o temporizador dos testes, ou o de verdade). */
  readonly relogio: Temporizador;
  readonly #temporizador: Temporizador | undefined;
  readonly #intervalo: number;
  #nucleo: Promise<Nucleo> | undefined;
  #transporte: Transporte | null = null;
  #retentativa: ReturnType<typeof setInterval> | undefined;
  #encerrado = false;
  /** A frase de por que o último #ligar falhou (o cofre não abriu), já limpa. */
  #erroAoLigar: string | undefined;
  #tentativasDeLigar = 0;
  #canal: ServidorDoCanal | null = null;
  /** A primeira tentativa de pegar o lock (a partida): até ela acabar, não se sabe se este processo é dono ou leitor. */
  #primeiraTentativa: Promise<unknown> | undefined;
  #chaveDoCanal: Buffer | undefined;
  #religar: unknown;
  /** PID do dono quando este processo é leitor. */
  pidDoDono: number | undefined;
  /** 0.11.0: que endereço do cartão o cliente de cada sessão MCP já leu (diagnóstico do cartão; só na memória). */
  readonly #telasLidas = new WeakMap<McpServer, Set<"com_versao" | "fixo">>();

  constructor(opcoes: OpcoesContexto) {
    this.config = opcoes.config;
    this.cofre = opcoes.cofre;
    this.registro = opcoes.registro ?? new RegistroAcoes(unir(opcoes.config.dirLogs, "acoes.jsonl"));
    this.enderecoDoCanal = enderecoDoCanal(process.platform, opcoes.config.dirDados, randomBytes(8).toString("hex"), tmpdir());
    this.lock = new LockDeConexao(opcoes.config.dirDados, {
      canal: this.enderecoDoCanal,
      ...(opcoes.pid !== undefined ? { pid: opcoes.pid } : {}),
      ...(opcoes.inicioDe ? { inicioDe: opcoes.inicioDe } : {}),
    });
    this.agora = opcoes.agora ?? Date.now;
    this.esperaDoQrMs = opcoes.esperaDoQrMs ?? ESPERA_DO_PRIMEIRO_QR_MS;
    this.esperaDoHistoricoMs = opcoes.esperaDoHistoricoMs ?? ESPERA_DO_HISTORICO_MS;
    this.esperaDosContatosMs = opcoes.esperaDosContatosMs ?? ESPERA_DOS_CONTATOS_MS;
    this.casa = opcoes.casa ?? homedir();
    this.pastaDeDownloads = opcoes.pastaDeDownloads ?? pastaDeDownloadsPadrao(process.platform, this.casa);
    this.pedidos = new Pedidos(this.registro, this.agora);
    this.#criarSocket = opcoes.criarSocket;
    this.#esperaDigitando = opcoes.esperaDigitandoMs;
    this.#buscarMidia = opcoes.buscarMidia;
    this.#temporizador = opcoes.temporizador;
    this.#intervalo = opcoes.intervaloDoLockMs ?? 30_000;
    const cp = (this.caixaPreta = opcoes.caixaPreta ?? new CaixaPreta());
    this.relogio = opcoes.temporizador ?? { ...RELOGIO_REAL, agora: () => Date.now() };
    this.agendaAutomatica = new AgendaAutomatica(this);
    this.historicoEmLote = new TrabalhosDeHistorico({ relogio: this.relogio, caixaPreta: cp, registro: this.registro });
    this.busca = new Busca({ caixaPreta: cp, ...(opcoes.carregarSqlite ? { carregarSqlite: opcoes.carregarSqlite } : {}) });
    this.modelo = new Modelo({
      dirDados: opcoes.config.dirDados,
      ...(opcoes.buscarModelo ? { buscar: opcoes.buscarModelo } : {}),
      ...(opcoes.modeloEsperado ? { esperado: opcoes.modeloEsperado } : {}),
      acompanharDownload: (trabalho) => cp.etapa(ETAPAS.baixarModelo, trabalho),
    });
    // O motor nativo mora ao lado do server/index.mjs do pacote (server/nativo/<sistema>-<arch>/index.node).
    const carregar = opcoes.carregarMotor ?? carregadorNativo(join(dirname(fileURLToPath(import.meta.url)), "nativo"));
    // 0.7.3: cada etapa pesada do nativo fica no arquivo "vivo" da caixa-preta enquanto roda (a conferência do sha256 e
    // a carga contam como "carregando"): se o processo morrer no meio, a próxima cópia sabe em qual.
    this.fila = new FilaDeTranscricao({
      carregar: () =>
        cp.etapa(ETAPAS.carregarModelo, async () => {
          const motor = await carregar(this.modelo.conferir());
          return {
            transcrever: (pcm, o) => cp.etapa(ETAPAS.transcrever, () => motor.transcrever(pcm, o)),
            liberar: () => cp.etapa(ETAPAS.soltarModelo, () => motor.liberar()),
          };
        }),
      ociosoMs: planoDoMotor(process.platform, process.arch, availableParallelism()).ociosoMs,
    });
    const decodificar = opcoes.decodificarAudio ?? decodificarOggOpus;
    this.decodificarAudio = (ogg) => cp.etapa(ETAPAS.decodificar, () => decodificar(ogg));
    this.esperaDaTranscricaoMs = opcoes.esperaDaTranscricaoMs ?? ESPERA_DA_TRANSCRICAO_MS;
  }

  /** 0.11.0: o cliente desta sessão leu o HTML do cartão (resources/read de um dos dois endereços). */
  telaLida(server: McpServer, uri: string): void {
    const lidas = this.#telasLidas.get(server) ?? new Set();
    lidas.add(uri.endsWith("/confirmar.html") ? "fixo" : "com_versao");
    this.#telasLidas.set(server, lidas);
  }

  /**
   * 0.11.0: o cartão apareceu como texto cru (JSON) três vezes no uso real, com causa desconhecida (ver FICHA.md). Cada
   * resposta de ferramenta de cartão deixa na caixa-preta um evento SEM conteúdo: ferramenta, por onde veio (direto, o
   * leitor que repassou ao dono, ou o dono atendendo pelo canal), se o cliente declarou tela, a forma da resposta, se o
   * `_meta` foi junto, se o cliente desta sessão já tinha lido o HTML do cartão (e qual endereço) e o tamanho. Na
   * próxima vez que o cartão não aparecer, a linha da hora diz o que era diferente.
   */
  diagnosticoDoCartao(d: { ferramenta: string; resultado: CallToolResult; temTela: boolean; viaCanal: boolean; repassado: boolean; server: McpServer | undefined }): void {
    try {
      const r = d.resultado as CallToolResult & { _meta?: Record<string, unknown> };
      const sc = r.structuredContent as Record<string, unknown> | undefined;
      const forma = r.isError
        ? typeof sc?.erro === "string" && sc.erro.startsWith("Bloqueado") ? "bloqueado" : "erro"
        : r._meta?.previa !== undefined && typeof sc?.pedido === "string"
          ? "previa"
          : r._meta !== undefined
            ? "cartao_sem_previa"
            : "sem_meta";
      const lidas = d.server ? this.#telasLidas.get(d.server) : undefined;
      this.caixaPreta.registrar("cartao_respondido", {
        ferramenta: /^wa_[a-z_]{1,40}$/.test(d.ferramenta) ? d.ferramenta : "wa_outra",
        via: d.viaCanal ? "pelo_canal" : d.repassado ? "repassado_ao_dono" : "direto",
        com_tela: d.temTela,
        forma,
        meta_na_resposta: r._meta !== undefined,
        // Quem atende pelo canal não fala com o cliente: não sabe o que ele leu.
        tela_lida_nesta_sessao: d.viaCanal ? null : (lidas?.size ?? 0) > 0,
        endereco_lido: d.viaCanal || !lidas || lidas.size === 0 ? null : lidas.size === 2 ? "os_dois" : [...lidas][0],
        tamanho: JSON.stringify(r).length,
      });
    } catch {
      /* diagnóstico nunca muda a resposta */
    }
  }

  /** Banco e sessão, abertos com a chave do cofre (derivada uma vez). */
  nucleo(): Promise<Nucleo> {
    this.#nucleo ??= (async () => {
      const chave = await this.cofre.obterChave();
      const banco = new Banco({ dir: this.config.dirDados, chave, maxMensagens: this.config.maxMensagens });
      // 0.9.0: o que este processo apaga some da memória na hora (índice da busca e cache da triagem). O que outro
      // processo apaga sai na leitura seguinte, pelo carimbo do arquivo.
      banco.aoApagar(() => {
        this.busca.esvaziar();
        this.triagem.esvaziar();
        this.jeito.esvaziar();
        // 0.13.0: o trabalho de histórico em segundo plano confere se a conversa dele ainda vale (bloquear, tirar o
        // grupo, apagar e desconectar param o trabalho).
        this.historicoEmLote.acordar();
      });
      return {
        banco,
        sessao: new Sessao(this.config.dirDados, chave),
        chaveDoCanal: chaveDoCanal(chave),
      };
    })();
    // Falha (ex.: Keychain trancado, PowerShell bloqueado) não fica guardada: a próxima chamada tenta de novo.
    this.#nucleo.catch(() => {
      this.#nucleo = undefined;
    });
    return this.#nucleo;
  }

  get papel(): Papel {
    return this.lock.ehDono ? "dono_da_conexao" : "leitor";
  }

  /**
   * Espera a partida decidir o papel (dono ou leitor). Uma chamada que chega enquanto o lock ainda está sendo tentado
   * (o stdio aceita pedidos logo, e a partida corre ao lado) não pode ser executada como se não houvesse dono.
   */
  async papelDecidido(): Promise<void> {
    await this.#primeiraTentativa;
  }

  /** Leitor com dono conhecido: as chamadas vão pelo canal. */
  get ehLeitor(): boolean {
    return !this.lock.ehDono && this.pidDoDono !== undefined;
  }

  async #chave(): Promise<Buffer> {
    this.#chaveDoCanal ??= (await this.nucleo()).chaveDoCanal;
    return this.#chaveDoCanal;
  }

  /**
   * Leitor: repassa a chamada ao dono e devolve o resultado dele como veio. null = o canal não respondeu (lock sem
   * `canal`, dono saindo, chave diferente, tempo): quem chamou decide (leitura local ou FRASE_DO_LEITOR).
   */
  async repassar(ferramenta: string, argumentos: unknown, temTela: boolean): Promise<CallToolResult | null> {
    const endereco = this.lock.canalDoDono();
    if (!endereco) {
      this.caixaPreta.repasseFalhou(ferramenta, "canal_ausente");
      return null;
    }
    try {
      return await chamarPeloCanal({ endereco, chave: await this.#chave(), pedido: { ferramenta, argumentos, temTela } });
    } catch (erro) {
      // ErroDoCanal: o dono não respondeu. Outro erro: o cofre não abriu, e sem chave não há canal.
      if (!(erro instanceof ErroDoCanal)) log("[whatsapp-claude] não consegui falar com a outra sessão do Claude: o cofre não abriu.");
      this.caixaPreta.repasseFalhou(ferramenta, erro instanceof ErroDoCanal ? erro.tipo : "cofre_nao_abriu");
      return null;
    }
  }

  /** Dono: executa um pedido que chegou pelo canal, só se a ferramenta está no registro. */
  async #executarPeloCanal(pedido: PedidoDoCanal): Promise<CallToolResult> {
    const ferramenta = this.ferramentas.get(pedido.ferramenta);
    if (!ferramenta) {
      const texto = "Ferramenta desconhecida.";
      return { isError: true, content: [{ type: "text", text: texto }], structuredContent: { erro: texto } };
    }
    this.registro.gravar({ evento: "chamada_pelo_canal", ferramenta: pedido.ferramenta });
    return ferramenta.executar(pedido.argumentos, { temTela: pedido.temTela, viaCanal: true });
  }

  /** Dono: começa a escutar o canal (uma vez). Falha ao escutar não impede a conexão: o leitor só lê. */
  async #abrirCanal(): Promise<void> {
    if (this.#canal || this.#encerrado || !this.lock.ehDono) return;
    const canal = new ServidorDoCanal({ endereco: this.enderecoDoCanal, chave: await this.#chave(), executar: (p) => this.#executarPeloCanal(p) });
    try {
      await canal.ouvir();
      this.#canal = canal;
    } catch (erro) {
      log(`[whatsapp-claude] não abri o canal para as outras sessões do Claude: ${limpar(erro instanceof Error ? erro.message : String(erro))}`);
    }
  }

  get transporte(): Transporte | null {
    return this.#transporte;
  }

  /** Pega o lock (ou vira leitor) e, se houver sessão pareada, conecta. */
  async partida(): Promise<void> {
    if (this.#encerrado) return;
    const tentativa = this.lock.tentar();
    this.#primeiraTentativa ??= tentativa.catch(() => undefined);
    const r = await tentativa;
    this.caixaPreta.definirPapel(r.dono ? "dono" : "leitor");
    if (!r.dono) {
      this.pidDoDono = r.pid;
      if (!this.#retentativa) {
        let tentando = false;
        this.#retentativa = setInterval(() => {
          if (tentando || this.#encerrado) return;
          tentando = true;
          void this.lock
            .tentar()
            .then((nova) => {
              if (!nova.dono || this.#encerrado) return;
              clearInterval(this.#retentativa);
              this.#retentativa = undefined;
              this.pidDoDono = undefined;
              this.caixaPreta.definirPapel("dono");
              return this.#ligarComRetentativa();
            })
            .catch((erro) => log(`[whatsapp-claude] não liguei: ${erro instanceof Error ? erro.message : String(erro)}`))
            .finally(() => {
              tentando = false;
            });
        }, this.#intervalo);
        this.#retentativa.unref();
      }
      await this.#varrerCanaisOrfaos();
      return;
    }
    this.pidDoDono = undefined;
    await this.#varrerCanaisOrfaos();
    await this.#ligarComRetentativa();
  }

  /**
   * 0.11.0: os `canal-*.sock` de cópias que morreram sem fechar o canal saem da pasta de dados (só os que recusam
   * conexão; o do dono vivo fica, e o deste processo ainda nem existe). Depois do lock, com o papel já valendo.
   */
  async #varrerCanaisOrfaos(): Promise<void> {
    const orfaos = await apagarCanaisOrfaos(this.config.dirDados, this.enderecoDoCanal);
    if (orfaos > 0) this.caixaPreta.registrar("canais_orfaos_apagados", { quantos: orfaos });
  }

  /** Liga; se falhar (o cofre não abriu), tenta de novo sozinho com espera crescente até 60 s. */
  async #ligarComRetentativa(): Promise<void> {
    if (this.#encerrado) return;
    try {
      await this.#ligar();
      this.#erroAoLigar = undefined;
      this.#tentativasDeLigar = 0;
    } catch (erro) {
      if (this.#encerrado) return;
      const motivo = limpar(erro instanceof Error ? erro.message : String(erro));
      this.#erroAoLigar = fraseDoCofre(motivo);
      const espera = esperaDaReconexao(this.#tentativasDeLigar++);
      log(`[whatsapp-claude] não liguei (o cofre não abriu): ${motivo} Tento de novo em ${Math.round(espera / 1000)} s.`);
      const relogio = this.#temporizador ?? RELOGIO_REAL;
      const t = relogio.setTimeout(() => void this.#ligarComRetentativa(), espera);
      t.unref?.();
      this.#religar = t;
    }
  }

  async #ligar(): Promise<void> {
    if (this.#encerrado) return;
    await this.#abrirCanal();
    this.#transporte ??= await this.#novoTransporte();
    await this.#transporte.iniciar();
  }

  async #novoTransporte(): Promise<Transporte> {
    const { banco, sessao } = await this.nucleo();
    return criarTransporte({
      banco,
      sessao,
      ...(this.#criarSocket ? { criarSocket: this.#criarSocket } : {}),
      ...(this.#temporizador ? { temporizador: this.#temporizador } : {}),
      ...(this.#esperaDigitando ? { esperaDigitandoMs: this.#esperaDigitando } : {}),
      ...(this.#buscarMidia ? { buscarMidia: this.#buscarMidia } : {}),
      caixaPreta: this.caixaPreta,
      // 0.15.1: a agenda automática fica sabendo da abertura da conexão e do fim do histórico inicial.
      aoAbrirConexao: (aposPareamento) => this.agendaAutomatica.aoAbrir(aposPareamento),
      aoTerminarHistoricoInicial: () => this.agendaAutomatica.aoTerminarHistoricoInicial(),
    });
  }

  /**
   * Só o dono da conexão escreve no WhatsApp (parear, responder, desconectar). O leitor recusa com a frase da ficha;
   * o dono sem transporte (o cofre não abriu, ou ainda está ligando) diz isso, e não que outra sessão é a dona.
   */
  exigirDono(): Transporte {
    if (!this.lock.ehDono) throw new ErroDePapel(FRASE_DO_LEITOR);
    if (!this.#transporte) {
      throw new ErroDePapel(this.#erroAoLigar ?? "A conexão com o WhatsApp ainda está começando neste computador; tente de novo em instantes.");
    }
    return this.#transporte;
  }

  /**
   * Começa o pareamento (só depois do clique no cartão do wa_parear). Sem sessão pareada, sempre com credenciais novas:
   * um transporte novo (o anterior pode ter parado por pareamento vencido ou logout) e a sessão incompleta apagada.
   * Se já há um pareamento em andamento, só devolve o estado dele.
   */
  async iniciarPareamento(): Promise<EstadoDaConexao> {
    if (this.#encerrado) throw new Error("O servidor está fechando.");
    this.exigirDono();
    const { sessao } = await this.nucleo();
    if (await sessao.pareada()) throw new Error("O WhatsApp já está pareado neste computador. Para trocar de número, use wa_desconectar antes.");
    const atual = this.#transporte?.estado();
    if (atual?.pareando && ["conectando", "aguardando_qr", "reconectando"].includes(atual.situacao)) return atual;
    await this.#transporte?.fechar();
    await sessao.limpar();
    this.#transporte = await this.#novoTransporte();
    await this.#transporte.iniciar({ parear: true });
    return this.#transporte.estado();
  }

  /**
   * Espera o pareamento em andamento chegar ao primeiro QR (ou terminar), até `limiteMs`. Só olha: nunca começa um
   * pareamento. Relógio de verdade (não o temporizador do transporte): é o tempo que o modelo fica esperando.
   */
  async esperarQr(limiteMs: number = this.esperaDoQrMs): Promise<EstadoDaConexao | undefined> {
    const fim = Date.now() + limiteMs;
    for (;;) {
      const e = this.#transporte?.estado();
      const andando = e !== undefined && ["conectando", "reconectando", "desligado"].includes(e.situacao) && !e.qr_lido;
      if (!andando || this.#encerrado || Date.now() >= fim) return e;
      await new Promise((pronto) => setTimeout(pronto, Math.min(100, Math.max(1, fim - Date.now()))));
    }
  }

  /** Fecha a conexão e solta o lock. Chamado quando o Claude Desktop fecha o servidor. */
  async encerrar(): Promise<void> {
    if (this.#encerrado) return;
    this.#encerrado = true;
    if (this.#retentativa) clearInterval(this.#retentativa);
    (this.#temporizador ?? RELOGIO_REAL).clearTimeout(this.#religar);
    this.historicoEmLote.encerrar();
    this.agendaAutomatica.encerrar();
    try {
      await this.#canal?.fechar();
      this.#canal = null;
      await this.#transporte?.fechar();
      await this.fila.liberar();
    } finally {
      this.busca.fechar();
      this.triagem.esvaziar();
      this.jeito.esvaziar();
      this.lock.liberar();
    }
  }
}
