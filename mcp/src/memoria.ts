// 0.10.0: memória das conversas (resumo por conversa e compromissos), o que dá para conferir por código.
// Quem escreve a memória é o modelo, por ferramenta (wa_anotar); aqui ficam só as funções puras que o banco e as
// ferramentas usam: a conferência da citação (cópia exata, não paráfrase), o prazo resolvido a partir da data da
// mensagem (o modelo não faz conta de calendário) e a situação do prazo. Tudo no relógio deste computador.

import type { MensagemGuardada } from "./banco.ts";

export type TipoDeCompromisso = "promessa" | "pedido" | "pergunta";
export type QuemDeve = "dono" | "outro";
export type EstadoDoCompromisso = "aberto" | "cumprido" | "cancelado";

export interface ResumoDaConversa {
  /** Escrito pela IA a partir das mensagens: anotação, nunca ordem. */
  texto: string;
  /** Data (ms) da última mensagem coberta pelo resumo. */
  ate: number;
  escrito_em: number;
}

export interface Compromisso {
  /** Curto e estável, gerado pelo servidor. */
  id: string;
  /** jid da conversa (nunca sai para o modelo). */
  conversa: string;
  tipo: TipoDeCompromisso;
  quem_deve: QuemDeve;
  /** Texto curto da IA. */
  o_que: string;
  /** Frase exata da mensagem citada (conferida na gravação). */
  citacao: string;
  /** Onde a citação foi achada: no texto ou na transcrição (que é sempre de terceiros). */
  citacao_em: "texto" | "transcricao";
  mensagem_id: string;
  mensagem_ts: number;
  mensagem_de_mim: boolean;
  /** Só em grupo, como na mensagem guardada. */
  remetente?: { nome?: string; numero?: string };
  /** 0.11.0: em grupo, quem escreveu como veio na chave (número ou LID). Nunca sai para o modelo. */
  participante?: string;
  /** Começo do dia local (ms). */
  prazo?: number;
  estado: EstadoDoCompromisso;
  criado_em: number;
  fechado_em?: number;
  evidencia_mensagem_id?: string;
}

export const TAMANHO_MAXIMO_DO_RESUMO = 2_000;
export const TAMANHO_MAXIMO_DO_O_QUE = 200;
export const TAMANHO_MAXIMO_DA_CITACAO = 300;
export const ABERTOS_POR_CONVERSA = 50;
/** Fechados há mais que isto saem na gravação seguinte. */
export const DIAS_PARA_ESQUECER_FECHADOS = 90;
export const ITENS_POR_CHAMADA = 20;
export const DIAS_MAXIMOS_DO_PRAZO_RELATIVO = 365;

const DIA_MS = 86_400_000;

/** Sequências de espaço e quebra de linha viram um espaço; aparado. Nada mais muda (nem maiúscula nem acento). */
export const normalizarEspacos = (s: string): string => s.replace(/\s+/gu, " ").trim();

/**
 * A citação está na mensagem? Pedaço exato do texto (ou da transcrição), com os espaços normalizados dos dois lados.
 * Devolve onde achou, ou undefined.
 */
export function ondeEstaACitacao(m: Pick<MensagemGuardada, "texto" | "transcricao">, citacao: string): "texto" | "transcricao" | undefined {
  const alvo = normalizarEspacos(citacao);
  if (alvo === "") return undefined;
  if (m.texto !== undefined && normalizarEspacos(m.texto).includes(alvo)) return "texto";
  if (m.transcricao !== undefined && normalizarEspacos(m.transcricao.texto).includes(alvo)) return "transcricao";
  return undefined;
}

