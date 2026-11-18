// Identificadores do WhatsApp: o que é conversa individual, grupo, o que nunca se grava, e o número formatado (inteiro).

import { jidNormalizedUser } from "@whiskeysockets/baileys";

/** Conversa individual: número ou LID, com ou sem aparelho (Nod whatsapp.ts:139, regex do `sender`). */
const INDIVIDUAL = /^\d+(?::\d+)?@(s\.whatsapp\.net|lid)$/;
/** Grupo: o formato novo (`120363...@g.us`) e o antigo (`<número do criador>-<data>@g.us`). */
const GRUPO = /^\d+(-\d+)?@g\.us$/;

export const ehIndividual = (jid: string | null | undefined): boolean => typeof jid === "string" && INDIVIDUAL.test(jid);
export const ehGrupo = (jid: string | null | undefined): boolean => typeof jid === "string" && GRUPO.test(jid);
export const ehLid = (jid: string | null | undefined): boolean => typeof jid === "string" && jid.endsWith("@lid");

/**
 * Status, canais e listas de transmissão: nunca decifrados nem gravados.
 * Nod whatsapp.ts:345 (`status@broadcast`, `@newsletter`); `@broadcast` (listas de transmissão) é pedido da ficha.
 */
export function ehSempreIgnorado(jid: string): boolean {
  return jid === "status@broadcast" || jid.endsWith("@newsletter") || jid.endsWith("@broadcast");
}

/** Tira o aparelho (`:12`) e o agente do jid. Texto que não é jid volta como veio. */
export function normalizar(jid: string): string {
  return jidNormalizedUser(jid) || jid;
}

/** Só os dígitos, se o jid for um número de telefone (`@s.whatsapp.net`). Nod whatsapp.ts:42-45 (`numberOf`). */
export function numeroDe(jid: string | null | undefined): string | undefined {
  const n = jid ? normalizar(jid) : "";
  return /^\d{7,15}@s\.whatsapp\.net$/.test(n) ? n.split("@")[0] : undefined;
}

/** Jid de pessoa a partir de um número digitado (`+55 (11) 99999-1234`). undefined se não parece número. */
export function jidDoNumero(texto: string): string | undefined {
  if (!/^\+?[\d\s().-]+$/.test(texto.trim())) return undefined;
  const digitos = texto.replace(/\D/g, "");
  return /^\d{7,15}$/.test(digitos) ? `${digitos}@s.whatsapp.net` : undefined;
}

/**
 * O número INTEIRO formatado (desde 18/11/2026, a pedido do dono: antes saía com parte dos dígitos escondida).
 * Brasil: `+55 11 99999-1234` (13 dígitos) ou `+55 11 9999-1234` (12). EUA/Canadá: `+1 415 555-1234`.
 * Outros países: `+<todos os dígitos>`. Sem número ou inválido: `número oculto`.
 */
export function formatarNumero(digitos: string | undefined): string {
  if (!digitos || !/^\d{7,15}$/.test(digitos)) return "número oculto";
  if (digitos.startsWith("55") && (digitos.length === 13 || digitos.length === 12)) {
    const ddd = digitos.slice(2, 4);
    const resto = digitos.slice(4);
    return `+55 ${ddd} ${resto.slice(0, -4)}-${resto.slice(-4)}`;
  }
  if (digitos.startsWith("1") && digitos.length === 11) return `+1 ${digitos.slice(1, 4)} ${digitos.slice(4, 7)}-${digitos.slice(7)}`;
  return `+${digitos}`;
}
