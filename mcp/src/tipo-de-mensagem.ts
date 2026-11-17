// 0.14.0: o tipo de cada RAJADA do dono, por regra (função pura). No dado real, o perfil `grupos` misturava AVISO
// (aula hoje, link, "detalhes aqui all") com RESPOSTA a cliente; para redigir resposta só interessa como ele responde.
// Ordem de teste (a primeira que vale):
// 1. `resposta`: a rajada faz parte de um par pergunta -> resposta (pares.ts), cita mensagem guardada de outra pessoa,
//    ou (conversa individual) começa até 10 minutos depois de uma mensagem recebida (a anterior a ela).
// 2. `aviso` (só em grupo): tem link; ou menção a todos ("all" em qualquer lugar, @todos/@all, ou começa com todos,
//    pessoal ou galera); ou horário/data ("hoje às", "19h", "19:30", "amanhã", dia da semana, "20/11") com mais de 15
//    palavras; ou é a primeira do dono depois de 6 h sem ele falar na conversa e tem mais de 25 palavras. (Encaminhada
//    não entra: a mensagem guardada não traz esse dado.)
// 3. `pergunta`: termina com "?" (ignorando emoji no fim) ou começa com palavra interrogativa.
// 4. `confirmacao`: até 3 palavras, todas de fecho ou concordância (o vocabulário da triagem, mais sim, isso, pode,
//    exato, show), ou só emoji.
// 5. `outra`.
// A rajada aqui leva TODAS as mensagens do dono seguidas em até 2 minutos sem mensagem de outra pessoa no meio (com
// link, áudio e rascunho da IA também): o tipo é da rajada inteira. O resultado fica no cache do jeito, nunca em arquivo.

import type { MensagemGuardada } from "./banco.ts";
import { JANELA_DA_RAJADA_MS, palavrasDe, temLink } from "./jeito.ts";
import { JANELA_DA_SEQUENCIA_MS, PALAVRAS_INTERROGATIVAS, paresDe } from "./pares.ts";
import { ehPalavraDeFechoOuConcordancia } from "./triagem.ts";

export const TIPOS_DE_MENSAGEM = ["resposta", "aviso", "pergunta", "confirmacao", "outra"] as const;
export type TipoDeMensagem = (typeof TIPOS_DE_MENSAGEM)[number];

/** Silêncio do dono que faz da mensagem seguinte, se longa, um aviso. */
export const SILENCIO_DO_AVISO_MS = 6 * 3_600_000;
export const PALAVRAS_DO_AVISO_COM_DATA = 15;
export const PALAVRAS_DO_AVISO_DEPOIS_DO_SILENCIO = 25;
export const PALAVRAS_DA_CONFIRMACAO = 3;

type ParaClassificar = Pick<MensagemGuardada, "id" | "ts" | "de_mim" | "texto" | "citada" | "rascunho_da_ia" | "tipo">;

export interface RajadaClassificada {
  /** As posições (na lista da conversa) de todas as mensagens do dono da rajada, em ordem. */
  posicoes: number[];
  inicio: number;
  tipo: TipoDeMensagem;
}

const semAcento = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const FIM_SEM_ENFEITE = /[\s\p{Extended_Pictographic}\p{Emoji_Modifier}️‍]+$/u;
const MENCAO_A_TODOS = /(?:^|[^\p{L}\p{N}@])(?:@todos|@all|all)(?=$|[^\p{L}\p{N}])/u;
const COMECA_CHAMANDO_TODOS = /^(?:todos|pessoal|galera)(?=$|[^\p{L}\p{N}])/u;
const HORARIO_OU_DATA =
  /(?:^|[^\p{L}\p{N}])(?:hoje as|amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo|\d{1,2}h(?:\d{2})?|\d{1,2}:\d{2}|\d{1,2}\/\d{1,2})(?=$|[^\p{L}\p{N}])/u;

