// 0.12.0: o modo de aprendizado, a parte que MEDE. O servidor aprende o jeito do dono escrever sem ele ter de descrever:
// pelas mensagens que ele mesmo mandou (`de_mim`) e pelo que ele muda no cartão antes de enviar. Quem redige é o modelo;
// aqui só se conta. Nada de inferir personalidade, humor ou intenção: tamanho, rajada, caixa, pontuação, emoji, risada,
// aberturas e fechos, palavras fora da lista comum e áudio, cada um por contagem conferível à mão.
//
// - Funções puras (sem banco nem relógio), mais um cache em memória por conversa como o da triagem: invalidado pelo
//   carimbo do arquivo (`Banco.marcaDaConversa`), esvaziado no `aoApagar` e no encerrar. O cache guarda números e as
//   expressões já agregadas (contagens por forma), nunca o texto das mensagens.
// - Fica FORA da medida: mensagem de outra pessoa, mídia sem legenda, mensagem só de link e a que o servidor enviou a
//   partir de rascunho da IA sem edição (ou com edição mínima), senão a IA aprende com ela mesma. A editada entra: o
//   texto final é do dono.
// - Medir a edição do cartão (rascunho contra enviado) também mora aqui: distância por palavras e um resumo estrutural.

import type { Banco, MensagemGuardada } from "./banco.ts";
import { paresDe, type Par } from "./pares.ts";
import { classificarRajadas, TIPOS_DE_MENSAGEM, type RajadaClassificada, type TipoDeMensagem } from "./tipo-de-mensagem.ts";

/** Como a mensagem enviada a partir de um rascunho da IA ficou marcada. Só "editado" entra na medida e nos exemplos. */
export type MarcaDoRascunho = "sem_edicao" | "edicao_minima" | "editado";

/** Mensagens do dono seguidas em até isto (inclusive) são uma rajada. */
export const JANELA_DA_RAJADA_MS = 2 * 60_000;
/** Menos que isto de mensagens do dono numa conversa: amostra pequena (o perfil vem com o do tipo ou o geral de apoio). */
export const AMOSTRA_MINIMA = 20;
/** Edição abaixo disto (distância por palavras, 0 a 1) é mínima e não gera aprendizado. */
export const LIMIAR_DA_EDICAO_MINIMA = 0.03;
/** Silêncio que separa "o dono iniciou" de "o dono respondeu", e a janela do "respondeu em até 24 h". */
export const UM_DIA_MS = 86_400_000;
/** 0.14.0: meia-vida do peso do recente (exemplos, aberturas, fechos e palavras mais usadas), em dias. */
export const MEIA_VIDA_DA_RECENCIA_DIAS = 180;
const MEIA_VIDA_MS = MEIA_VIDA_DA_RECENCIA_DIAS * UM_DIA_MS;
/** O peso é relativo: 2^((ts - referência) / meia-vida). A ordem por soma de pesos não depende do relógio. */
const REFERENCIA_DA_RECENCIA = Date.UTC(2020, 0, 1);
/** 0.14.0: o peso do recente de uma data (dobra a cada 180 dias mais nova). */
export const pesoDaData = (ts: number): number => 2 ** ((ts - REFERENCIA_DA_RECENCIA) / MEIA_VIDA_MS);
/** 0.14.0: o perfil dos últimos tantos dias sai junto quando tem pelo menos tantas mensagens. */
export const DIAS_DO_RECENTE = 90;
export const MINIMO_DO_RECENTE = 50;
/** 0.14.0: rajada com mais que isto de palavras é "longa" (para medir se o dono quebra em várias mensagens). */
export const PALAVRAS_DA_RAJADA_LONGA = 20;

const semAcento = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const arredondar = (x: number, casas = 2): number => {
  const f = 10 ** casas;
  return Math.round(x * f) / f;
};
const proporcao = (parte: number, todo: number): number => (todo === 0 ? 0 : arredondar(parte / todo));

/** Um emoji inteiro (bandeira, keycap, sequência com junção, modificador de pele e seletor de variação). */
const EMOJI = /\p{Regional_Indicator}{2}|[#*0-9]️?⃣|\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})*(?:‍\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})*)*/gu;
export const emojisDe = (t: string): string[] => t.match(EMOJI) ?? [];


/** Link em qualquer forma (com protocolo, www. ou domínio solto): o mesmo do filtro dos exemplos. */
const QUALQUER_LINK = /\b(?:https?:\/\/|www\.)|\b[\p{L}\p{N}-]+\.(?:com|br|net|org|io|me|ly|app|dev|gov|edu|info|site|link)\b/iu;
export const temLink = (t: string): boolean => QUALQUER_LINK.test(t);

/** 0.14.0: o marcador que fica no lugar de cada link quando se mede a forma de um aviso (um token só). */
export const MARCADOR_DE_LINK = "‹link›";
const LINK_INTEIRO = /(?:https?:\/\/|www\.)\S+|\b[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.(?:com|br|net|org|io|me|ly|app|dev|gov|edu|info|site|link)\b(?:\/\S*)?/giu;
/** 0.14.0: troca cada link do texto pelo marcador (um token), para medir a forma do aviso sem jogá-lo fora. */
export const trocarLinks = (t: string): string => t.replace(LINK_INTEIRO, MARCADOR_DE_LINK);

/** Texto idêntico repetido tantas vezes ou mais na mesma conversa, com mais de tantos caracteres: máquina ou modelo colado. */
export const REPETICOES_DE_MAQUINA = 5;
export const TAMANHO_DA_MENSAGEM_DE_MAQUINA = 40;

/**
 * Os textos do dono que se repetem IGUAIS 5 vezes ou mais numa conversa, com mais de 40 caracteres (no dado real:
 * mensagens que um sistema manda pelo número do dono). Ficam fora das medidas e dos exemplos.
 */
export function textosDeMaquina(mensagens: ReadonlyArray<Pick<MensagemGuardada, "de_mim" | "texto">>): Set<string> {
  const vezes = new Map<string, number>();
  for (const m of mensagens) {
    const t = (m.texto ?? "").trim();
    if (!m.de_mim || [...t].length <= TAMANHO_DA_MENSAGEM_DE_MAQUINA) continue;
    vezes.set(t, (vezes.get(t) ?? 0) + 1);
  }
  return new Set([...vezes].filter(([, n]) => n >= REPETICOES_DE_MAQUINA).map(([t]) => t));
}

/** Por que uma mensagem do dono com texto fica fora da medida de forma (undefined: entra). */
export function motivoDeFora(m: Pick<MensagemGuardada, "de_mim" | "texto" | "rascunho_da_ia">, deMaquina: ReadonlySet<string> = new Set()): "rascunho_da_ia" | "sem_texto" | "com_link" | "repetida" | "de_outra_pessoa" | undefined {
  if (!m.de_mim) return "de_outra_pessoa";
  if (m.rascunho_da_ia === "sem_edicao" || m.rascunho_da_ia === "edicao_minima") return "rascunho_da_ia";
  const t = (m.texto ?? "").trim();
  if (t === "") return "sem_texto";
  // Link distorce tamanho, pontuação e as expressões: a mensagem inteira sai das medidas de forma.
  if (temLink(t)) return "com_link";
  if (deMaquina.has(t)) return "repetida";
  return undefined;
}

/** A mensagem entra na medida do jeito do dono? (`deMaquina`: os textos repetidos da conversa, ver textosDeMaquina.) */
export function entraNaMedida(m: Pick<MensagemGuardada, "de_mim" | "texto" | "rascunho_da_ia">, deMaquina: ReadonlySet<string> = new Set()): boolean {
  return motivoDeFora(m, deMaquina) === undefined;
}

/** Rascunho da IA aceito sem edição de verdade: não é o dono escrevendo. */
const ehDaIa = (m: Pick<MensagemGuardada, "rascunho_da_ia">): boolean => m.rascunho_da_ia === "sem_edicao" || m.rascunho_da_ia === "edicao_minima";

/** Palavras (pedaços separados por espaço com alguma letra ou número). */
export const palavrasDe = (t: string): string[] => t.split(/\s+/u).filter((p) => /[\p{L}\p{N}]/u.test(p));
/** A palavra sem a pontuação e o emoji das pontas. */
const limparPonta = (p: string): string => p.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

/** Mediana (média das duas do meio quando par) e percentil 90 (posição mais próxima), de uma lista de números. */
export function mediana(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const meio = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[meio]! : (s[meio - 1]! + s[meio]!) / 2;
}
export function percentil90(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(0.9 * s.length) - 1)]!;
}

