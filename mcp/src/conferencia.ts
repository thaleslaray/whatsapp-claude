// 0.14.0: conferir um rascunho contra o jeito medido do dono, só com contas (função pura). Usado pelo
// wa_conferir_rascunho antes de abrir o cartão. Desvio é aviso, não proibição. O texto do rascunho não é guardado.
// Cada regra compara uma medida do rascunho com a mesma medida da amostra do dono:
// - palavras: alguma mensagem com mais palavras que o p90 dele;
// - inicial: começa com maiúscula e ele começa com minúscula em 60%+ (ou minúscula e ele com maiúscula em 80%+);
// - ponto final: termina com ponto e ele usa em menos de 10%;
// - emoji: tem emoji e ele usa em menos de 10% das mensagens, ou um emoji que ele nunca usou;
// - exclamação: tem "!" e ele termina com "!" em menos de 5%;
// - saudação e fecho: abre ou fecha com uma saudação ou fecho que não está entre as aberturas e fechos dele;
// - quebra: uma mensagem só com mais de 20 palavras, e ele quebra em 2+ mensagens em 40%+ das rajadas longas (3+);
// - formalidade: "prezado", "atenciosamente", "cordialmente", "fico à disposição", "espero que esteja bem", se ele
//   nunca usou (quem chama confere nas mensagens dele e passa as que ele usou).

import { emojisDe, FECHOS, palavrasDe, percentil90, SAUDACOES, type AmostraDoJeito } from "./jeito.ts";

export const FORMALIDADES = ["prezado", "prezada", "atenciosamente", "cordialmente", "fico a disposicao", "espero que esteja bem"] as const;
export const MINIMO_DE_RAJADAS_LONGAS = 3;

export interface Desvio {
  medida: string;
  rascunho: number | string;
  normal_do_dono: number | string;
  frase: string;
}

const semAcento = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const limparPonta = (p: string): string => p.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
const palavrasLimpas = (t: string): string[] => palavrasDe(t).map(limparPonta).filter((p) => p !== "").map(semAcento);
const pct = (x: number): string => `${Math.round(x * 100)}%`;
const fracao = (parte: number, todo: number): number => (todo === 0 ? 0 : parte / todo);

/** As formalidades que aparecem num texto (sem acento). */
export function formalidadesNo(texto: string): string[] {
  const n = ` ${semAcento(texto).replace(/[^\p{L}\p{N}]+/gu, " ")} `;
  return FORMALIDADES.filter((f) => n.includes(` ${f} `));
}

