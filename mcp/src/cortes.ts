// 0.14.0: o servidor acha, sem IA, o que o dono sempre corta (ou sempre põe) nos rascunhos. Função pura sobre as
// edições não mínimas guardadas em jeito.enc (rascunho da IA contra o texto enviado).
// - Trechos cortados: sequências de 1 a 3 palavras (sem caixa, acento, pontuação das pontas nem quebra de linha) que
//   estão no rascunho e não no enviado. Candidato com 3+ edições distintas em que foi cortado, cortado em 60%+ dos
//   rascunhos que o tinham, e não só palavras comuns (a lista do jeito). Sobrepostos: fica o maior. Trecho com
//   algarismo não entra (é dado, não forma).
// - Trechos postos: o inverso, mesmos limiares.
// - Hábitos de estrutura (contagem e proporção sobre todas as edições não mínimas; 3+ e 60%+): encurta (menos de 75%
//   das palavras), tira emoji, tira saudação, tira fecho, maiúscula inicial para minúscula, tira pontuação final,
//   quebra em mais linhas, junta em menos.
// - Menos de 5 edições não mínimas: nenhum candidato (diz quantas faltam).
// Cada candidato: id estável (do tipo e do trecho), os ids das edições que o sustentam (até 5), o escopo sugerido
// (conversa, se todas da mesma; tipo, se todas do mesmo tipo; senão geral) e o texto de regra sugerido. Candidato cuja
// regra já existe (ativa, proposta, recusada ou desligada) não sai. Vira regra só por wa_aprender (`propor` com
// `candidato`, como PROPOSTA) e o "sim" do dono (`decidir`).

import { createHash } from "node:crypto";
import { chaveDaRegra, chaveDoTipo, PALAVRAS_COMUNS, palavrasDe, type EdicaoGuardada, type Regra } from "./jeito.ts";

export const MINIMO_DE_EDICOES = 5;
export const MINIMO_DE_SUSTENTACAO = 3;
export const PROPORCAO_MINIMA = 0.6;
/** Encurtar: o enviado com menos que esta fração das palavras do rascunho. */
export const FRACAO_DO_ENCURTAR = 0.75;
export const MAXIMO_DE_CANDIDATOS = 10;
const IDS_POR_CANDIDATO = 5;

export type TipoDoCandidato = "trecho_cortado" | "trecho_posto" | "habito";
export type Habito = "encurta" | "tira_emoji" | "tira_saudacao" | "tira_fecho" | "inicial_minuscula" | "tira_pontuacao_final" | "quebra_em_mais_linhas" | "junta_em_menos_linhas";

export interface Candidato {
  id: string;
  tipo: TipoDoCandidato;
  /** O trecho (forma escrita) ou o hábito. */
  trecho?: string;
  habito?: Habito;
  /** Em quantas edições o padrão aparece, e a proporção (sobre as que tinham o trecho, ou sobre todas, no hábito). */
  edicoes_que_sustentam: number;
  proporcao: number;
  /** Até 5 ids de edição (as mais recentes). */
  edicoes: string[];
  escopo: "geral" | "tipo" | "conversa";
  tipo_da_conversa?: string;
  /** Com escopo conversa: o jid (nunca sai para o modelo; a ferramenta troca pelo id público). */
  conversa?: string;
  texto_sugerido: string;
}

export interface ResultadoDosCortes {
  edicoes_nao_minimas: number;
  /** Quantas edições faltam para começar a sugerir (0 quando já há o bastante). */
  faltam: number;
  candidatos: Candidato[];
}

