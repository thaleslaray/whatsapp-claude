// 0.9.0: blocos de conversa por silêncio. Mensagem de WhatsApp é curta: o que importa costuma estar espalhado em duas
// ou três mensagens seguidas ("te mando o contrato" / "amanhã cedo"). Um bloco junta as mensagens seguidas de uma
// conversa até um silêncio maior que SILENCIO_ENTRE_BLOCOS_MS. Usado pela busca (índice e varredura) e pelo
// `em_volta_de` do wa_ler_conversa. Função pura: não lê banco nem relógio.

import type { MensagemGuardada } from "./banco.ts";

/** Intervalo máximo entre uma mensagem e a próxima para continuarem no mesmo bloco (inclusive). */
export const SILENCIO_ENTRE_BLOCOS_MS = 15 * 60_000;
/** Bloco maior que isto é dividido em sequência (sem sobreposição): um resultado de busca não vira a conversa inteira. */
export const MAXIMO_DE_MENSAGENS_POR_BLOCO = 20;
export const MAXIMO_DE_CARACTERES_POR_BLOCO = 2_000;

/** Um bloco: posições na lista de mensagens da conversa (`fim` inclusive). */
export interface Bloco {
  inicio: number;
  fim: number;
}

/** Os textos indexáveis de uma mensagem (texto, transcrição e nome de arquivo), na ordem em que vão para o bloco. */
export const textosDe = (m: Pick<MensagemGuardada, "texto" | "midia" | "transcricao">): string[] =>
  [m.texto ?? "", m.transcricao?.texto ?? "", m.midia?.nome ?? ""].filter((t) => t !== "");

const tamanhoDe = (m: Pick<MensagemGuardada, "texto" | "midia" | "transcricao">): number => textosDe(m).reduce((n, t) => n + t.length, 0);

/**
 * Divide as mensagens (já em ordem de data, como o Banco guarda) em blocos. Todas entram em algum bloco, inclusive as
 * sem texto (figurinha, mídia sem legenda): contam no tamanho do bloco em mensagens, não em caracteres. Uma mensagem
 * sozinha maior que o limite de caracteres fica num bloco só dela.
 * `porTamanho: false` corta só pelo silêncio: é o bloco que o `em_volta_de` abre (com o teto dele, de 40), já que o
 * corte por tamanho existe para a busca não devolver um resultado do tamanho da conversa.
 */
export function dividirEmBlocos(mensagens: ReadonlyArray<Pick<MensagemGuardada, "ts" | "texto" | "midia" | "transcricao">>, opcoes: { porTamanho?: boolean } = {}): Bloco[] {
  const porTamanho = opcoes.porTamanho ?? true;
  const blocos: Bloco[] = [];
  let inicio = 0;
  let caracteres = 0;
  for (let i = 0; i < mensagens.length; i++) {
    const m = mensagens[i]!;
    const tamanho = tamanhoDe(m);
    if (i > inicio) {
      const silencio = m.ts - mensagens[i - 1]!.ts > SILENCIO_ENTRE_BLOCOS_MS;
      const cheio = porTamanho && (i - inicio >= MAXIMO_DE_MENSAGENS_POR_BLOCO || caracteres + tamanho > MAXIMO_DE_CARACTERES_POR_BLOCO);
      if (silencio || cheio) {
        blocos.push({ inicio, fim: i - 1 });
        inicio = i;
        caracteres = 0;
      }
    }
    caracteres += tamanho;
  }
  if (mensagens.length > 0) blocos.push({ inicio, fim: mensagens.length - 1 });
  return blocos;
}

/** O bloco que contém a posição `i` (ou undefined fora da lista). */
export const blocoDa = (blocos: readonly Bloco[], i: number): Bloco | undefined => blocos.find((b) => i >= b.inicio && i <= b.fim);