/** As rajadas do dono, com todas as mensagens dele (a mesma regra de continuidade do jeito e dos pares). */
function rajadasInteiras(mensagens: readonly ParaClassificar[]): Array<{ posicoes: number[]; inicio: number }> {
  const saida: Array<{ posicoes: number[]; inicio: number }> = [];
  for (let i = 0; i < mensagens.length; i++) {
    if (!mensagens[i]!.de_mim) continue;
    const posicoes = [i];
    while (posicoes.at(-1)! + 1 < mensagens.length && mensagens[posicoes.at(-1)! + 1]!.de_mim && mensagens[posicoes.at(-1)! + 1]!.ts - mensagens[posicoes.at(-1)!]!.ts <= JANELA_DA_RAJADA_MS) {
      posicoes.push(posicoes.at(-1)! + 1);
    }
    saida.push({ posicoes, inicio: mensagens[i]!.ts });
    i = posicoes.at(-1)!;
  }
  return saida;
}

/** Começa com palavra interrogativa (sem acento)? */
function comecaPerguntando(texto: string): boolean {
  const t = semAcento(texto).replace(/^[^\p{L}\p{N}]+/u, "").replace(/\s+/gu, " ");
  return PALAVRAS_INTERROGATIVAS.some((p) => t === p || t.startsWith(`${p} `) || t.startsWith(`${p}?`) || t.startsWith(`${p},`));
}

/** O tipo de uma rajada já sem as regras de resposta (aviso, pergunta, confirmação, outra). Exportada para os testes. */
export function tipoPeloTexto(textos: readonly string[], opcoes: { grupo: boolean; depoisDoSilencio: boolean }): Exclude<TipoDeMensagem, "resposta"> {
  const junto = textos.join("\n").trim();
  const palavras = palavrasDe(junto).length;
  const n = semAcento(junto);
  if (opcoes.grupo && junto !== "") {
    if (temLink(junto)) return "aviso";
    if (MENCAO_A_TODOS.test(n) || COMECA_CHAMANDO_TODOS.test(n.replace(/^[^\p{L}\p{N}@]+/u, ""))) return "aviso";
    if (palavras > PALAVRAS_DO_AVISO_COM_DATA && HORARIO_OU_DATA.test(n)) return "aviso";
    if (opcoes.depoisDoSilencio && palavras > PALAVRAS_DO_AVISO_DEPOIS_DO_SILENCIO) return "aviso";
  }
  if (junto !== "") {
    const ultimo = (textos.at(-1) ?? "").trim().replace(FIM_SEM_ENFEITE, "");
    if (ultimo.endsWith("?") || comecaPerguntando(textos[0] ?? "")) return "pergunta";
    const tokens = n.match(/\p{L}+/gu) ?? [];
    if (tokens.length === 0 && /\p{Extended_Pictographic}/u.test(junto)) return "confirmacao";
    if (tokens.length > 0 && tokens.length <= PALAVRAS_DA_CONFIRMACAO && tokens.every(ehPalavraDeFechoOuConcordancia)) return "confirmacao";
  }
  return "outra";
}

/** Classifica as rajadas do dono de UMA conversa (mensagens em ordem de data). Pura. */
export function classificarRajadas(mensagens: readonly ParaClassificar[], opcoes: { grupo: boolean }): RajadaClassificada[] {
  const respostas = new Set(paresDe(mensagens, opcoes).flatMap((p) => p.resposta_ids));
  const deOutraPessoa = new Set(mensagens.filter((m) => !m.de_mim).map((m) => m.id));
  let ultimaDoDono: number | null = null;
  return rajadasInteiras(mensagens).map(({ posicoes, inicio }) => {
    const doDono = posicoes.map((i) => mensagens[i]!);
    const depoisDoSilencio = ultimaDoDono === null || inicio - ultimaDoDono >= SILENCIO_DO_AVISO_MS;
    ultimaDoDono = doDono.at(-1)!.ts;
    const anterior = mensagens[posicoes[0]! - 1];
    const resposta =
      doDono.some((m) => respostas.has(m.id) || (m.citada !== undefined && deOutraPessoa.has(m.citada.id))) ||
      (!opcoes.grupo && anterior !== undefined && !anterior.de_mim && inicio - anterior.ts <= JANELA_DA_SEQUENCIA_MS);
    if (resposta) return { posicoes, inicio, tipo: "resposta" as const };
    const textos = doDono.map((m) => (m.texto ?? "").trim()).filter((t) => t !== "");
    return { posicoes, inicio, tipo: tipoPeloTexto(textos, { grupo: opcoes.grupo, depoisDoSilencio }) };
  });
}
