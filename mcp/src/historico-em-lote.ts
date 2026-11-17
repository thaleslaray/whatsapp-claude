// 0.13.0: encher uma conversa (sobretudo um grupo recém-escolhido) de histórico sem 30 chamadas manuais.
// O wa_buscar_historico com `ate_total` liga aqui um TRABALHO em segundo plano, no dono da conexão: repete o pedido de
// até 50 mensagens ao celular, respeitando os 30 s entre pedidos da mesma conversa (o mesmo `ultimoHistorico` do pedido
// avulso) e o limite de pedidos do dia (configurável, WA_PEDIDOS_DE_HISTORICO_POR_DIA), até:
// - a conversa ter `ate_total` mensagens guardadas (alvo_atingido) ou bater o teto por conversa (teto_da_conversa);
// - o celular parar de responder (2 pedidos seguidos sem resposta: celular_nao_respondeu);
// - não vir mais nada antigo (o celular respondeu sem nada novo: nada_mais_antigo);
// - acabar o limite do dia (limite_do_dia);
// - desconectar (desconectou), a conversa sair (bloqueada, grupo tirado ou apagada: conversa_saiu) ou o processo
//   encerrar (encerrado).
// Um trabalho por conversa por vez; no máximo 2 conversas em paralelo (a terceira é recusada, com a frase). A chamada
// volta na hora; chamar de novo com os mesmos argumentos devolve o progresso (e, depois de terminado, o resultado uma
// vez; a chamada seguinte começa um trabalho novo). Tudo só na memória: se o processo fechar no meio, o trabalho some
// (o que já chegou fica guardado; as contagens do dia ficam no banco).
// Caixa-preta e registro de ações: só contagens (pedidos, novas, o motivo da parada), nunca jid, id, número ou texto.
//
// 0.13.1, experimento: GRUPO ESCOLHIDO sem mensagem guardada. O pedido ao celular (`fetchMessageHistory` da Baileys
// rc14, lib/Socket/messages-recv.js:40-55) leva como âncora a chave e a data da mensagem mais antiga guardada; sem
// nenhuma, não havia de onde partir. Agora o pedido usa uma âncora SINTÉTICA, uma variação por pedido, em rodízio:
// - `agora_de_mim`: id novo no formato dos ids deste cliente ("3EB0" + 18 hex, como `generateMessageIDV2`,
//   lib/Utils/generics.js:134-149), de mim, data de agora;
// - `agora_de_outro`: id novo, de outra pessoa, data de agora. O `HistorySyncOnDemandRequest` (WAProto.proto:3065-3072)
//   não tem campo de participante e o `fetchMessageHistory` não lê `participant`: não há o que pôr;
// - `sem_id`: id vazio, data de agora. O proto aceita e manda o campo presente e vazio (conferido com o encode).
// O que chega passa pelos filtros de sempre e é gravado como histórico (sem não lidas). A partir da primeira mensagem
// guardada, a âncora é a real. No `ate_total`, se cada variação falhar uma vez (silêncio ou resposta vazia), o trabalho
// para (`sem_partida`) sem gastar mais pedidos do dia. Caixa-preta: `historico_sem_partida` com o nome da variação, o
// resultado e contagens.

import { randomBytes } from "node:crypto";
import type { Banco } from "./banco.ts";
import { INTERVALO_DO_HISTORICO_MS } from "./config.ts";
import type { ChaveDeMensagem, ResultadoDoHistorico, Temporizador, Transporte, VariacaoDoHistorico } from "./transporte.ts";

/** 0.13.1: as âncoras sintéticas (grupo escolhido sem mensagem guardada), na ordem do rodízio. */
export const ANCORAS_SINTETICAS = ["agora_de_mim", "agora_de_outro", "sem_id"] as const;
export type AncoraSintetica = (typeof ANCORAS_SINTETICAS)[number];
export type TipoDeAncora = "real" | AncoraSintetica;
/** O que o celular fez com um pedido: mandou mensagens, respondeu vazio, ficou em silêncio, ou o pedido nem saiu. */
export type ResultadoDoCelular = "com_mensagens" | "vazio" | "silencio" | "nao_saiu";

