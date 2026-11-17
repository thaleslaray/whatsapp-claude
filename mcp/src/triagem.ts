// 0.9.0: triagem sem IA para o wa_listar_conversas. Para saber quem espera resposta de verdade, o modelo lia conversa
// por conversa, e muitas terminam em "valeu" ou numa figurinha. O servidor já sabe: o tipo da última mensagem, se o que
// veio depois da última mensagem do dono é só fecho (`encerramento_provavel`, uma PISTA, não certeza) e quantas
// recebidas há depois da marca do resumo.
//
// - O formato do `indice.enc` não muda: tudo é calculado na leitura, com um cache em memória por conversa, invalidado
//   pelo carimbo do arquivo (`Banco.marcaDaConversa`), como a busca. Assim o que OUTRO processo grava também aparece.
// - O cache guarda só datas, de_mim, tipo e o veredito de encerramento; nunca o texto.
// - Um por processo (no Contexto), esvaziado quando o Banco deste processo apaga algo e no encerrar.

import type { Banco, MensagemGuardada, TipoMensagem } from "./banco.ts";

/** Mais do que isto de mensagens de fecho seguidas já não parece só fecho. */
export const MAXIMO_DE_MENSAGENS_DE_FECHO = 5;
/** Texto de fecho é curto. */
export const TAMANHO_MAXIMO_DO_FECHO = 25;

/**
 * As palavras de fecho (sem acento, minúsculas). Sem "sim", "não", "dia", "tarde", "noite", "oi", "olá" nem número:
 * esses pedem resposta ("bom dia" e "boa noite" são saudação, não fecho).
 * 0.9.1: mais palavras vistas no acervo real ("bom finde", "ata", "tamo junto").
 */
const VOCABULARIO_DE_FECHO = [
  "ok", "okay", "blz", "beleza", "valeu", "vlw", "obrigado", "obrigada", "obg", "brigado", "brigada", "tmj", "fechou", "fechado",
  "combinado", "show", "top", "perfeito", "otimo", "boa", "legal", "joia", "certo", "entendi", "entendido", "tranquilo", "pode",
  "deixar", "de", "nada", "imagina", "abs", "abraco", "bjs", "beijo", "beijos", "ate", "mais", "amem",
  "bom", "finde", "fds", "final", "semana", "otima", "ata", "ah", "ta", "aham", "uhum", "isso", "falou", "flw", "tks", "thanks",
  "gratidao", "massa", "bele", "tamo", "junto",
];

/** 0.9.1: letra repetida vira uma só ("valeuu" -> "valeu", "ataa" -> "ata"): a palavra e o vocabulário passam pela mesma redução. */
const reduzirRepetidas = (palavra: string): string => palavra.replace(/(.)\1+/gu, "$1");
const VOCABULARIO_REDUZIDO = new Set(VOCABULARIO_DE_FECHO.map(reduzirRepetidas));

/** 0.14.0: palavras de concordância que, sozinhas, confirmam (o tipo `confirmacao` do jeito, tipo-de-mensagem.ts). */
const CONCORDANCIA = new Set(["sim", "isso", "pode", "exato", "show"].map(reduzirRepetidas));
/** 0.14.0: a palavra (sem acento, minúscula) é de fecho ou concordância? O vocabulário de fecho, mais sim/isso/pode/exato/show. */
export const ehPalavraDeFechoOuConcordancia = (palavra: string): boolean => VOCABULARIO_REDUZIDO.has(reduzirRepetidas(palavra)) || CONCORDANCIA.has(reduzirRepetidas(palavra));

/** Risadas: kkk..., haha..., rs... */
const RISADA = /^(?:k{2,}|(?:ha){2,}h?|(?:ah){2,}|(?:rs)+s?)$/;

/** Emoji (e o que monta um: modificador de pele, junção, seletor de variação, bandeira, keycap). Não inclui dígitos. */
const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}‍️⃣]/gu;
const PONTUACAO_E_SIMBOLO = /[\p{P}\p{S}]/gu;