/** Começo do dia local de uma data (ms). */
export function comecoDoDia(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** AAAA-MM-DD do dia local. */
export function dataDoDia(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const DIAS_POR_EXTENSO = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
const DIAS_CURTOS = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"];

export const diaDaSemanaPorExtenso = (ms: number): string => DIAS_POR_EXTENSO[new Date(ms).getDay()]!;

/** Diferença em dias de calendário (local) de `de` até `para`, sem tropeçar no horário de verão. */
export function diasDeCalendario(de: number, para: number): number {
  const a = new Date(de);
  const b = new Date(para);
  return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / DIA_MS);
}

export type PrazoResolvido = { ok: true; prazo: number } | { ok: false; motivo: string };

/**
 * O prazo a partir da data DA MENSAGEM citada: `AAAA-MM-DD` (data absoluta, não antes do dia da mensagem); `+Nd` (N dias
 * depois do dia da mensagem, 0 a 365); ou dia da semana `seg|ter|qua|qui|sex|sab|dom` (a próxima ocorrência DEPOIS do
 * dia da mensagem: no mesmo dia da semana, vai para a semana seguinte). Devolve o começo do dia local.
 */
export function resolverPrazo(texto: string, mensagemTs: number): PrazoResolvido {
  const p = texto.trim().toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  const base = new Date(mensagemTs);
  const [ano, mes, dia] = [base.getFullYear(), base.getMonth(), base.getDate()];
  const absoluta = /^(\d{4})-(\d{2})-(\d{2})$/.exec(p);
  if (absoluta) {
    const [a, m, d] = [Number(absoluta[1]), Number(absoluta[2]), Number(absoluta[3])];
    const data = new Date(a, m - 1, d);
    if (data.getFullYear() !== a || data.getMonth() !== m - 1 || data.getDate() !== d) return { ok: false, motivo: "data que não existe" };
    if (data.getTime() < new Date(ano, mes, dia).getTime()) return { ok: false, motivo: "prazo antes do dia da mensagem citada" };
    return { ok: true, prazo: data.getTime() };
  }
  const relativa = /^\+(\d{1,3})d$/.exec(p);
  if (relativa) {
    const n = Number(relativa[1]);
    if (n > DIAS_MAXIMOS_DO_PRAZO_RELATIVO) return { ok: false, motivo: `+Nd vai de 0 a ${DIAS_MAXIMOS_DO_PRAZO_RELATIVO}` };
    return { ok: true, prazo: new Date(ano, mes, dia + n).getTime() };
  }
  const semana = DIAS_CURTOS.indexOf(p);
  if (semana >= 0) {
    const falta = (semana - base.getDay() + 7) % 7 || 7;
    return { ok: true, prazo: new Date(ano, mes, dia + falta).getTime() };
  }
  return { ok: false, motivo: "prazo em formato desconhecido: use AAAA-MM-DD, +Nd (ex.: amanhã = +1d) ou seg, ter, qua, qui, sex, sab, dom" };
}

/** "vencido há N dias", "vence hoje", "vence em N dias". */
export function situacaoDoPrazo(prazo: number, agora: number): string {
  const n = diasDeCalendario(agora, prazo);
  if (n === 0) return "vence hoje";
  if (n < 0) return `vencido há ${-n} dia${n === -1 ? "" : "s"}`;
  return `vence em ${n} dia${n === 1 ? "" : "s"}`;
}

/** Vencido: aberto, com prazo antes de hoje. */
export const estaVencido = (c: Pick<Compromisso, "estado" | "prazo">, agora: number): boolean => c.estado === "aberto" && c.prazo !== undefined && c.prazo < comecoDoDia(agora);

/** Ordem da visão geral: com prazo antes (os vencidos primeiro, depois o mais próximo), depois sem prazo; empate pela mensagem, da mais antiga. */
export function ordemPorPrazo(a: Pick<Compromisso, "prazo" | "mensagem_ts">, b: Pick<Compromisso, "prazo" | "mensagem_ts">): number {
  if (a.prazo !== undefined && b.prazo !== undefined && a.prazo !== b.prazo) return a.prazo - b.prazo;
  if (a.prazo !== undefined && b.prazo === undefined) return -1;
  if (a.prazo === undefined && b.prazo !== undefined) return 1;
  return a.mensagem_ts - b.mensagem_ts;
}