/** Um id no formato dos que este cliente gera ("3EB0" + 18 hex maiúsculos, como `generateMessageIDV2` da Baileys). */
export const idNoFormatoDoCliente = (): string => `3EB0${randomBytes(9).toString("hex").toUpperCase()}`;

/** A âncora sintética de uma variação, com a data de `agora`. */
export function ancoraSintetica(tipo: AncoraSintetica, agora: number): ChaveDeMensagem & { ts: number } {
  if (tipo === "agora_de_mim") return { id: idNoFormatoDoCliente(), de_mim: true, ts: agora };
  if (tipo === "agora_de_outro") return { id: idNoFormatoDoCliente(), de_mim: false, ts: agora };
  return { id: "", de_mim: false, ts: agora };
}

export const resultadoDoCelular = (r: { chegou: boolean; recebidas: number; diagnostico: { pedido_enviado: boolean } }): ResultadoDoCelular =>
  !r.diagnostico.pedido_enviado ? "nao_saiu" : !r.chegou ? "silencio" : r.recebidas > 0 ? "com_mensagens" : "vazio";

/** A conversa é um grupo escolhido sem mensagem guardada (o único caso de âncora sintética)? */
export const grupoEscolhidoVazio = (banco: Banco, jid: string): boolean => jid.endsWith("@g.us") && banco.grupoPermitido(jid) && banco.lerMensagens(jid).length === 0;

/** O alvo máximo de mensagens guardadas que um trabalho pode pedir. */
export const MAXIMO_DO_ATE_TOTAL = 2_000;
/** Conversas buscando histórico ao mesmo tempo. */
export const TRABALHOS_EM_PARALELO = 2;
/** Pedidos seguidos sem resposta do celular antes de parar (cada um, no modo auto, tenta outra variação). */
export const SEM_RESPOSTA_PARA_PARAR = 2;
/** De quantos em quantos pedidos o progresso vai para a caixa-preta (além do começo e do fim). */
const PROGRESSO_NA_CAIXA_A_CADA = 10;

export type MotivoDaParada =
  | "alvo_atingido"
  | "teto_da_conversa"
  | "celular_nao_respondeu"
  | "nada_mais_antigo"
  | "limite_do_dia"
  | "desconectou"
  | "conversa_saiu"
  | "sem_partida"
  | "encerrado"
  | "erro";

export const FRASE_DA_PARADA: Record<MotivoDaParada, string> = {
  alvo_atingido: "a conversa chegou ao total pedido de mensagens guardadas",
  teto_da_conversa: "a conversa chegou ao teto de mensagens guardadas por conversa",
  celular_nao_respondeu: `o celular não respondeu ${SEM_RESPOSTA_PARA_PARAR} pedidos seguidos (pode estar sem internet, ou o WhatsApp não atender este pedido)`,
  nada_mais_antigo: "o celular respondeu sem nada mais antigo (pode não haver mensagens anteriores)",
  limite_do_dia: "acabou o limite de pedidos de histórico do dia (volta amanhã; o dono pode subir no campo da extensão)",
  desconectou: "o WhatsApp desconectou",
  conversa_saiu: "a conversa saiu do que o Claude pode ler (bloqueada, grupo tirado ou apagada)",
  sem_partida: "o celular não atendeu pedido sem mensagem de partida (cada âncora sintética foi tentada uma vez)",
  encerrado: "o servidor fechou",
  erro: "um pedido falhou sem motivo conhecido",
};

export interface ProgressoDoHistorico {
  situacao: "em_andamento" | "terminado";
  ate_total: number;
  pedidas_por_vez: number;
  guardadas_agora: number;
  pedidos_feitos: number;
  mensagens_novas: number;
  cortadas_pelo_teto: number;
  pedidos_sem_resposta: number;
  iniciado_em: number;
  proximo_pedido_em?: number;
  terminado_em?: number;
  parou_porque?: MotivoDaParada;
  /** 0.13.1: a âncora do último pedido ("real" ou a sintética). */
  ancora_do_ultimo_pedido?: TipoDeAncora;
  /** 0.13.1: cada pedido feito com âncora sintética e o que o celular fez. */
  pedidos_sem_partida: Array<{ ancora: AncoraSintetica; variacao: VariacaoDoHistorico; resultado: ResultadoDoCelular; recebidas: number }>;
}