const semAcento = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const limparPonta = (p: string): string => p.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
/** As palavras normalizadas (e a forma escrita, em minúsculas, de cada uma). */
function palavras(texto: string): Array<{ n: string; forma: string }> {
  return texto
    .replace(/\s+/gu, " ")
    .split(" ")
    .map(limparPonta)
    .filter((p) => p !== "")
    .map((p) => ({ n: semAcento(p), forma: p.toLowerCase() }));
}
function trechos(lista: ReadonlyArray<{ n: string; forma: string }>): Map<string, string> {
  const saida = new Map<string, string>();
  for (let tam = 1; tam <= 3; tam++) {
    for (let i = 0; i + tam <= lista.length; i++) {
      const pedaco = lista.slice(i, i + tam);
      const chave = pedaco.map((x) => x.n).join(" ");
      if (!saida.has(chave)) saida.set(chave, pedaco.map((x) => x.forma).join(" "));
    }
  }
  return saida;
}
const soComuns = (chave: string): boolean => chave.split(" ").every((p) => PALAVRAS_COMUNS.has(p));
const idDe = (tipo: string, chave: string): string => `cand_${createHash("sha256").update(`${tipo}:${chave}`).digest("hex").slice(0, 8)}`;
const contem = (curta: string, longa: string): boolean => ` ${longa} `.includes(` ${curta} `);
const temEmoji = (t: string): boolean => /\p{Extended_Pictographic}/u.test(t);
const linhas = (t: string): number => t.split("\n").filter((l) => l.trim() !== "").length;
const terminaComPontuacao = (t: string): boolean => /[.!?…]\s*$/u.test(t.replace(/[\s\p{Extended_Pictographic}️‍]+$/u, ""));

const FRASE_DO_HABITO: Record<Habito, (media: number) => string> = {
  encurta: (m) => `respostas mais curtas: o dono corta cerca de ${Math.round(m * 100)}% do texto`,
  tira_emoji: () => "não usar emoji",
  tira_saudacao: () => "não começar com saudação",
  tira_fecho: () => "não terminar com fecho (abraço, att, obrigado)",
  inicial_minuscula: () => "começar com letra minúscula",
  tira_pontuacao_final: () => "não pôr pontuação no fim da mensagem",
  quebra_em_mais_linhas: () => "quebrar a resposta em mais mensagens ou linhas",
  junta_em_menos_linhas: () => "juntar a resposta em menos mensagens ou linhas",
};
/** O começo fixo do texto do hábito (o encurta muda a porcentagem): é com ele que se confere se a regra já existe. */
const RAIZ_DO_HABITO = (h: Habito): string => chaveDaRegra(FRASE_DO_HABITO[h](0).split(":")[0]!);

function habitosDe(e: EdicaoGuardada): Partial<Record<Habito, number>> {
  const antes = palavrasDe(e.rascunho).length;
  const depois = palavrasDe(e.enviado).length;
  const h: Partial<Record<Habito, number>> = {};
  if (antes > 0 && depois < FRACAO_DO_ENCURTAR * antes) h.encurta = 1 - depois / antes;
  if (temEmoji(e.rascunho) && !temEmoji(e.enviado)) h.tira_emoji = 1;
  if (e.resumo.saudacao === "tirou") h.tira_saudacao = 1;
  if (e.resumo.fecho === "tirou") h.tira_fecho = 1;
  if (e.resumo.caixa_inicial === "maiuscula_para_minuscula") h.inicial_minuscula = 1;
  if (terminaComPontuacao(e.rascunho) && !terminaComPontuacao(e.enviado)) h.tira_pontuacao_final = 1;
  if (linhas(e.enviado) > linhas(e.rascunho)) h.quebra_em_mais_linhas = 1;
  if (linhas(e.enviado) < linhas(e.rascunho)) h.junta_em_menos_linhas = 1;
  return h;
}