/** Risadas: kkk, haha, hehe, huahua, rs. A forma reduzida agrupa ("kkkkk" e "kkk" são a mesma). */
const RISADA = /^(?:k{2,}|(?:ha){2,}h?|(?:he){2,}h?|(?:hua){2,}|(?:rs)+)$/u;
export function formaReduzidaDaRisada(token: string): string | undefined {
  const t = token.toLowerCase();
  if (!RISADA.test(t)) return undefined;
  if (/^k+$/u.test(t)) return "kk";
  if (t.startsWith("hua")) return "huahua";
  if (t.startsWith("ha")) return "haha";
  if (t.startsWith("he")) return "hehe";
  return "rs";
}

/**
 * Palavras funcionais comuns do português (sem acento, minúsculas). As palavras frequentes do dono FORA desta lista são
 * `palavras_mais_usadas`: vocabulário do dono, sem dicionário (no dado real vêm sobretudo palavras de assunto, não
 * gíria; por isso o nome não promete gíria).
 */
export const PALAVRAS_COMUNS: ReadonlySet<string> = new Set(
  (
    "a o as os um uma uns umas de do da dos das em no na nos nas num numa por pelo pela pelos pelas para pra pro pras pros com sem sob sobre " +
    "entre ate apos desde contra e ou mas que se como quando onde porque pois porem entao tambem ja ainda so mais menos muito muita muitos " +
    "muitas pouco pouca bem mal nao sim eu tu voce voces ele ela eles elas me te lhe lhes mim ti si nosso nossa nossos nossas meu minha meus " +
    "minhas teu tua teus tuas seu sua seus suas dele dela deles delas isso isto aquilo esse essa esses essas este esta estes estas aquele " +
    "aquela aqueles aquelas aqui ai la ali ca ser sou es era eram foi fui foram sao estar estou estava estavam esteve ter tenho tem tinha " +
    "tinham teve tive temos ha haver vai vou vamos vao ir fazer faz fiz feito pode posso poder podia quer quero queria dar dou deu dia dias " +
    "hoje amanha ontem agora depois antes sempre nunca tudo todo toda todos todas nada algo alguem ninguem cada outro outra outros outras " +
    "mesmo mesma qual quais quem quanto quanta tao tanto oi ola ok obrigado obrigada bom boa gente coisa coisas vez vezes ne aquilo " +
    "sei sabe acho acha fica ficou tava ta tudo hora horas ano anos"
  ).split(/\s+/u),
);

/** As formas de uma expressão: chave normalizada -> forma como foi escrita -> vezes. */
type Formas = Record<string, Record<string, number>>;
const somarForma = (f: Formas, chave: string, forma: string, n = 1): void => {
  const porForma = (f[chave] ??= {});
  porForma[forma] = (porForma[forma] ?? 0) + n;
};
const totalDe = (porForma: Record<string, number>): number => Object.values(porForma).reduce((a, b) => a + b, 0);
const formaMaisFrequente = (porForma: Record<string, number>): string =>
  Object.entries(porForma).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]![0];

/** Quantas chaves de palavras ficam por conversa no cache (as mais frequentes): o bastante para somar por tipo e geral. */
const PALAVRAS_POR_CONVERSA_NO_CACHE = 150;

/**
 * A matéria-prima do perfil de uma conversa (ou de várias somadas): números e expressões já contadas, nunca o texto.
 * Somar duas amostras dá a amostra das duas conversas juntas (o perfil do tipo e o geral saem assim).
 */
export interface AmostraDoJeito {
  mensagens: number;
  primeira: number | null;
  ultima: number | null;
  caracteres: number[];
  palavras: number[];
  /** Tamanho (em mensagens medidas) de cada rajada. */
  rajadas: number[];
  comLetra: number;
  comecaMinuscula: number;
  todaMinuscula: number;
  comCaixaAlta: number;
  ponto: number;
  exclamacao: number;
  interrogacao: number;
  reticencias: number;
  semPontuacao: number;
  virgula: number;
  comEmoji: number;
  emojis: number;
  porEmoji: Record<string, number>;
  risadas: Formas;
  aberturas: Formas;
  fechos: Formas;
  vocabulario: Formas;
  /** Mensagens do dono (todos os tipos, menos os rascunhos da IA sem edição) e quantas são áudio ou nota de voz. */
  doDono: number;
  audios: number;
  /** Mensagens do dono com texto que ficaram fora das medidas de forma: com link, e repetidas de máquina. */
  foraComLink: number;
  foraRepetidas: number;
  /** 0.14.0: peso do recente de cada expressão (soma de pesoDaData), para ordenar as listas. */
  recencia: Expressoes<number>;
  /** 0.14.0: em que dias (até 2) cada expressão apareceu: na amostra de uma conversa só, a promoção pede 2+ dias. */
  dias: Expressoes<string[]>;
  /** 0.14.0: em quantas conversas cada expressão apareceu: na soma de várias, a promoção pede 2+ conversas. */
  conversas: Expressoes<number>;
  /** 0.14.0: de quantas conversas com mensagem medida a amostra veio. */
  fontes: number;
  /** 0.14.0: rajadas com mais de 20 palavras, e quantas delas o dono quebrou em 2+ mensagens. */
  rajadasLongas: number;
  rajadasLongasQuebradas: number;
}

type Expressoes<T> = { aberturas: Record<string, T>; fechos: Record<string, T>; vocabulario: Record<string, T> };
const expressoesVazias = <T>(): Expressoes<T> => ({ aberturas: {}, fechos: {}, vocabulario: {} });

