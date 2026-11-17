// Limpeza de segredos. Troca por marcas:
// - todo valor registrado (chave AES da instalação, chaves privadas das credenciais) e as formas dele
//   em base64 e codificada em URL;
// - qualquer cadeia de 64 caracteres hexadecimais (a forma da chave AES em hexadecimal);
// - qualquer jid de pessoa (`5511...@s.whatsapp.net`, `...@lid`) e de grupo antigo (`5511...-1600000000@g.us`, que
//   leva o número de quem criou): número completo nunca sai em log nem em erro.
// Passa por aqui tudo que sai do processo: erro devolvido à ferramenta, linha de log no stderr
// e registro de ações.

export const MARCA_SEGREDO = "‹segredo›";
export const MARCA_JID = "‹jid›";

const PADRAO_HEX64 = /\b[0-9a-fA-F]{64}\b/g;
const PADRAO_JID = /\b\d{5,20}(?::\d+)?@(?:s\.whatsapp\.net|lid|c\.us|hosted(?:\.lid)?)\b/g;
const PADRAO_GRUPO_ANTIGO = /\b\d{5,20}-\d+@g\.us\b/g;
const conhecidos = new Set<string>();

/** Registra um valor secreto carregado na memória do processo, para que `limpar` o apague. */
export function registrar(valor: string | Uint8Array | null | undefined): void {
  if (valor === null || valor === undefined) return;
  if (typeof valor === "string") {
    if (valor.length >= 8) conhecidos.add(valor);
    return;
  }
  if (valor.length < 8) return;
  const buf = Buffer.from(valor);
  conhecidos.add(buf.toString("hex"));
  conhecidos.add(buf.toString("base64"));
  conhecidos.add(buf.toString("base64url"));
}

/** Só para testes: esquece os segredos registrados. */
export function esquecerSegredos(): void {
  conhecidos.clear();
}

export function limpar(texto: string): string {
  let saida = texto;
  const formas = new Set<string>();
  for (const valor of conhecidos) {
    formas.add(valor);
    formas.add(encodeURIComponent(valor));
  }
  // Os mais longos primeiro: um segredo que contém outro não deixa sobra.
  for (const valor of [...formas].sort((a, b) => b.length - a.length)) saida = saida.split(valor).join(MARCA_SEGREDO);
  return saida.replace(PADRAO_HEX64, MARCA_SEGREDO).replace(PADRAO_JID, MARCA_JID).replace(PADRAO_GRUPO_ANTIGO, MARCA_JID);
}

/** Limpa todo texto dentro de objetos, listas e textos soltos (para o registro de ações). */
export function limparProfundo<T>(valor: T): T {
  if (typeof valor === "string") return limpar(valor) as T;
  if (Array.isArray(valor)) return valor.map((item) => limparProfundo(item)) as T;
  if (typeof valor === "object" && valor !== null) {
    return Object.fromEntries(Object.entries(valor).map(([chave, item]) => [limpar(chave), limparProfundo(item)])) as T;
  }
  return valor;
}

/** Linha JSON de um evento, já limpa. É o que o registro de ações grava. */
export function linhaDeRegistro(evento: Record<string, unknown>): string {
  return JSON.stringify(limparProfundo(evento));
}