/** As edições não mínimas que estão guardadas: as que o dono mexeu de verdade. */
export function candidatosDasEdicoes(edicoes: readonly EdicaoGuardada[], tipos: Readonly<Record<string, string>>, regras: readonly Regra[]): ResultadoDosCortes {
  const total = edicoes.length;
  if (total < MINIMO_DE_EDICOES) return { edicoes_nao_minimas: total, faltam: MINIMO_DE_EDICOES - total, candidatos: [] };
  const recentes = (lista: readonly EdicaoGuardada[]) => [...lista].sort((a, b) => b.em - a.em);
  const escopo = (lista: readonly EdicaoGuardada[]): Pick<Candidato, "escopo" | "tipo_da_conversa" | "conversa"> => {
    const conversas = new Set(lista.map((e) => e.conversa));
    if (conversas.size === 1) return { escopo: "conversa", conversa: lista[0]!.conversa };
    const tiposDas = lista.map((e) => tipos[e.conversa]);
    if (tiposDas.every((t) => t !== undefined && chaveDoTipo(t) === chaveDoTipo(tiposDas[0]!))) return { escopo: "tipo", tipo_da_conversa: tiposDas[0]! };
    return { escopo: "geral" };
  };
  const candidatos: Candidato[] = [];

  // Trechos cortados e postos.
  const porEdicao = edicoes.map((e) => ({ e, r: trechos(palavras(e.rascunho)), v: trechos(palavras(e.enviado)) }));
  for (const sentido of ["trecho_cortado", "trecho_posto"] as const) {
    const tinham = new Map<string, number>();
    const mexeu = new Map<string, EdicaoGuardada[]>();
    const formas = new Map<string, string>();
    for (const { e, r, v } of porEdicao) {
      const [de, para] = sentido === "trecho_cortado" ? [r, v] : [v, r];
      for (const [chave, forma] of de) {
        tinham.set(chave, (tinham.get(chave) ?? 0) + 1);
        if (!formas.has(chave)) formas.set(chave, forma);
        if (!para.has(chave)) mexeu.set(chave, [...(mexeu.get(chave) ?? []), e]);
      }
    }
    const achados = [...mexeu]
      .filter(([chave, lista]) => lista.length >= MINIMO_DE_SUSTENTACAO && lista.length / tinham.get(chave)! >= PROPORCAO_MINIMA && !soComuns(chave) && !/\d/u.test(chave))
      .map(([chave, lista]) => ({ chave, lista, proporcao: lista.length / tinham.get(chave)! }));
    // Sobrepostos: fica o maior (o menor contido nele sai).
    const ficam = achados.filter((a) => !achados.some((b) => b.chave !== a.chave && b.chave.split(" ").length > a.chave.split(" ").length && contem(a.chave, b.chave)));
    for (const a of ficam) {
      const forma = formas.get(a.chave)!;
      candidatos.push({
        id: idDe(sentido, a.chave),
        tipo: sentido,
        trecho: forma,
        edicoes_que_sustentam: a.lista.length,
        proporcao: Math.round(a.proporcao * 100) / 100,
        edicoes: recentes(a.lista).slice(0, IDS_POR_CANDIDATO).map((e) => e.id),
        ...escopo(a.lista),
        texto_sugerido: sentido === "trecho_cortado" ? `não usar '${forma}'` : `usar '${forma}'`,
      });
    }
  }

  // Hábitos de estrutura.
  const porHabito = new Map<Habito, Array<{ e: EdicaoGuardada; valor: number }>>();
  for (const e of edicoes) for (const [h, valor] of Object.entries(habitosDe(e)) as Array<[Habito, number]>) porHabito.set(h, [...(porHabito.get(h) ?? []), { e, valor }]);
  for (const [h, lista] of porHabito) {
    if (lista.length < MINIMO_DE_SUSTENTACAO || lista.length / total < PROPORCAO_MINIMA) continue;
    const media = lista.reduce((s, x) => s + x.valor, 0) / lista.length;
    const edicoesDoHabito = lista.map((x) => x.e);
    candidatos.push({
      id: idDe("habito", h),
      tipo: "habito",
      habito: h,
      edicoes_que_sustentam: lista.length,
      proporcao: Math.round((lista.length / total) * 100) / 100,
      edicoes: recentes(edicoesDoHabito).slice(0, IDS_POR_CANDIDATO).map((e) => e.id),
      ...escopo(edicoesDoHabito),
      texto_sugerido: FRASE_DO_HABITO[h](media),
    });
  }

  // A regra que já existe (em qualquer estado) não volta como candidato.
  const existentes = regras.map((r) => chaveDaRegra(r.texto));
  const jaExiste = (c: Candidato) => {
    const raiz = c.habito ? RAIZ_DO_HABITO(c.habito) : chaveDaRegra(c.texto_sugerido);
    return existentes.some((k) => k === raiz || k.startsWith(raiz));
  };
  return {
    edicoes_nao_minimas: total,
    faltam: 0,
    candidatos: candidatos
      .filter((c) => !jaExiste(c))
      .sort((a, b) => b.edicoes_que_sustentam - a.edicoes_que_sustentam || b.proporcao - a.proporcao || (a.id < b.id ? -1 : 1))
      .slice(0, MAXIMO_DE_CANDIDATOS),
  };
}