/** Os desvios do rascunho (uma ou várias mensagens) em relação à amostra do dono. */
export function conferirContraOJeito(textos: readonly string[], a: AmostraDoJeito, formalidadesDoDono: ReadonlySet<string>): Desvio[] {
  const desvios: Desvio[] = [];
  const limpos = textos.map((t) => t.trim()).filter((t) => t !== "");
  if (limpos.length === 0 || a.mensagens === 0) return desvios;
  const n = a.mensagens;

  // Tamanho.
  const p90 = percentil90(a.palavras);
  const maior = Math.max(...limpos.map((t) => palavrasDe(t).length));
  if (p90 > 0 && maior > p90) desvios.push({ medida: "palavras_por_mensagem", rascunho: maior, normal_do_dono: p90, frase: `Uma mensagem do rascunho tem ${maior} palavras; 90% das mensagens do dono têm até ${p90}.` });

  // Caixa da primeira letra.
  const letra = /\p{L}/u.exec(limpos[0]!)?.[0];
  if (letra && a.comLetra > 0) {
    const minuscula = fracao(a.comecaMinuscula, a.comLetra);
    if (/\p{Lu}/u.test(letra) && minuscula >= 0.6) desvios.push({ medida: "inicial_maiuscula", rascunho: "maiúscula", normal_do_dono: `minúscula em ${pct(minuscula)}`, frase: `O dono começa com letra minúscula em ${pct(minuscula)} das mensagens; o rascunho começa com maiúscula.` });
    if (/\p{Ll}/u.test(letra) && 1 - minuscula >= 0.8) desvios.push({ medida: "inicial_minuscula", rascunho: "minúscula", normal_do_dono: `maiúscula em ${pct(1 - minuscula)}`, frase: `O dono começa com letra maiúscula em ${pct(1 - minuscula)} das mensagens; o rascunho começa com minúscula.` });
  }

  // Pontuação final.
  const fim = (t: string) => t.replace(/[\s\p{Extended_Pictographic}\p{Emoji_Modifier}️‍]+$/u, "");
  const ponto = fracao(a.ponto, n);
  if (limpos.some((t) => /[^.…]\.$/u.test(fim(t)) || fim(t) === ".") && ponto < 0.1) desvios.push({ medida: "ponto_final", rascunho: "termina com ponto", normal_do_dono: pct(ponto), frase: `O dono termina com ponto final em só ${pct(ponto)} das mensagens.` });
  const exclamacao = fracao(a.exclamacao, n);
  if (limpos.some((t) => t.includes("!")) && exclamacao < 0.05) desvios.push({ medida: "exclamacao", rascunho: "tem !", normal_do_dono: pct(exclamacao), frase: `O dono usa "!" no fim de só ${pct(exclamacao)} das mensagens.` });

  // Emoji.
  const emojis = limpos.flatMap(emojisDe);
  const comEmoji = fracao(a.comEmoji, n);
  if (emojis.length > 0) {
    if (comEmoji < 0.1) desvios.push({ medida: "emoji", rascunho: emojis.length, normal_do_dono: pct(comEmoji), frase: `O rascunho tem emoji; o dono usa emoji em só ${pct(comEmoji)} das mensagens.` });
    else {
      const novos = [...new Set(emojis.filter((e) => a.porEmoji[e] === undefined))];
      if (novos.length > 0) desvios.push({ medida: "emoji_que_o_dono_nao_usa", rascunho: novos.join(" "), normal_do_dono: Object.keys(a.porEmoji).slice(0, 8).join(" "), frase: `O rascunho tem emoji que o dono nunca usou (${novos.join(" ")}).` });
    }
  }

  // Saudação e fecho que não estão entre os dele.
  const comeco = palavrasLimpas(limpos[0]!).slice(0, 3).join(" ");
  const saudacao = SAUDACOES.find((s) => comeco === s || comeco.startsWith(`${s} `));
  if (saudacao && !Object.keys(a.aberturas).some((k) => k === saudacao || k.startsWith(`${saudacao} `))) {
    desvios.push({ medida: "saudacao", rascunho: saudacao, normal_do_dono: "nunca abre assim", frase: `O rascunho abre com "${saudacao}", que não está entre as aberturas do dono.` });
  }
  const final = palavrasLimpas(limpos.at(-1)!).slice(-3).join(" ");
  const fecho = FECHOS.find((f) => final === f || final.endsWith(` ${f}`));
  if (fecho && !Object.keys(a.fechos).some((k) => k === fecho || k.endsWith(` ${fecho}`))) {
    desvios.push({ medida: "fecho", rascunho: fecho, normal_do_dono: "nunca fecha assim", frase: `O rascunho fecha com "${fecho}", que não está entre os fechos do dono.` });
  }

  // Quebra em várias mensagens.
  const quebra = fracao(a.rajadasLongasQuebradas, a.rajadasLongas);
  if (limpos.length === 1 && palavrasDe(limpos[0]!).length > 20 && a.rajadasLongas >= MINIMO_DE_RAJADAS_LONGAS && quebra >= 0.4) {
    desvios.push({ medida: "quebra_em_mensagens", rascunho: "uma mensagem só", normal_do_dono: `quebra em ${pct(quebra)} das respostas longas`, frase: `Quando a resposta passa de 20 palavras, o dono quebra em 2+ mensagens em ${pct(quebra)} das vezes.` });
  }

  // Formalidade que ele nunca usou.
  for (const f of new Set(limpos.flatMap(formalidadesNo))) {
    if (!formalidadesDoDono.has(f)) desvios.push({ medida: "formalidade", rascunho: f, normal_do_dono: "nunca usou", frase: `O dono nunca escreveu "${f}" nas mensagens guardadas.` });
  }
  return desvios;
}

/** A palavra ou expressão proibida de uma regra do tipo "não usar 'X'" (undefined: não dá para conferir por código). */
export function proibidoDaRegra(texto: string): string | undefined {
  const m = /n[aã]o\s+(?:usar|use|escrever|escreva|colocar|coloque|p[oô]r|ponha|dizer|diga|mandar|mande)\s+(?:a palavra\s+|o\s+|a\s+)?["'‘’“”]([^"'‘’“”]{1,60})["'‘’“”]/iu.exec(texto);
  return m?.[1]?.trim() || undefined;
}

/** O rascunho viola a regra "não usar 'X'"? (sem acento e sem caixa, como palavra ou expressão inteira) */
export function violaProibido(textos: readonly string[], proibido: string): boolean {
  const alvo = semAcento(proibido).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (alvo === "") return false;
  const n = ` ${semAcento(textos.join(" ")).replace(/[^\p{L}\p{N}]+/gu, " ")} `;
  return n.includes(` ${alvo} `);
}