export const amostraVazia = (): AmostraDoJeito => ({
  mensagens: 0, primeira: null, ultima: null, caracteres: [], palavras: [], rajadas: [], comLetra: 0, comecaMinuscula: 0,
  todaMinuscula: 0, comCaixaAlta: 0, ponto: 0, exclamacao: 0, interrogacao: 0, reticencias: 0, semPontuacao: 0, virgula: 0,
  comEmoji: 0, emojis: 0, porEmoji: {}, risadas: {}, aberturas: {}, fechos: {}, vocabulario: {}, doDono: 0, audios: 0, foraComLink: 0, foraRepetidas: 0,
  recencia: expressoesVazias(), dias: expressoesVazias(), conversas: expressoesVazias(), fontes: 0, rajadasLongas: 0, rajadasLongasQuebradas: 0,
});

const diaDe = (ts: number): string => new Date(ts).toISOString().slice(0, 10);
/** Conta uma ocorrência de uma expressão: a forma, o peso do recente e o dia. */
function anotarExpressao(a: AmostraDoJeito, qual: keyof Expressoes<number>, chave: string, forma: string, ts: number): void {
  somarForma(a[qual], chave, forma);
  a.recencia[qual][chave] = (a.recencia[qual][chave] ?? 0) + pesoDaData(ts);
  const dias = (a.dias[qual][chave] ??= []);
  const d = diaDe(ts);
  if (dias.length < 2 && !dias.includes(d)) dias.push(d);
}

type ParaMedir = Pick<MensagemGuardada, "id" | "ts" | "de_mim" | "tipo" | "texto" | "rascunho_da_ia">;

/** Uma rajada do dono: as posições (na lista da conversa) das mensagens medidas dela, em ordem. */
export interface RajadaDoDono {
  medidas: number[];
  /** Posição da primeira mensagem do dono da rajada (medida ou não). */
  comeco: number;
  inicio: number;
}

/**
 * As rajadas do dono: mensagens dele seguidas (nenhuma de outra pessoa no meio) com no máximo 2 minutos entre uma e a
 * próxima. A continuidade conta toda mensagem do dono (áudio e rascunho da IA também); a rajada guarda só as medidas e
 * some se não tiver nenhuma.
 */
export function rajadasDoDono(mensagens: readonly ParaMedir[]): RajadaDoDono[] {
  const deMaquina = textosDeMaquina(mensagens);
  const saida: RajadaDoDono[] = [];
  let atual: RajadaDoDono | null = null;
  let anterior: number | null = null;
  const fechar = () => {
    if (atual && atual.medidas.length > 0) saida.push(atual);
    atual = null;
    anterior = null;
  };
  mensagens.forEach((m, i) => {
    if (!m.de_mim) return fechar();
    if (atual === null || anterior === null || m.ts - anterior > JANELA_DA_RAJADA_MS) {
      fechar();
      atual = { medidas: [], comeco: i, inicio: m.ts };
    }
    anterior = m.ts;
    if (entraNaMedida(m, deMaquina)) {
      if (atual!.medidas.length === 0) atual!.inicio = m.ts;
      atual!.medidas.push(i);
    }
  });
  fechar();
  return saida;
}

/** As primeiras (ou últimas) até 3 palavras limpas de um texto, como expressões de 1 a 3 palavras. */
function expressoes(texto: string, ponta: "comeco" | "fim"): Array<{ chave: string; forma: string }> {
  const limpas = palavrasDe(texto).map(limparPonta).filter((p) => p !== "");
  const tres = ponta === "comeco" ? limpas.slice(0, 3) : limpas.slice(-3);
  const saida: Array<{ chave: string; forma: string }> = [];
  for (let n = 1; n <= tres.length; n++) {
    const pedaco = ponta === "comeco" ? tres.slice(0, n) : tres.slice(tres.length - n);
    // Nunca expressão com link, e-mail, telefone ou 6+ dígitos (o mesmo filtro dos exemplos).
    if (temDadoProibido(pedaco.join(" ")) || pedaco.some((p) => p.includes("link›") || p.includes("‹link"))) continue;
    saida.push({ chave: semAcento(pedaco.join(" ")), forma: pedaco.join(" ") });
  }
  return saida;
}

/** Os pedaços só de letras de um texto (para risada e vocabulário). */
const tokensDe = (t: string): string[] => t.match(/\p{L}+/gu) ?? [];

/** Mede as mensagens de UMA conversa (em ordem de data). Pura. */
export function amostraDe(mensagens: readonly ParaMedir[]): AmostraDoJeito {
  const a = amostraVazia();
  const deMaquina = textosDeMaquina(mensagens);
  for (const m of mensagens) {
    if (!m.de_mim || ehDaIa(m)) continue;
    a.doDono++;
    if (m.tipo === "audio" || m.tipo === "nota_de_voz") a.audios++;
    const motivo = motivoDeFora(m, deMaquina);
    if (motivo === "com_link") a.foraComLink++;
    else if (motivo === "repetida") a.foraRepetidas++;
  }
  for (const m of mensagens) {
    if (!entraNaMedida(m, deMaquina)) continue;
    const t = m.texto!.trim();
    // 0.14.0: o marcador de link (aviso) conta como palavra e caractere, mas não como letra, emoji nem vocabulário.
    const tSem = t.replaceAll(MARCADOR_DE_LINK, " ").trim();
    a.mensagens++;
    a.primeira = a.primeira === null ? m.ts : Math.min(a.primeira, m.ts);
    a.ultima = a.ultima === null ? m.ts : Math.max(a.ultima, m.ts);
    a.caracteres.push([...t].length);
    a.palavras.push(palavrasDe(t).length);
    // Caixa: só nas mensagens com letra (emoji sozinho não começa com maiúscula nem com minúscula).
    const primeiraLetra = /\p{L}/u.exec(tSem)?.[0];
    if (primeiraLetra !== undefined) {
      a.comLetra++;
      if (/\p{Ll}/u.test(primeiraLetra)) a.comecaMinuscula++;
      if (!/\p{Lu}/u.test(tSem)) a.todaMinuscula++;
      if (/\p{Lu}{3,}/u.test(tSem)) a.comCaixaAlta++;
    }
    // Pontuação final: o que sobra no fim sem espaço e sem emoji.
    const fim = t.replace(EMOJI, "").replace(/[\s️‍]+$/u, "");
    if (/(?:\.\.\.|…)$/u.test(fim)) a.reticencias++;
    else if (fim.endsWith("?")) a.interrogacao++;
    else if (fim.endsWith("!")) a.exclamacao++;
    else if (fim.endsWith(".")) a.ponto++;
    else a.semPontuacao++;
    if (t.includes(",")) a.virgula++;
    const emojis = emojisDe(tSem);
    if (emojis.length > 0) {
      a.comEmoji++;
      a.emojis += emojis.length;
      for (const e of emojis) a.porEmoji[e] = (a.porEmoji[e] ?? 0) + 1;
    }
    for (const token of tokensDe(tSem)) {
      const risada = formaReduzidaDaRisada(token);
      if (risada) {
        somarForma(a.risadas, risada, token.toLowerCase());
        continue;
      }
      const chave = semAcento(token);
      if (PALAVRAS_COMUNS.has(chave)) continue;
      anotarExpressao(a, "vocabulario", chave, token.toLowerCase(), m.ts);
    }
  }
  for (const r of rajadasDoDono(mensagens)) {
    a.rajadas.push(r.medidas.length);
    const primeira = mensagens[r.medidas[0]!]!;
    const ultima = mensagens[r.medidas[r.medidas.length - 1]!]!;
    for (const e of expressoes(primeira.texto!.trim(), "comeco")) anotarExpressao(a, "aberturas", e.chave, e.forma, primeira.ts);
    for (const e of expressoes(ultima.texto!.trim(), "fim")) anotarExpressao(a, "fechos", e.chave, e.forma, ultima.ts);
    const palavras = r.medidas.reduce((n, i) => n + palavrasDe(mensagens[i]!.texto!.trim()).length, 0);
    if (palavras > PALAVRAS_DA_RAJADA_LONGA) {
      a.rajadasLongas++;
      if (r.medidas.length >= 2) a.rajadasLongasQuebradas++;
    }
  }
  // O cache por conversa guarda só as palavras mais frequentes (o resto não chegaria às 20 do perfil, nem somado).
  const vocab = Object.entries(a.vocabulario).sort((x, y) => totalDe(y[1]) - totalDe(x[1]) || (x[0] < y[0] ? -1 : 1)).slice(0, PALAVRAS_POR_CONVERSA_NO_CACHE);
  a.vocabulario = Object.fromEntries(vocab);
  const ficam = new Set(vocab.map(([k]) => k));
  for (const campo of ["recencia", "dias"] as const) a[campo].vocabulario = Object.fromEntries(Object.entries(a[campo].vocabulario).filter(([k]) => ficam.has(k))) as never;
  // Uma conversa: cada expressão está em 1 conversa.
  for (const qual of ["aberturas", "fechos", "vocabulario"] as const) for (const k of Object.keys(a[qual])) a.conversas[qual][k] = 1;
  a.fontes = a.mensagens > 0 ? 1 : 0;
  return a;
}

