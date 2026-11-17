// 0.13.0: pares pergunta -> resposta do dono. O jeito (jeito.ts) mede COMO o dono escreve; aqui se acha O QUE ele
// respondeu: cada resposta dele a uma pergunta de outra pessoa é a resposta oficial dele para aquela dúvida (no dado
// real, é nos grupos que ele responde os clientes).
//
// Um PAR é uma mensagem de outra pessoa (a pergunta) e a rajada do dono que a responde. A ligação, em ordem de confiança:
// - `citada` (forte): uma mensagem do dono cita a da pessoa (`citada.id` da mensagem guardada, e a citada está guardada
//   e não é do dono). Numa rajada, cada mensagem que cita outra pergunta começa um par novo; as seguintes sem citação
//   ficam com ele.
// - `sequencia` (fraca): sem citação, a rajada vem logo depois (até 10 minutos, sem outra mensagem do dono no meio) de
//   uma mensagem de outra pessoa que termina com "?" ou tem palavra interrogativa. Em grupo, no máximo 2 mensagens de
//   terceiros entre a pergunta e a resposta. A pergunta é a mais perto da resposta.
// Rajada: as mensagens do dono seguidas em até 2 minutos, sem mensagem de outra pessoa no meio (a mesma regra do jeito).
//
// Função pura, sem banco nem relógio. Os pares NÃO são guardados em arquivo: o cache em memória do jeito (jeito.ts,
// CacheDoJeito) guarda só ids, datas e a ligação de cada par, pelo carimbo do arquivo, e esvazia no `aoApagar`.

import type { MensagemGuardada } from "./banco.ts";
import { JANELA_DA_RAJADA_MS, textosDeMaquina, type MarcaDoRascunho } from "./jeito.ts";

export type Ligacao = "citada" | "sequencia";

/** A rajada do dono vem até isto depois da pergunta (ligação por sequência). */
export const JANELA_DA_SEQUENCIA_MS = 10 * 60_000;
/** Em grupo, no máximo isto de mensagens de terceiros entre a pergunta e a resposta (ligação por sequência). */
export const TERCEIROS_NO_MEIO_EM_GRUPO = 2;
/** A resposta como sai: até tantas mensagens e tantos caracteres. */
export const MENSAGENS_POR_RESPOSTA = 6;
export const CARACTERES_POR_RESPOSTA = 800;

type ParaParear = Pick<MensagemGuardada, "id" | "ts" | "de_mim" | "texto" | "citada" | "rascunho_da_ia">;

/** Um par, sem texto: o que o cache guarda. */
export interface Par {
  /** A pergunta (mensagem de outra pessoa). */
  pergunta_id: string;
  pergunta_ts: number;
  /** As mensagens do dono que respondem, em ordem (só as com texto). */
  resposta_ids: string[];
  /** Quando a resposta começou. */
  resposta_ts: number;
  ligacao: Ligacao;
  /** A resposta tem mensagem enviada de rascunho da IA sem edição ou com edição mínima (fica fora, a não ser pedida). */
  rascunho_da_ia?: Extract<MarcaDoRascunho, "sem_edicao" | "edicao_minima">;
}

const semAcento = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** 0.14.0: as palavras interrogativas (sem acento), também para o tipo de mensagem (tipo-de-mensagem.ts). */
export const PALAVRAS_INTERROGATIVAS: readonly string[] = ["como", "quando", "onde", "qual", "quais", "quanto", "quanta", "quantos", "quantas", "pode", "podem", "tem", "consigo", "posso", "cade", "por que"];
/** Palavras que fazem de uma mensagem uma pergunta, sem acento (a ficha: como, quando, onde, qual, quanto, pode, tem, consigo, posso, cadê, por que). */
const INTERROGATIVAS = /(?:^|[^\p{L}\p{N}])(?:como|quando|onde|qual|quais|quanto|quanta|quantos|quantas|pode|podem|tem|consigo|posso|cade|por que)(?=$|[^\p{L}\p{N}])/u;
/** O fim da mensagem sem espaço, emoji e seletor de variação. */
const FIM_SEM_ENFEITE = /[\s\p{Extended_Pictographic}\p{Emoji_Modifier}️‍]+$/u;

/** A mensagem é uma pergunta? Termina com "?" (ignorando emoji e espaço no fim) ou tem palavra interrogativa. */
export function ehPergunta(texto: string | undefined): boolean {
  const t = (texto ?? "").trim();
  if (t === "") return false;
  if (t.replace(FIM_SEM_ENFEITE, "").endsWith("?")) return true;
  return INTERROGATIVAS.test(semAcento(t).replace(/\s+/gu, " "));
}

const ehDaIa = (m: ParaParear): m is ParaParear & { rascunho_da_ia: "sem_edicao" | "edicao_minima" } => m.rascunho_da_ia === "sem_edicao" || m.rascunho_da_ia === "edicao_minima";