/** O que o trabalho precisa do resto do servidor (o Contexto e a ferramenta montam). */
export interface DependenciasDoTrabalho {
  banco: Banco;
  /** O transporte de agora (pode trocar ou sumir). */
  transporte: () => Transporte | null;
  /** O ponto de partida do próximo pedido: a mais antiga guardada (ou undefined). */
  ancora: (jid: string) => (ChaveDeMensagem & { ts: number }) | undefined;
  /** 0.13.1: as âncoras sintéticas a tentar, em ordem, se a conversa for grupo escolhido vazio (uma tentativa de cada). */
  sinteticas: readonly AncoraSintetica[];
  /** 0.13.1: avisado a cada pedido com âncora sintética (o rodízio do modo auto e a caixa-preta). */
  aoPedirSemPartida?: (ancora: AncoraSintetica, r: ResultadoDoHistorico) => void;
  /** Último pedido de histórico de cada conversa (o mesmo do pedido avulso). */
  ultimoPedido: Map<string, number>;
  limiteDoDia: number;
  /** Relógio do dia (as contagens do banco). */
  agoraDoDia: () => number;
  esperaMs: number;
}

interface Trabalho {
  jid: string;
  pedida: VariacaoDoHistorico | "auto";
  progresso: ProgressoDoHistorico;
  cancelado: boolean;
  acordar: () => void;
}

interface Observadores {
  relogio: Pick<Temporizador, "setTimeout" | "clearTimeout" | "agora">;
  caixaPreta?: { registrar(evento: string, campos?: Record<string, unknown>): void };
  registro?: { gravar(evento: Record<string, unknown>): void };
}

export class ErroDoTrabalho extends Error {
  override name = "ErroDoTrabalho";
}

export class TrabalhosDeHistorico {
  readonly #obs: Observadores;
  readonly #trabalhos = new Map<string, Trabalho>();
  #encerrado = false;

  constructor(obs: Observadores) {
    this.#obs = obs;
  }

  /** Quantos trabalhos estão andando agora. */
  get andando(): number {
    return [...this.#trabalhos.values()].filter((t) => t.progresso.situacao === "em_andamento").length;
  }

  /** Há um trabalho andando nesta conversa? */
  andandoEm(jid: string): boolean {
    return this.#trabalhos.get(jid)?.progresso.situacao === "em_andamento";
  }

  /**
   * Começa um trabalho (ou devolve o que já existe nesta conversa). Terminado: devolve o resultado uma vez e esquece.
   * Mais de 2 andando: recusa com a frase. `novo` diz se começou agora; `alvo_do_existente` vem quando o que já anda tem
   * outro `ate_total`.
   */
  pedir(jid: string, alvo: number, quantidade: number, pedida: VariacaoDoHistorico | "auto", deps: DependenciasDoTrabalho): { progresso: ProgressoDoHistorico; novo: boolean } {
    if (this.#encerrado) throw new ErroDoTrabalho("O servidor está fechando.");
    const existente = this.#trabalhos.get(jid);
    if (existente) {
      if (existente.progresso.situacao === "terminado") this.#trabalhos.delete(jid);
      return { progresso: { ...existente.progresso, pedidos_sem_partida: [...existente.progresso.pedidos_sem_partida] }, novo: false };
    }
    if (this.andando >= TRABALHOS_EM_PARALELO) {
      throw new ErroDoTrabalho(`Já há ${TRABALHOS_EM_PARALELO} conversas buscando histórico em segundo plano (o máximo ao mesmo tempo). Espere uma terminar (chame de novo com os argumentos dela para ver o progresso) e peça esta depois.`);
    }
    const t: Trabalho = {
      jid,
      pedida,
      cancelado: false,
      acordar: () => {},
      progresso: {
        situacao: "em_andamento",
        ate_total: alvo,
        pedidas_por_vez: quantidade,
        guardadas_agora: deps.banco.lerMensagens(jid).length,
        pedidos_feitos: 0,
        mensagens_novas: 0,
        cortadas_pelo_teto: 0,
        pedidos_sem_resposta: 0,
        pedidos_sem_partida: [],
        iniciado_em: this.#obs.relogio.agora(),
      },
    };
    this.#trabalhos.set(jid, t);
    this.#obs.caixaPreta?.registrar("historico_em_lote", { fase: "comecou", ate_total: alvo, guardadas: t.progresso.guardadas_agora, andando: this.andando });
    this.#obs.registro?.gravar({ evento: "historico_em_lote", fase: "comecou", ate_total: alvo });
    // Roda até o primeiro `await` aqui mesmo: o que já está decidido (alvo atingido, desconectado) sai nesta chamada.
    void this.#rodar(t, deps, quantidade);
    if (t.progresso.situacao === "terminado") this.#trabalhos.delete(jid);
    return { progresso: { ...t.progresso, pedidos_sem_partida: [...t.progresso.pedidos_sem_partida] }, novo: true };
  }

  /** O Banco apagou algo (conversa, tudo): cada trabalho acorda e confere se a conversa dele ainda vale. */
  acordar(): void {
    for (const t of this.#trabalhos.values()) t.acordar();
  }

  /** Encerrar: para todos (o que já chegou fica guardado) e não aceita mais nenhum. */
  encerrar(): void {
    this.#encerrado = true;
    for (const t of this.#trabalhos.values()) {
      t.cancelado = true;
      t.acordar();
    }
  }

  #esperar(t: Trabalho, ms: number): Promise<void> {
    return new Promise((pronto) => {
      const h = this.#obs.relogio.setTimeout(() => {
        t.acordar = () => {};
        pronto();
      }, ms);
      h.unref?.();
      t.acordar = () => {
        this.#obs.relogio.clearTimeout(h);
        t.acordar = () => {};
        pronto();
      };
    });
  }

