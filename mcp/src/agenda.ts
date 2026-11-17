// 0.15.1: a agenda do WhatsApp (os nomes que o dono salvou no celular) pedida de novo ao celular. O pedido em si é o
// transporte.atualizarContatos da 0.15.0; aqui ficam o que o pedido manual (wa_atualizar_contatos) e o automático têm em
// comum (o freio, as contagens, a data da última que deu certo, a caixa-preta) e o automático:
// - depois do pareamento: na primeira abertura da conexão depois de parear, quando o histórico inicial termina de chegar
//   ou 60 s depois de abrir, o que vier primeiro;
// - de tempos em tempos: na abertura da conexão, se a última bem-sucedida tem mais de 7 dias (ou nunca houve).
// Nunca por mensagem recebida. Só o dono da conexão (a leitora não tem transporte). Disparado sem esperar: não atrasa a
// partida. Respeita o mesmo freio do manual (10 min, 6 por dia, contados juntos); com o freio ou o limite do dia, não
// roda e não dá erro. Uma tentativa por abertura: falha ou tempo esgotado não derruba nada nem tenta de novo.
// Caixa-preta só com contagens (`agenda_ressincronizada`); nada de nome, número ou jid.

import { dataIso } from "./apresentacao.ts";
import type { Banco } from "./banco.ts";
import { AGENDA_AUTOMATICA_A_CADA_MS, ATUALIZACOES_DE_CONTATOS_POR_DIA, ESPERA_DA_AGENDA_DEPOIS_DO_PAREAMENTO_MS, INTERVALO_DOS_CONTATOS_MS } from "./config.ts";
import type { Contexto } from "./contexto.ts";
import { log } from "./log.ts";
import type { ResultadoDosContatos, Transporte } from "./transporte.ts";

/** Quem pediu: o automático depois de parear, o automático semanal, ou o dono (wa_atualizar_contatos). */
export type OrigemDaAgenda = "pareamento" | "periodica" | "pedido";

export interface AgendaRessincronizada {
  r: ResultadoDosContatos;
  /** Pedidos da agenda hoje, contando este. */
  hoje: number;
  conversas_que_ganharam_nome: number;
  conversas_individuais_sem_nome: number;
}

/**
 * wa_estado.contatos: a última ressincronização que terminou sem erro e a próxima automática semanal (ISO). Sem data
 * guardada, as duas são null: a automática sai na próxima abertura da conexão (ou depois do pareamento).
 */
export function datasDaAgenda(banco: Banco): { agenda_atualizada_em: string | null; proxima_automatica_em: string | null } {
  const ultima = banco.agendaAtualizadaEm();
  return {
    agenda_atualizada_em: ultima !== undefined ? dataIso(ultima) : null,
    proxima_automatica_em: ultima !== undefined ? dataIso(ultima + AGENDA_AUTOMATICA_A_CADA_MS) : null,
  };
}

/** Minutos que faltam para o freio de 10 min liberar, ou undefined se já pode pedir. */
export function minutosDoFreio(ctx: Contexto, agora: number): number | undefined {
  const ultimo = ctx.ultimaAtualizacaoDeContatos;
  if (ultimo === undefined || agora - ultimo >= INTERVALO_DOS_CONTATOS_MS) return undefined;
  return Math.ceil((INTERVALO_DOS_CONTATOS_MS - (agora - ultimo)) / 60_000);
}

/**
 * Pede a agenda ao celular e conta o que mudou. O freio e a contagem do dia só são gastos depois de o transporte conferir
 * que pode pedir (conectado, socket que permite, nenhum outro em andamento); se o limite do dia já foi, lança antes de
 * pedir. Terminou sem erro: grava a data (config.enc). Quem chama confere o freio de 10 min antes.
 */