const juntarFormas = (destino: Formas, origem: Formas): void => {
  for (const [chave, porForma] of Object.entries(origem)) for (const [forma, n] of Object.entries(porForma)) somarForma(destino, chave, forma, n);
};

/** A amostra de várias conversas juntas. */
export function juntarAmostras(amostras: readonly AmostraDoJeito[]): AmostraDoJeito {
  const a = amostraVazia();
  for (const b of amostras) {
    a.mensagens += b.mensagens;
    if (b.primeira !== null) a.primeira = a.primeira === null ? b.primeira : Math.min(a.primeira, b.primeira);
    if (b.ultima !== null) a.ultima = a.ultima === null ? b.ultima : Math.max(a.ultima, b.ultima);
    a.caracteres.push(...b.caracteres);
    a.palavras.push(...b.palavras);
    a.rajadas.push(...b.rajadas);
    for (const k of ["comLetra", "comecaMinuscula", "todaMinuscula", "comCaixaAlta", "ponto", "exclamacao", "interrogacao", "reticencias", "semPontuacao", "virgula", "comEmoji", "emojis", "doDono", "audios", "foraComLink", "foraRepetidas", "fontes", "rajadasLongas", "rajadasLongasQuebradas"] as const) a[k] += b[k];
    for (const qual of ["aberturas", "fechos", "vocabulario"] as const) {
      for (const [k, n] of Object.entries(b.recencia[qual])) a.recencia[qual][k] = (a.recencia[qual][k] ?? 0) + n;
      for (const [k, n] of Object.entries(b.conversas[qual])) a.conversas[qual][k] = (a.conversas[qual][k] ?? 0) + n;
      for (const [k, ds] of Object.entries(b.dias[qual])) {
        const dias = (a.dias[qual][k] ??= []);
        for (const d of ds) if (dias.length < 2 && !dias.includes(d)) dias.push(d);
      }
    }
    for (const [e, n] of Object.entries(b.porEmoji)) a.porEmoji[e] = (a.porEmoji[e] ?? 0) + n;
    juntarFormas(a.risadas, b.risadas);
    juntarFormas(a.aberturas, b.aberturas);
    juntarFormas(a.fechos, b.fechos);
    juntarFormas(a.vocabulario, b.vocabulario);
  }
  return a;
}

/**
 * 0.14.0, promoção de padrão: a expressão só entra na lista com 3+ ocorrências em 2+ conversas (amostra de várias
 * conversas) ou, na amostra de uma conversa só, em 2+ dias.
 */
function promovida(a: AmostraDoJeito, qual: keyof Expressoes<number>, chave: string): boolean {
  return a.fontes > 1 ? (a.conversas[qual][chave] ?? 0) >= 2 : (a.dias[qual][chave]?.length ?? 0) >= 2;
}

/**
 * As expressões que aparecem 3 vezes ou mais (e promovidas), sem a mais curta quando uma mais longa que a contém tem a
 * mesma contagem. 0.14.0: na ordem do peso do recente (meia-vida de 180 dias); `vezes` continua a contagem.
 */
function expressoesFrequentes(a: AmostraDoJeito, qual: "aberturas" | "fechos", ponta: "comeco" | "fim", maximo = 8): Array<{ expressao: string; vezes: number }> {
  const lista = Object.entries(a[qual])
    .map(([chave, porForma]) => ({ chave, vezes: totalDe(porForma), forma: formaMaisFrequente(porForma), peso: a.recencia[qual][chave] ?? 0 }))
    .filter((x) => x.vezes >= 3 && promovida(a, qual, x.chave));
  const contida = (curta: string, longa: string) => (ponta === "comeco" ? longa.startsWith(`${curta} `) : longa.endsWith(` ${curta}`));
  return lista
    .filter((x) => !lista.some((y) => y.vezes === x.vezes && contida(x.chave, y.chave)))
    .sort((x, y) => y.peso - x.peso || y.vezes - x.vezes || y.chave.split(" ").length - x.chave.split(" ").length || (x.chave < y.chave ? -1 : 1))
    .slice(0, maximo)
    .map((x) => ({ expressao: x.forma, vezes: x.vezes }));
}

/** O perfil numérico, como sai para o modelo. Só contagem. */
export interface PerfilDoJeito {
  mensagens_medidas: number;
  periodo: { primeira: string; ultima: string } | null;
  tamanho: { caracteres: { mediana: number; p90: number }; palavras: { mediana: number; p90: number } };
  rajada: { rajadas: number; mediana_de_mensagens: number; proporcao_com_2_ou_mais: number };
  caixa: { mensagens_com_letra: number; comeca_com_minuscula: number; toda_em_minusculas: number; com_trecho_em_caixa_alta: number };
  pontuacao_final: { ponto: number; exclamacao: number; interrogacao: number; reticencias: number; sem_pontuacao: number; com_virgula: number };
  emoji: { proporcao_de_mensagens: number; media_por_mensagem_com_emoji: number; mais_usados: Array<{ emoji: string; vezes: number }> };
  risada: Array<{ forma: string; vezes: number }>;
  aberturas: Array<{ expressao: string; vezes: number }>;
  fechos: Array<{ expressao: string; vezes: number }>;
  /** As palavras frequentes do dono fora da lista comum: vocabulário (muitas são de assunto), não gíria. */
  palavras_mais_usadas: Array<{ palavra: string; vezes: number }>;
  audio: { mensagens_do_dono: number; audios_e_notas_de_voz: number; proporcao: number };
  /** Mensagens do dono com texto que ficaram fora das medidas de forma, e por quê. */
  fora_da_medida: { com_link: number; repetidas: number };
}