  /** Por que parar agora (undefined: segue). Atualiza `guardadas_agora`. */
  #motivo(t: Trabalho, d: DependenciasDoTrabalho): MotivoDaParada | undefined {
    if (t.cancelado || this.#encerrado) return "encerrado";
    // 0.13.1: grupo escolhido sem mensagem guardada ainda não tem entrada no índice, e vale.
    if (!d.banco.aceitaGravar(t.jid) || (!d.banco.entrada(t.jid) && !(t.jid.endsWith("@g.us") && d.banco.grupoPermitido(t.jid)))) return "conversa_saiu";
    const tr = d.transporte();
    if (!tr || tr.estado().situacao !== "conectado") return "desconectou";
    const guardadas = d.banco.lerMensagens(t.jid).length;
    t.progresso.guardadas_agora = guardadas;
    if (guardadas >= t.progresso.ate_total) return "alvo_atingido";
    if (guardadas >= d.banco.maxMensagens) return "teto_da_conversa";
    if (!d.ancora(t.jid) && !grupoEscolhidoVazio(d.banco, t.jid)) return "conversa_saiu";
    return undefined;
  }

  async #rodar(t: Trabalho, d: DependenciasDoTrabalho, quantidade: number): Promise<void> {
    const p = t.progresso;
    let motivo: MotivoDaParada | undefined;
    let semRespostaSeguidas = 0;
    const sinteticasTentadas = new Set<AncoraSintetica>();
    try {
      for (;;) {
        motivo = this.#motivo(t, d);
        if (motivo) break;
        const ultimo = d.ultimoPedido.get(t.jid);
        const falta = ultimo === undefined ? 0 : INTERVALO_DO_HISTORICO_MS - (this.#obs.relogio.agora() - ultimo);
        // 0.13.1: sem mensagem guardada, a próxima âncora sintética ainda não tentada; acabaram: para sem gastar pedido.
        const sintetica = d.ancora(t.jid) ? undefined : d.sinteticas.find((x) => !sinteticasTentadas.has(x));
        if (!d.ancora(t.jid) && sintetica === undefined) {
          motivo = "sem_partida";
          break;
        }
        if (falta > 0) {
          p.proximo_pedido_em = this.#obs.relogio.agora() + falta;
          await this.#esperar(t, falta);
          continue; // acordado antes da hora (o Banco apagou algo, ou encerrou): confere tudo de novo
        }
        delete p.proximo_pedido_em;
        if (d.banco.contagemDoDia("historico", d.agoraDoDia()) >= d.limiteDoDia) {
          motivo = "limite_do_dia";
          break;
        }
        const tr = d.transporte()!;
        const variacao = await tr.variacaoDoHistorico(t.jid, t.pedida);
        if ((motivo = this.#motivo(t, d))) break;
        try {
          d.banco.reservarContagens(d.agoraDoDia(), [{ tipo: "historico", limite: d.limiteDoDia, frase: "limite do dia" }]);
        } catch (erro) {
          if (d.banco.contagemDoDia("historico", d.agoraDoDia()) >= d.limiteDoDia) {
            motivo = "limite_do_dia";
            break;
          }
          throw erro;
        }
        d.ultimoPedido.set(t.jid, this.#obs.relogio.agora());
        const ancora = sintetica ? ancoraSintetica(sintetica, this.#obs.relogio.agora()) : d.ancora(t.jid)!;
        p.ancora_do_ultimo_pedido = sintetica ?? "real";
        const r = await tr.buscarHistorico(t.jid, quantidade, ancora, d.esperaMs, variacao);
        if (sintetica) {
          sinteticasTentadas.add(sintetica);
          p.pedidos_sem_partida.push({ ancora: sintetica, variacao, resultado: resultadoDoCelular(r), recebidas: r.recebidas });
          try {
            d.aoPedirSemPartida?.(sintetica, r);
          } catch {
            /* o aviso nunca para o trabalho */
          }
        }
        p.pedidos_feitos++;
        p.mensagens_novas += r.novas;
        p.cortadas_pelo_teto += r.cortadas;
        if (p.pedidos_feitos % PROGRESSO_NA_CAIXA_A_CADA === 0) {
          this.#obs.caixaPreta?.registrar("historico_em_lote", { fase: "andando", pedidos: p.pedidos_feitos, novas: p.mensagens_novas, sem_resposta: p.pedidos_sem_resposta });
        }
        // Antes de ler o resultado: a conversa pode ter saído, a conexão caído ou o alvo chegado com este pedido.
        if ((motivo = this.#motivo(t, d))) break;
        if (sintetica) {
          // Sem partida: silêncio ou resposta vazia não contam para as outras paradas; a próxima variação é tentada.
          if (r.novas === 0) {
            if (!r.chegou) p.pedidos_sem_resposta++;
            continue;
          }
          semRespostaSeguidas = 0;
          continue; // chegou mensagem: daqui em diante, a âncora é a real
        }
        if (!r.chegou) {
          p.pedidos_sem_resposta++;
          if (++semRespostaSeguidas >= SEM_RESPOSTA_PARA_PARAR) {
            motivo = "celular_nao_respondeu";
            break;
          }
          continue;
        }
        semRespostaSeguidas = 0;
        if (r.cortadas > 0) {
          motivo = "teto_da_conversa";
          break;
        }
        if (r.novas === 0) {
          motivo = "nada_mais_antigo";
          break;
        }
      }
    } catch {
      // O pedido falhou (conexão caiu no meio, conversa saiu): o motivo de agora, se houver; senão "erro". Sem a
      // mensagem do erro (ela pode trazer jid).
      try {
        motivo = this.#motivo(t, d) ?? "erro";
      } catch {
        motivo = t.cancelado || this.#encerrado ? "encerrado" : "erro";
      }
    }
    p.situacao = "terminado";
    p.parou_porque = motivo ?? "erro";
    p.terminado_em = this.#obs.relogio.agora();
    delete p.proximo_pedido_em;
    const contagens = { pedidos: p.pedidos_feitos, novas: p.mensagens_novas, cortadas: p.cortadas_pelo_teto, sem_resposta: p.pedidos_sem_resposta, guardadas: p.guardadas_agora, motivo: p.parou_porque };
    this.#obs.caixaPreta?.registrar("historico_em_lote", { fase: "parou", ...contagens });
    this.#obs.registro?.gravar({ evento: "historico_em_lote", fase: "parou", ...contagens });
  }
}