export async function ressincronizarAgenda(ctx: Contexto, banco: Banco, t: Transporte, origem: OrigemDaAgenda): Promise<AgendaRessincronizada> {
  const agora = ctx.agora();
  const antes = banco.conversasIndividuaisSemNome();
  let hoje = 0;
  // Relógio de verdade para a duração: é quanto o celular levou.
  const inicio = Date.now();
  const r = await t.atualizarContatos(ctx.esperaDosContatosMs, () => {
    hoje = banco.reservarContagens(agora, [
      { tipo: "contatos", limite: ATUALIZACOES_DE_CONTATOS_POR_DIA, frase: `O limite de ${ATUALIZACOES_DE_CONTATOS_POR_DIA} pedidos da agenda por dia foi atingido. Nada foi pedido; o limite volta amanhã.` },
    ]).contatos;
    ctx.ultimaAtualizacaoDeContatos = agora;
  });
  const duracao = Math.max(0, Date.now() - inicio);
  const depois = banco.conversasIndividuaisSemNome();
  // A conversa guardada pelo LID que ganhou o número no caminho conta pela chave nova.
  const ganharam = [...antes].filter((jid) => {
    const chave = banco.chaveDaConversa(jid);
    return banco.entrada(chave) !== undefined && !depois.has(chave);
  }).length;
  if (r.terminou && !r.erro) banco.definirAgendaAtualizadaEm(agora);
  ctx.caixaPreta.registrar("agenda_ressincronizada", {
    origem,
    contatos_recebidos: r.contatos_recebidos,
    nomes_novos: r.nomes_novos,
    duracao_ms: duracao,
    terminou: r.terminou,
    ...(r.erro ? { com_erro: true } : {}),
  });
  return { r, hoje, conversas_que_ganharam_nome: ganharam, conversas_individuais_sem_nome: depois.size };
}

/**
 * O automático, no dono da conexão. O transporte avisa quando a conexão abre (e se é a primeira depois de parear) e
 * quando o histórico inicial termina; o resto é daqui.
 */
export class AgendaAutomatica {
  readonly #ctx: Contexto;
  /** Conta as aberturas da conexão: o automático roda no máximo uma vez em cada. */
  #abertura = 0;
  #tentadaNaAbertura = -1;
  /** Depois de parear: o prazo de 60 s, enquanto o histórico inicial não termina. */
  #prazo: unknown;
  #esperandoHistorico = false;

  constructor(ctx: Contexto) {
    this.#ctx = ctx;
  }

  /** A conexão abriu. Depois de parear, espera o histórico inicial (ou 60 s); senão, confere a semanal na hora. */
  aoAbrir(aposPareamento: boolean): void {
    const abertura = ++this.#abertura;
    this.#cancelarPrazo();
    if (!aposPareamento) {
      void this.#disparar("periodica", abertura);
      return;
    }
    this.#esperandoHistorico = true;
    const t = this.#ctx.relogio.setTimeout(() => this.#depoisDoPareamento(abertura), ESPERA_DA_AGENDA_DEPOIS_DO_PAREAMENTO_MS);
    (t as { unref?: () => void } | undefined)?.unref?.();
    this.#prazo = t;
  }

  /** O histórico inicial terminou de chegar (ou parou): se a abertura depois do pareamento esperava por ele, vai agora. */
  aoTerminarHistoricoInicial(): void {
    if (this.#esperandoHistorico) this.#depoisDoPareamento(this.#abertura);
  }

  encerrar(): void {
    this.#cancelarPrazo();
  }

  #depoisDoPareamento(abertura: number): void {
    this.#cancelarPrazo();
    void this.#disparar("pareamento", abertura);
  }

  #cancelarPrazo(): void {
    this.#esperandoHistorico = false;
    if (this.#prazo !== undefined) this.#ctx.relogio.clearTimeout(this.#prazo);
    this.#prazo = undefined;
  }

  /** Nunca lança: o que não pode rodar agora simplesmente não roda. */
  async #disparar(origem: Exclude<OrigemDaAgenda, "pedido">, abertura: number): Promise<void> {
    if (this.#tentadaNaAbertura === abertura || abertura !== this.#abertura) return;
    this.#tentadaNaAbertura = abertura;
    try {
      const ctx = this.#ctx;
      const t = ctx.transporte;
      if (!ctx.lock.ehDono || !t || t.estado().situacao !== "conectado") return;
      const { banco } = await ctx.nucleo();
      const agora = ctx.agora();
      if (origem === "periodica") {
        const ultima = banco.agendaAtualizadaEm();
        if (ultima !== undefined && agora - ultima <= AGENDA_AUTOMATICA_A_CADA_MS) return;
      }
      if (minutosDoFreio(ctx, agora) !== undefined) return;
      if (banco.contagemDoDia("contatos", agora) >= ATUALIZACOES_DE_CONTATOS_POR_DIA) return;
      await ressincronizarAgenda(ctx, banco, t, origem);
    } catch (erro) {
      // Socket sem a ressincronização, conexão que caiu, outro pedido em andamento: fica para a próxima abertura.
      log(`[whatsapp-claude] agenda automática não rodou (${erro instanceof Error ? erro.name : "erro"}).`);
    }
  }
}