const dataIso = (ms: number): string => new Date(ms).toISOString();

export function perfilDe(a: AmostraDoJeito): PerfilDoJeito {
  const n = a.mensagens;
  return {
    mensagens_medidas: n,
    periodo: a.primeira !== null && a.ultima !== null ? { primeira: dataIso(a.primeira), ultima: dataIso(a.ultima) } : null,
    tamanho: {
      caracteres: { mediana: mediana(a.caracteres), p90: percentil90(a.caracteres) },
      palavras: { mediana: mediana(a.palavras), p90: percentil90(a.palavras) },
    },
    rajada: { rajadas: a.rajadas.length, mediana_de_mensagens: mediana(a.rajadas), proporcao_com_2_ou_mais: proporcao(a.rajadas.filter((x) => x >= 2).length, a.rajadas.length) },
    caixa: {
      mensagens_com_letra: a.comLetra,
      comeca_com_minuscula: proporcao(a.comecaMinuscula, a.comLetra),
      toda_em_minusculas: proporcao(a.todaMinuscula, a.comLetra),
      com_trecho_em_caixa_alta: proporcao(a.comCaixaAlta, a.comLetra),
    },
    pontuacao_final: {
      ponto: proporcao(a.ponto, n),
      exclamacao: proporcao(a.exclamacao, n),
      interrogacao: proporcao(a.interrogacao, n),
      reticencias: proporcao(a.reticencias, n),
      sem_pontuacao: proporcao(a.semPontuacao, n),
      com_virgula: proporcao(a.virgula, n),
    },
    emoji: {
      proporcao_de_mensagens: proporcao(a.comEmoji, n),
      media_por_mensagem_com_emoji: a.comEmoji === 0 ? 0 : arredondar(a.emojis / a.comEmoji),
      mais_usados: Object.entries(a.porEmoji)
        .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
        .slice(0, 8)
        .map(([emoji, vezes]) => ({ emoji, vezes })),
    },
    risada: Object.values(a.risadas)
      .map((porForma) => ({ forma: formaMaisFrequente(porForma), vezes: totalDe(porForma) }))
      .sort((x, y) => y.vezes - x.vezes || (x.forma < y.forma ? -1 : 1)),
    aberturas: expressoesFrequentes(a, "aberturas", "comeco"),
    fechos: expressoesFrequentes(a, "fechos", "fim"),
    palavras_mais_usadas: Object.entries(a.vocabulario)
      .map(([chave, porForma]) => ({ chave, palavra: formaMaisFrequente(porForma), vezes: totalDe(porForma), peso: a.recencia.vocabulario[chave] ?? 0 }))
      .filter((x) => x.vezes >= 3 && promovida(a, "vocabulario", x.chave))
      .sort((x, y) => y.peso - x.peso || y.vezes - x.vezes || (x.palavra < y.palavra ? -1 : 1))
      .slice(0, 20)
      .map(({ palavra, vezes }) => ({ palavra, vezes })),
    audio: { mensagens_do_dono: a.doDono, audios_e_notas_de_voz: a.audios, proporcao: proporcao(a.audios, a.doDono) },
    fora_da_medida: { com_link: a.foraComLink, repetidas: a.foraRepetidas },
  };
}

// ---------- prioridade por comportamento (conversa individual) ----------

/** O que basta guardar para a prioridade (só datas e contagens), calculada com o relógio na leitura. */
export interface DadosDaPrioridade {
  /** Cada bloco recebido (mensagens seguidas de outra pessoa): quando começou e quando o dono respondeu. */
  blocos: Array<{ inicio: number; respondido_em?: number }>;
  /** Mensagens do dono depois de 24 h ou mais de silêncio (das duas partes). */
  iniciou: number;
  ultima_do_dono: number | null;
  ultima_recebida: number | null;
}

export function dadosDaPrioridade(mensagens: ReadonlyArray<Pick<MensagemGuardada, "ts" | "de_mim">>): DadosDaPrioridade {
  const d: DadosDaPrioridade = { blocos: [], iniciou: 0, ultima_do_dono: null, ultima_recebida: null };
  let bloco: { inicio: number; respondido_em?: number } | null = null;
  mensagens.forEach((m, i) => {
    if (m.de_mim) {
      d.ultima_do_dono = m.ts;
      if (bloco) {
        bloco.respondido_em = m.ts;
        bloco = null;
      }
      const antes = mensagens[i - 1];
      if (antes && m.ts - antes.ts >= UM_DIA_MS) d.iniciou++;
    } else {
      d.ultima_recebida = m.ts;
      if (!bloco) {
        bloco = { inicio: m.ts };
        d.blocos.push(bloco);
      }
    }
  });
  return d;
}

const haQuanto = (ms: number | null, agora: number) => (ms === null ? null : { data: dataIso(ms), ha_horas: arredondar(Math.max(0, agora - ms) / 3_600_000, 1) });

export function prioridadePublica(d: DadosDaPrioridade, agora: number): Record<string, unknown> {
  const respondidos = d.blocos.filter((b) => b.respondido_em !== undefined);
  const tempos = respondidos.map((b) => b.respondido_em! - b.inicio);
  // Bloco sem resposta que ainda não fez 24 h fica fora da conta: não dá para saber ainda.
  const contam = d.blocos.filter((b) => b.respondido_em !== undefined || agora - b.inicio >= UM_DIA_MS);
  const emAte24h = respondidos.filter((b) => b.respondido_em! - b.inicio <= UM_DIA_MS).length;
  return {
    blocos_recebidos: d.blocos.length,
    blocos_respondidos: respondidos.length,
    mediana_ate_responder_min: tempos.length === 0 ? null : arredondar(mediana(tempos) / 60_000, 1),
    proporcao_respondida_em_ate_24h: contam.length === 0 ? null : proporcao(emAte24h, contam.length),
    vezes_que_o_dono_iniciou: d.iniciou,
    ultima_do_dono: haQuanto(d.ultima_do_dono, agora),
    ultima_recebida: haQuanto(d.ultima_recebida, agora),
  };
}

// ---------- exemplos (a rajada como unidade) ----------

export const MENSAGENS_POR_EXEMPLO = 6;
export const CARACTERES_POR_EXEMPLO = 600;
export type TamanhoDoExemplo = "curta" | "media" | "longa";
export const tamanhoDoExemplo = (caracteres: number): TamanhoDoExemplo => (caracteres <= 40 ? "curta" : caracteres <= 150 ? "media" : "longa");

/**
 * O que nunca vai como exemplo (exemplo é para a FORMA, e isso reduz o reaproveitamento de dado alheio): telefone,
 * e-mail, link, valor em dinheiro, código (letras e números misturados, ou entre crases) e sequência de 6+ dígitos.
 */
