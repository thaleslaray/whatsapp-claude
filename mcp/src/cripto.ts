// AES-256-GCM. Formato selado: "v1." + base64(iv[12] | tag[16] | texto cifrado). IV aleatório por gravação.
// O AAD amarra o texto ao seu lugar (id da conversa, nome do índice, slot da sessão): uma linha copiada
// para outra conversa não abre.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const PREFIXO = "v1.";

export function selar(chave: Buffer, aad: string, texto: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", chave, iv);
  c.setAAD(Buffer.from(aad, "utf8"));
  const cifrado = Buffer.concat([c.update(texto, "utf8"), c.final()]);
  return PREFIXO + Buffer.concat([iv, c.getAuthTag(), cifrado]).toString("base64");
}

export class ErroDeLeitura extends Error {
  override name = "ErroDeLeitura";
}

export function abrir(chave: Buffer, aad: string, selado: string): string {
  if (!selado.startsWith(PREFIXO)) throw new ErroDeLeitura("Formato desconhecido.");
  const bruto = Buffer.from(selado.slice(PREFIXO.length), "base64");
  if (bruto.length < 28) throw new ErroDeLeitura("Dado curto demais.");
  try {
    const d = createDecipheriv("aes-256-gcm", chave, bruto.subarray(0, 12));
    d.setAAD(Buffer.from(aad, "utf8"));
    d.setAuthTag(bruto.subarray(12, 28));
    return Buffer.concat([d.update(bruto.subarray(28)), d.final()]).toString("utf8");
  } catch {
    throw new ErroDeLeitura("Não abriu: chave errada ou dado alterado.");
  }
}