/**
 * A mensagem é "de fecho"? Figurinha; ou texto sem mídia que, sem emoji e sem pontuação, fica vazio; ou texto de até
 * 25 caracteres, sem "?", com todas as palavras no vocabulário de fecho (ou risada). Qualquer outra coisa (pergunta,
 * áudio, documento, texto maior) não é. "?" nunca é fecho.
 */
export function ehMensagemDeFecho(m: Pick<MensagemGuardada, "tipo" | "texto" | "midia">): boolean {
  if (m.tipo === "figurinha") return true;
  if (m.tipo !== "texto" || m.midia !== undefined) return false;
  const texto = (m.texto ?? "").trim();
  if (texto === "" || texto.includes("?")) return false;
  const limpo = texto.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(EMOJI, " ").replace(PONTUACAO_E_SIMBOLO, " ").trim();
  if (limpo === "") return true; // só emoji (ou só pontuação sem "?")
  if ([...texto].length > TAMANHO_MAXIMO_DO_FECHO) return false;
  // A risada é conferida antes de reduzir ("kkkkk" reduzido viraria "k").
  return limpo.split(/\s+/u).every((p) => RISADA.test(p) || VOCABULARIO_REDUZIDO.has(reduzirRepetidas(p)));
}

/** O resumo da triagem de uma conversa (sem texto). */
export interface ResumoDaTriagem {
  /** Tipo da última mensagem guardada. */
  ultimo_tipo: TipoMensagem | undefined;
  /** Data da última mensagem guardada (ms), ou undefined sem mensagem. */
  ultima_ts: number | undefined;
  /** Tudo o que veio depois da última mensagem do dono é fecho (e são no máximo 5). Falso se a última é do dono. */
  encerramento_provavel: boolean;
  /** Datas das mensagens recebidas (para contar as novas depois de qualquer marca). */
  recebidas: readonly number[];
}

/** Calcula o resumo de uma lista de mensagens em ordem de data. Pura. */
export function resumirConversa(mensagens: ReadonlyArray<Pick<MensagemGuardada, "ts" | "de_mim" | "tipo" | "texto" | "midia">>): ResumoDaTriagem {
  const ultima = mensagens[mensagens.length - 1];
  let fecho = ultima !== undefined && !ultima.de_mim;
  let depoisDoDono = 0;
  for (let i = mensagens.length - 1; i >= 0 && fecho; i--) {
    const m = mensagens[i]!;
    if (m.de_mim) break;
    if (++depoisDoDono > MAXIMO_DE_MENSAGENS_DE_FECHO || !ehMensagemDeFecho(m)) fecho = false;
  }
  return {
    ultimo_tipo: ultima?.tipo,
    ultima_ts: ultima?.ts,
    encerramento_provavel: fecho,
    recebidas: mensagens.filter((m) => !m.de_mim).map((m) => m.ts),
  };
}

/** Quantas recebidas depois da marca (todas, sem marca). */
export const novasDesde = (r: ResumoDaTriagem, marca: number | undefined): number => (marca === undefined ? r.recebidas.length : r.recebidas.filter((ts) => ts > marca).length);

export class Triagem {
  #banco: Banco | null = null;
  /** Conversa (jid) -> carimbo do arquivo e o resumo dela. */
  readonly #cache = new Map<string, { marca: string; resumo: ResumoDaTriagem }>();

  /** O resumo da conversa, do cache se o arquivo não mudou. */
  daConversa(banco: Banco, jid: string): ResumoDaTriagem {
    if (this.#banco !== banco) {
      // Outro Banco (o núcleo foi aberto de novo): começa do zero.
      this.#cache.clear();
      this.#banco = banco;
    }
    // O carimbo ANTES de ler: se o arquivo mudar no meio, o carimbo guardado fica velho e a próxima leitura refaz.
    const marca = banco.marcaDaConversa(jid);
    const emCache = this.#cache.get(jid);
    if (emCache && emCache.marca === marca) return emCache.resumo;
    const resumo = resumirConversa(banco.lerMensagens(jid));
    this.#cache.set(jid, { marca, resumo });
    return resumo;
  }

  /** Quantas conversas estão no cache (para os testes). */
  get tamanho(): number {
    return this.#cache.size;
  }

  esvaziar(): void {
    this.#cache.clear();
  }
}