const PROIBIDOS_NO_EXEMPLO: readonly RegExp[] = [
  /\+?\d[\d\s().-]{7,}\d/u, // telefone (8+ dígitos com separadores)
  /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+\.[\p{L}.]{2,}/u, // e-mail
  QUALQUER_LINK, // link
  /R\$|US\$|€|£|\$\s?\d|\d\s?(?:reais|real|conto|contos|pila|mil\b|k\b)/iu, // dinheiro
  /`|\b(?=[\p{L}]*\d)(?=\d*\p{L})[\p{L}\d]{6,}\b/u, // código
  /\d{6,}/u, // sequência de dígitos
];
export const temDadoProibido = (t: string): boolean => PROIBIDOS_NO_EXEMPLO.some((r) => r.test(t));

export interface Exemplo {
  textos: string[];
  ts: number;
  tamanho: TamanhoDoExemplo;
}

/** A rajada como exemplo: até 6 mensagens e 600 caracteres, sem dado proibido em nenhuma delas. null se não serve. */
export function exemploDaRajada(mensagens: readonly ParaMedir[], r: RajadaDoDono): Exemplo | null {
  const todas = r.medidas.map((i) => mensagens[i]!.texto!.trim());
  if (todas.some(temDadoProibido)) return null;
  const textos: string[] = [];
  let caracteres = 0;
  for (const t of todas) {
    const n = [...t].length;
    if (textos.length >= MENSAGENS_POR_EXEMPLO || caracteres + n > CARACTERES_POR_EXEMPLO) break;
    textos.push(t);
    caracteres += n;
  }
  if (textos.length === 0) return null;
  return { textos, ts: r.inicio, tamanho: tamanhoDoExemplo(caracteres) };
}

/**
 * 0.14.0: um AVISO do dono como exemplo: as mensagens com texto da rajada inteira (posições), o link do próprio dono
 * pode ficar; continuam fora telefone, e-mail e 6+ dígitos (conferidos sem o link). Fora: rascunho da IA sem edição
 * e mensagem de máquina. Até 6 mensagens e 600 caracteres. null se não serve.
 */
export function exemploDoAviso(mensagens: readonly ParaMedir[], posicoes: readonly number[]): Exemplo | null {
  const deMaquina = textosDeMaquina(mensagens);
  const doDono = posicoes.map((i) => mensagens[i]!);
  if (doDono.some(ehDaIa)) return null;
  const todas = doDono.map((m) => (m.texto ?? "").trim()).filter((t) => t !== "" && !deMaquina.has(t));
  const proibido = (t: string) => {
    const semLink = trocarLinks(t).replaceAll(MARCADOR_DE_LINK, " ");
    return PROIBIDOS_NO_EXEMPLO[0]!.test(semLink) || PROIBIDOS_NO_EXEMPLO[1]!.test(semLink) || /\d{6,}/u.test(semLink);
  };
  if (todas.length === 0 || todas.some(proibido)) return null;
  const textos: string[] = [];
  let caracteres = 0;
  for (const t of todas) {
    const n = [...t].length;
    if (textos.length >= MENSAGENS_POR_EXEMPLO || caracteres + n > CARACTERES_POR_EXEMPLO) break;
    textos.push(t);
    caracteres += n;
  }
  if (textos.length === 0) return null;
  return { textos, ts: doDono[0]!.ts, tamanho: tamanhoDoExemplo(caracteres) };
}

/**
 * Escolhe `k` exemplos variados: metade (arredondada para cima) as mais recentes; o resto espalhado no tempo (um por
 * faixa das mais antigas), preferindo em cada faixa o tamanho (curta, média, longa) que menos apareceu até ali.
 */
export function escolherPorVariedade<T extends { ts: number; tamanho: TamanhoDoExemplo }>(candidatos: readonly T[], k: number, comRecencia = false): T[] {
  const ordenados = [...candidatos].sort((a, b) => b.ts - a.ts);
  if (ordenados.length <= k) return ordenados;
  const recentes = Math.ceil(k / 2);
  const escolhidos = ordenados.slice(0, recentes);
  const resto = ordenados.slice(recentes);
  const faltam = k - recentes;
  // 0.14.0: com `comRecencia`, as faixas do resto têm o mesmo PESO do recente (meia-vida de 180 dias), não o mesmo
  // número de mensagens: o passado recente fica com mais faixas que o antigo.
  const cortes: number[] = [0];
  if (comRecencia) {
    const pesos = resto.map((x) => pesoDaData(x.ts));
    const total = pesos.reduce((s, p) => s + p, 0);
    let acumulado = 0;
    let f = 1;
    pesos.forEach((p, i) => {
      acumulado += p;
      while (f < faltam && acumulado >= (f * total) / faltam) {
        cortes.push(i + 1);
        f++;
      }
    });
    while (cortes.length < faltam) cortes.push(resto.length);
  } else for (let f = 1; f < faltam; f++) cortes.push(Math.floor((f * resto.length) / faltam));
  cortes.push(resto.length);
  for (let f = 0; f < faltam; f++) {
    const faixa = resto.slice(cortes[f]!, cortes[f + 1]!);
    if (faixa.length === 0) continue;
    const vezes = (t: TamanhoDoExemplo) => escolhidos.filter((e) => e.tamanho === t).length;
    const meio = (faixa.length - 1) / 2;
    const melhor = faixa
      .map((x, i) => ({ x, i }))
      .sort((a, b) => vezes(a.x.tamanho) - vezes(b.x.tamanho) || Math.abs(a.i - meio) - Math.abs(b.i - meio) || a.i - b.i)[0]!.x;
    escolhidos.push(melhor);
  }
  return escolhidos;
}

/** As palavras de uma mensagem a responder que valem para achar recebidas parecidas: 3+ letras, fora da lista comum. */
export function termosParaParecidas(texto: string): string[] {
  const vistos = new Set<string>();
  for (const t of tokensDe(texto)) {
    const n = semAcento(t);
    if ([...n].length < 3 || PALAVRAS_COMUNS.has(n) || formaReduzidaDaRisada(n)) continue;
    vistos.add(n);
    if (vistos.size >= 12) break;
  }
  return [...vistos];
}

// ---------- a edição do cartão (rascunho da IA contra o texto enviado) ----------

/** Distância de edição por palavras (Levenshtein), dividida pelo tamanho da maior: 0 igual, 1 tudo diferente. */
export function distanciaPorPalavras(a: string, b: string): number {
  const x = a.split(/\s+/u).filter((p) => p !== "");
  const y = b.split(/\s+/u).filter((p) => p !== "");
  const maior = Math.max(x.length, y.length);
  if (maior === 0) return 0;
  let antes = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const agora = [i];
    for (let j = 1; j <= y.length; j++) agora[j] = Math.min(antes[j]! + 1, agora[j - 1]! + 1, antes[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    antes = agora;
  }
  return arredondar(antes[y.length]! / maior, 3);
}

export const SAUDACOES = ["oi", "ola", "bom dia", "boa tarde", "boa noite", "prezado", "prezada", "prezados", "caro", "cara", "querido", "querida", "e ai", "eai", "fala", "opa", "hey", "hello", "hi", "salve"];
export const FECHOS = ["abraco", "abracos", "abs", "att", "atenciosamente", "cordialmente", "obrigado", "obrigada", "obg", "grato", "grata", "bjs", "bj", "beijo", "beijos", "valeu", "vlw", "tmj", "ate mais", "ate logo", "saudacoes", "fico no aguardo", "aguardo"];

const palavrasLimpas = (t: string): string[] => palavrasDe(t).map(limparPonta).filter((p) => p !== "");
const comecaCom = (t: string, lista: readonly string[]) => {
  const n = semAcento(palavrasLimpas(t).slice(0, 3).join(" "));
  return lista.some((s) => n === s || n.startsWith(`${s} `));
};
const terminaCom = (t: string, lista: readonly string[]) => {
  const n = semAcento(palavrasLimpas(t).slice(-3).join(" "));
  return lista.some((s) => n === s || n.endsWith(` ${s}`));
};
const linhasDe = (t: string): number => t.split("\n").filter((l) => l.trim() !== "").length;

/** O resumo estrutural da edição, por código. */
export interface ResumoDaEdicao {
  tamanho: { antes: number; depois: number; diferenca: number };
  emoji: { antes: number; depois: number; mudou: "tirou" | "pos" | "igual" | "trocou" };
  saudacao: "tirou" | "pos" | "igual";
  fecho: "tirou" | "pos" | "igual";
  primeira_palavra?: { antes: string; depois: string };
  ultima_palavra?: { antes: string; depois: string };
  caixa_inicial?: "maiuscula_para_minuscula" | "minuscula_para_maiuscula";
  linhas: { antes: number; depois: number; quebrou_em_mais_linhas: boolean };
  palavras_tiradas: string[];
  palavras_postas: string[];
}

export interface MedidaDaEdicao {
  distancia: number;
  minima: boolean;
  resumo: ResumoDaEdicao;
}

/** Igual a menos de espaços e da pontuação final? */
const soEspacoOuPontuacaoFinal = (a: string, b: string): boolean => {
  const n = (t: string) => t.replace(/\s+/gu, " ").trim().replace(/[\s.!?…,;:]+$/u, "");
  return n(a) === n(b);
};

/** A diferença de palavras (contagem por forma sem acento), mostrando a forma como foi escrita. Até 15 de cada lado. */
function diferencaDePalavras(antes: string, depois: string): { tiradas: string[]; postas: string[] } {
  const contar = (t: string) => {
    const c = new Map<string, { forma: string; n: number }>();
    for (const p of palavrasLimpas(t)) {
      const k = semAcento(p);
      const atual = c.get(k);
      c.set(k, { forma: atual?.forma ?? p, n: (atual?.n ?? 0) + 1 });
    }
    return c;
  };
  const a = contar(antes);
  const b = contar(depois);
  const tiradas: string[] = [];
  const postas: string[] = [];
  for (const [k, v] of a) for (let i = 0; i < v.n - (b.get(k)?.n ?? 0); i++) tiradas.push(v.forma);
  for (const [k, v] of b) for (let i = 0; i < v.n - (a.get(k)?.n ?? 0); i++) postas.push(v.forma);
  return { tiradas: tiradas.slice(0, 15), postas: postas.slice(0, 15) };
}

export function medirEdicao(rascunho: string, enviado: string): MedidaDaEdicao {
  const distancia = distanciaPorPalavras(rascunho, enviado);
  // Quebrar (ou juntar) em linhas não muda palavra nenhuma, mas é forma: não conta como mínima.
  const mesmasLinhas = linhasDe(rascunho) === linhasDe(enviado);
  const minima = mesmasLinhas && (distancia < LIMIAR_DA_EDICAO_MINIMA || soEspacoOuPontuacaoFinal(rascunho, enviado));
  const ea = emojisDe(rascunho);
  const eb = emojisDe(enviado);
  const mudouEmoji = ea.length > 0 && eb.length === 0 ? "tirou" : ea.length === 0 && eb.length > 0 ? "pos" : ea.join("") === eb.join("") ? "igual" : "trocou";
  const tirouOuPos = (antes: boolean, depois: boolean) => (antes && !depois ? "tirou" : !antes && depois ? "pos" : "igual");
  const pa = palavrasLimpas(rascunho);
  const pb = palavrasLimpas(enviado);
  const la = /\p{L}/u.exec(rascunho)?.[0];
  const lb = /\p{L}/u.exec(enviado)?.[0];
  const caixa =
    la && lb && semAcento(la) === semAcento(lb) && la !== lb
      ? /\p{Lu}/u.test(la)
        ? ("maiuscula_para_minuscula" as const)
        : ("minuscula_para_maiuscula" as const)
      : undefined;
  const dif = diferencaDePalavras(rascunho, enviado);
  const ta = [...rascunho].length;
  const tb = [...enviado].length;
  return {
    distancia,
    minima,
    resumo: {
      tamanho: { antes: ta, depois: tb, diferenca: tb - ta },
      emoji: { antes: ea.length, depois: eb.length, mudou: mudouEmoji },
      saudacao: tirouOuPos(comecaCom(rascunho, SAUDACOES), comecaCom(enviado, SAUDACOES)),
      fecho: tirouOuPos(terminaCom(rascunho, FECHOS), terminaCom(enviado, FECHOS)),
      ...(pa[0] !== pb[0] ? { primeira_palavra: { antes: pa[0] ?? "", depois: pb[0] ?? "" } } : {}),
      ...(pa.at(-1) !== pb.at(-1) ? { ultima_palavra: { antes: pa.at(-1) ?? "", depois: pb.at(-1) ?? "" } } : {}),
      ...(caixa ? { caixa_inicial: caixa } : {}),
      linhas: { antes: linhasDe(rascunho), depois: linhasDe(enviado), quebrou_em_mais_linhas: linhasDe(enviado) > linhasDe(rascunho) },
      palavras_tiradas: dif.tiradas,
      palavras_postas: dif.postas,
    },
  };
}

/** A marca que a mensagem enviada leva: sem edição, edição mínima ou editada pelo dono. */
export function marcaDoRascunho(rascunho: string, enviado: string): MarcaDoRascunho {
  if (rascunho === enviado) return "sem_edicao";
  return medirEdicao(rascunho, enviado).minima ? "edicao_minima" : "editado";
}

// ---------- regras, tipos e edições (o que fica guardado em jeito.enc; banco.ts grava) ----------

export type EscopoDaRegra = "geral" | "tipo" | "conversa";
export type EstadoDaRegra = "proposta" | "ativa" | "recusada" | "desligada";
export type OrigemDaRegra = "edicoes" | "dono";

/** Uma regra de forma: aprendida das edições (proposta, só vira ativa com o "sim" do dono) ou ditada pelo dono. */
export interface Regra {
  id: string;
  /** Escrita pela IA (mesmo a ditada pelo dono passa pelas palavras dela): sai em `anotacao_da_ia`. */
  texto: string;
  escopo: EscopoDaRegra;
  /** Com escopo "tipo": o tipo (normalizarTipo). */
  tipo?: string;
  /** Com escopo "conversa": o jid. Nunca sai para o modelo (sai o id público). */
  conversa?: string;
  origem: OrigemDaRegra;
  estado: EstadoDaRegra;
  /** Origem "edicoes": os ids das edições que mostram o padrão. */
  edicoes?: string[];
  criada_em: number;
  ativa_desde?: number;
  decidida_em?: number;
  /** Quantas vezes foi entregue ao modelo (wa_meu_jeito e wa_exemplos_do_meu_jeito). */
  entregue: number;
}

export type FerramentaDoRascunho = "wa_responder" | "wa_iniciar_conversa" | "wa_enviar_arquivo";

/** Uma edição não mínima de um cartão: o rascunho da IA e o texto que o dono enviou. */
export interface EdicaoGuardada {
  id: string;
  conversa: string;
  mensagem_id: string;
  em: number;
  ferramenta: FerramentaDoRascunho;
  rascunho: string;
  enviado: string;
  distancia: number;
  resumo: ResumoDaEdicao;
  /** Já vista pelo aprendizado (wa_aprender com marcar_vistas): não volta na lista padrão. */
  vista: boolean;
}

/** Um envio a partir de rascunho (sem texto): a medida, para a estatística de se o aprendizado está funcionando. */
export interface EnvioDoRascunho {
  em: number;
  conversa: string;
  distancia: number;
  marca: MarcaDoRascunho;
}

// ---------- regras e tipos (normalização) ----------

export const TAMANHO_MAXIMO_DA_REGRA = 200;
export const TAMANHO_MAXIMO_DO_TIPO = 40;
export const MAXIMO_DE_REGRAS_ATIVAS = 30;
export const MAXIMO_DE_PROPOSTAS_PENDENTES = 30;
export const MAXIMO_DE_EDICOES = 500;
export const TAMANHO_MAXIMO_DO_TEXTO_DA_EDICAO = 2_000;

/** Duas regras com o mesmo texto (sem acento, maiúscula, espaço repetido nem ponto final) e o mesmo escopo são a mesma. */
export const chaveDaRegra = (texto: string): string => semAcento(texto).replace(/\s+/gu, " ").trim().replace(/[.!;\s]+$/u, "");
/** O tipo como fica guardado: minúsculas, espaços simples. */
export const normalizarTipo = (tipo: string): string => tipo.replace(/\s+/gu, " ").trim().toLowerCase();
/** Dois tipos são o mesmo sem diferença de acento ("família" e "familia"). */
export const chaveDoTipo = (tipo: string): string => semAcento(normalizarTipo(tipo));

// ---------- o cache em memória ----------
// 0.13.0: guarda também os pares pergunta -> resposta (pares.ts), sem texto; os pares nunca vão para arquivo.

export interface DaConversa {
  amostra: AmostraDoJeito;
  prioridade: DadosDaPrioridade;
  /** 0.13.0: os pares pergunta -> resposta do dono (pares.ts): ids, datas e a ligação, nunca o texto. */
  pares: Par[];
  /** 0.14.0: o tipo de cada rajada do dono (tipo-de-mensagem.ts), pela posição da primeira mensagem dela. */
  tipoDaRajada: Map<number, TipoDeMensagem>;
  /** 0.14.0: quantas rajadas e mensagens do dono de cada tipo. */
  contagemPorTipo: Record<TipoDeMensagem, { rajadas: number; mensagens: number }>;
  /** 0.14.0: a amostra de cada tipo (só as rajadas daquele tipo; no aviso, o link vira um marcador e entra na medida). */
  porTipo: Record<TipoDeMensagem, AmostraDoJeito>;
}

/**
 * 0.14.0: a amostra só das rajadas de um tipo: as mensagens de outras pessoas ficam (separam as rajadas), as do dono
 * de outros tipos saem. No `aviso`, o link de cada mensagem vira o marcador (um token): senão não sobra aviso para medir.
 */
export function amostraDoTipo(mensagens: readonly MensagemGuardada[], rajadas: readonly RajadaClassificada[], tipo: TipoDeMensagem): AmostraDoJeito {
  const doTipo = new Set(rajadas.filter((r) => r.tipo === tipo).flatMap((r) => r.posicoes));
  const lista = mensagens.flatMap((m, i) => {
    if (!m.de_mim) return [m];
    if (!doTipo.has(i)) return [];
    return [tipo === "aviso" && m.texto ? { ...m, texto: trocarLinks(m.texto) } : m];
  });
  return amostraDe(lista);
}

/** 0.14.0: tudo o que o cache guarda de uma conversa, medido de uma vez (pura). */
export function medirConversa(mensagens: readonly MensagemGuardada[], grupo: boolean): DaConversa {
  const rajadas = classificarRajadas(mensagens, { grupo });
  const contagemPorTipo = Object.fromEntries(TIPOS_DE_MENSAGEM.map((t) => [t, { rajadas: 0, mensagens: 0 }])) as DaConversa["contagemPorTipo"];
  for (const r of rajadas) {
    contagemPorTipo[r.tipo].rajadas++;
    contagemPorTipo[r.tipo].mensagens += r.posicoes.length;
  }
  return {
    amostra: amostraDe(mensagens),
    prioridade: dadosDaPrioridade(mensagens),
    pares: paresDe(mensagens, { grupo }),
    tipoDaRajada: new Map(rajadas.map((r) => [r.posicoes[0]!, r.tipo])),
    contagemPorTipo,
    porTipo: Object.fromEntries(TIPOS_DE_MENSAGEM.map((t) => [t, amostraDoTipo(mensagens, rajadas, t)])) as DaConversa["porTipo"],
  };
}

/**
 * Um por processo (no Contexto). Guarda por conversa a amostra e os dados da prioridade, pelo carimbo do arquivo:
 * o que OUTRO processo grava aparece na leitura seguinte. Esvaziado quando o Banco deste processo apaga algo.
 */
export class CacheDoJeito {
  #banco: Banco | null = null;
  readonly #cache = new Map<string, { marca: string; valor: DaConversa }>();
  /** 0.14.0: a amostra dos últimos 90 dias de cada conversa, pelo carimbo e pelo dia do corte. */
  readonly #recente = new Map<string, { marca: string; desde: number; valor: AmostraDoJeito }>();
  /** Quantas mensagens do dono a última medida geral contou (wa_estado; null até medir). */
  mensagensMedidas: number | null = null;

  #conferirBanco(banco: Banco): void {
    if (this.#banco !== banco) {
      this.#cache.clear();
      this.#recente.clear();
      this.mensagensMedidas = null;
      this.#banco = banco;
    }
  }

  daConversa(banco: Banco, jid: string): DaConversa {
    this.#conferirBanco(banco);
    // O carimbo ANTES de ler: se o arquivo mudar no meio, o carimbo guardado fica velho e a próxima leitura refaz.
    const marca = banco.marcaDaConversa(jid);
    const emCache = this.#cache.get(jid);
    if (emCache && emCache.marca === marca) return emCache.valor;
    const valor = medirConversa(banco.lerMensagens(jid), jid.endsWith("@g.us"));
    this.#cache.set(jid, { marca, valor });
    return valor;
  }

  /** 0.14.0: a amostra só das mensagens desde `desde` (ms; quem chama arredonda ao dia, para o cache valer o dia todo). */
  recente(banco: Banco, jid: string, desde: number): AmostraDoJeito {
    this.#conferirBanco(banco);
    const marca = banco.marcaDaConversa(jid);
    const emCache = this.#recente.get(jid);
    if (emCache && emCache.marca === marca && emCache.desde === desde) return emCache.valor;
    const valor = amostraDe(banco.lerMensagens(jid).filter((m) => m.ts >= desde));
    this.#recente.set(jid, { marca, desde, valor });
    return valor;
  }

  get tamanho(): number {
    return this.#cache.size;
  }

  esvaziar(): void {
    this.#cache.clear();
    this.#recente.clear();
    this.mensagensMedidas = null;
  }
}