/**
 * Os pares de UMA conversa (mensagens em ordem de data). `grupo`: vale o limite de 2 mensagens de terceiros no meio.
 * A resposta leva só as mensagens do dono com texto que não sejam de máquina (texto idêntico repetido 5+ vezes na
 * conversa, ver jeito.ts): rajada sem nenhuma assim não vira par.
 */
export function paresDe(mensagens: readonly ParaParear[], opcoes: { grupo: boolean }): Par[] {
  const deMaquina = textosDeMaquina(mensagens);
  const posicao = new Map<string, number>();
  mensagens.forEach((m, i) => {
    if (!m.de_mim) posicao.set(m.id, i);
  });
  // As rajadas do dono: [inicio, fim] (posições), sem mensagem de outra pessoa no meio, até 2 min entre uma e a próxima.
  const rajadas: Array<[number, number]> = [];
  for (let i = 0; i < mensagens.length; i++) {
    if (!mensagens[i]!.de_mim) continue;
    let fim = i;
    while (fim + 1 < mensagens.length && mensagens[fim + 1]!.de_mim && mensagens[fim + 1]!.ts - mensagens[fim]!.ts <= JANELA_DA_RAJADA_MS) fim++;
    rajadas.push([i, fim]);
    i = fim;
  }
  const pares: Par[] = [];
  const montar = (pergunta: number, de: number, ate: number, ligacao: Ligacao): void => {
    const doDono = mensagens.slice(de, ate + 1);
    const comTexto = doDono.filter((m) => {
      const t = (m.texto ?? "").trim();
      return t !== "" && !deMaquina.has(t);
    });
    if (comTexto.length === 0) return;
    const ia = doDono.find(ehDaIa);
    const p = mensagens[pergunta]!;
    pares.push({
      pergunta_id: p.id,
      pergunta_ts: p.ts,
      resposta_ids: comTexto.map((m) => m.id),
      resposta_ts: doDono[0]!.ts,
      ligacao,
      ...(ia ? { rascunho_da_ia: ia.rascunho_da_ia } : {}),
    });
  };
  for (const [inicio, fim] of rajadas) {
    // Os pedaços da rajada: um novo começa em cada mensagem que cita uma pergunta guardada de outra pessoa.
    const citadaDe = (i: number): number | undefined => {
      const id = mensagens[i]!.citada?.id;
      return id !== undefined ? posicao.get(id) : undefined;
    };
    let comeco = inicio;
    let pergunta = citadaDe(inicio);
    for (let i = inicio + 1; i <= fim + 1; i++) {
      const cita = i <= fim ? citadaDe(i) : undefined;
      if (i <= fim && (cita === undefined || cita === pergunta)) continue;
      if (pergunta !== undefined) montar(pergunta, comeco, i - 1, "citada");
      else if (comeco === inicio) {
        const achada = perguntaAntes(mensagens, inicio, opcoes.grupo);
        if (achada !== undefined) montar(achada, comeco, i - 1, "sequencia");
      }
      comeco = i;
      pergunta = cita;
    }
  }
  // A mesma pergunta ligada por citação e por sequência: fica só a citação.
  const citadas = new Set(pares.filter((p) => p.ligacao === "citada").map((p) => p.pergunta_id));
  return pares.filter((p) => p.ligacao === "citada" || !citadas.has(p.pergunta_id));
}

/** A pergunta de outra pessoa logo antes da rajada que começa em `inicio` (ligação por sequência), ou undefined. */
function perguntaAntes(mensagens: readonly ParaParear[], inicio: number, grupo: boolean): number | undefined {
  const resposta = mensagens[inicio]!.ts;
  for (let j = inicio - 1, terceiros = 0; j >= 0; j--, terceiros++) {
    const m = mensagens[j]!;
    if (m.de_mim) return undefined; // outra mensagem do dono no meio
    if (resposta - m.ts > JANELA_DA_SEQUENCIA_MS) return undefined;
    if (grupo && terceiros > TERCEIROS_NO_MEIO_EM_GRUPO) return undefined;
    if (ehPergunta(m.texto)) return j;
  }
  return undefined;
}

/** Os textos da resposta como saem: até 6 mensagens e 800 caracteres (a primeira, se sozinha passa, sai cortada). */
export function textosDaResposta(textos: readonly string[]): { mensagens: string[]; cortada: boolean } {
  const saida: string[] = [];
  let caracteres = 0;
  for (const bruto of textos) {
    const t = bruto.trim();
    const n = [...t].length;
    if (saida.length >= MENSAGENS_POR_RESPOSTA || caracteres + n > CARACTERES_POR_RESPOSTA) {
      if (saida.length === 0) saida.push(`${[...t].slice(0, CARACTERES_POR_RESPOSTA).join("")}…`);
      return { mensagens: saida, cortada: true };
    }
    saida.push(t);
    caracteres += n;
  }
  return { mensagens: saida, cortada: false };
}
