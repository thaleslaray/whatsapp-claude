// De uma WAMessage da Baileys para a MensagemGuardada do banco. Só o necessário: texto, tipo, metadados da mídia,
// a mensagem citada e, em grupo, quem escreveu. Da mídia guarda também a chave e o caminho (`directPath`), para
// a Fase 4 baixar: ficam só na linha cifrada do banco e nunca saem para o modelo (ver apresentacao.ts). Da mídia de
// visualização única, nem a chave nem o caminho: ela não é para ficar guardada.
// `alteracaoDaMensagem`: apagada para todos (REVOKE) e editada (MESSAGE_EDIT) mudam a linha guardada (banco.ts).
// A extração do texto e do contexto segue o Nod (Apache-2.0), engine/src/providers/chat-sdk/whatsapp.ts:280-313.

import { normalizeMessageContent, proto, toNumber, type WAMessage } from "@whiskeysockets/baileys";
import type { MensagemGuardada, MidiaMeta, TipoMensagem } from "./banco.ts";
import { ehIndividual, ehLid, normalizar, numeroDe } from "./jid.ts";
import { enderecoDeMidiaValido, MAXIMO_DE_MIDIA_BYTES } from "./midia.ts";

const MAXIMO_DE_TEXTO = 20_000;
const corta = (t: string | null | undefined, n: number): string | undefined => (t ? t.slice(0, n) : undefined);

/** Data da mensagem em ms; undefined se inválida ou mais de 5 min no futuro (Nod whatsapp.ts:269-276). */
export function dataDaMensagem(msg: WAMessage, agora: number): number | undefined {
  let s: number;
  try {
    s = toNumber(msg.messageTimestamp as Parameters<typeof toNumber>[0]);
  } catch {
    return undefined;
  }
  const ms = s * 1000;
  if (!Number.isFinite(ms) || ms <= 0 || ms > agora + 300_000) return undefined;
  return ms;
}

type MidiaBruta = {
  url?: string | null;
  directPath?: string | null;
  mediaKey?: Uint8Array | string | null;
  fileSha256?: Uint8Array | string | null;
  fileEncSha256?: Uint8Array | string | null;
  mimetype?: string | null;
  fileLength?: unknown;
  fileName?: string | null;
  seconds?: number | null;
};

function meta(m: MidiaBruta, comNome: boolean, unica: boolean): MidiaMeta {
  const tamanho = m.fileLength === undefined || m.fileLength === null ? undefined : Number(toNumber(m.fileLength as Parameters<typeof toNumber>[0]));
  // Visualização única: nada para baixar depois (nem chave nem caminho ficam guardados).
  const baixavel = !unica && enderecoDeMidiaValido(m.url, m.directPath) && (tamanho === undefined || tamanho <= MAXIMO_DE_MIDIA_BYTES);
  const b64 = (v: Uint8Array | string | null | undefined): string | undefined => (v ? (typeof v === "string" ? v : Buffer.from(v).toString("base64")).slice(0, 100) : undefined);
  const chave = b64(m.mediaKey);
  // Chave e caminho só de mídia que passou nas travas (sem caminho válido, não há o que baixar). Desde a 0.7.0 também o
  // endereço e os dois hashes (do arquivo e do arquivo cifrado), que o download da parte 2 confere.
  const sha256 = b64(m.fileSha256);
  const sha256Cifrado = b64(m.fileEncSha256);
  const paraBaixar =
    baixavel && chave && m.directPath
      ? {
          chave,
          caminho: m.directPath.slice(0, 500),
          ...(m.url ? { url: m.url.slice(0, 1000) } : {}),
          ...(sha256 ? { sha256 } : {}),
          ...(sha256Cifrado ? { sha256_cifrado: sha256Cifrado } : {}),
        }
      : {};
  return {
    ...(m.mimetype ? { mimetype: m.mimetype.slice(0, 100) } : {}),
    ...(tamanho !== undefined && Number.isFinite(tamanho) ? { tamanho } : {}),
    ...(comNome && m.fileName ? { nome: m.fileName.slice(0, 255) } : {}),
    ...(typeof m.seconds === "number" && m.seconds > 0 ? { duracao_s: m.seconds } : {}),
    baixavel,
    ...paraBaixar,
  };
}

type Conteudo = proto.IMessage | null | undefined;

/**
 * A mensagem veio como visualização única? Olha cada camada (a de mensagem temporária pode embrulhar a de
 * visualização única) e a marca `viewOnce` da própria mídia.
 */
function ehVisualizacaoUnica(bruta: Conteudo): boolean {
  let atual = bruta;
  for (let i = 0; i < 5 && atual; i++) {
    if (atual.viewOnceMessage || atual.viewOnceMessageV2 || atual.viewOnceMessageV2Extension) return true;
    atual = atual.ephemeralMessage?.message ?? atual.documentWithCaptionMessage?.message ?? atual.editedMessage?.message ?? undefined;
  }
  const c = normalizeMessageContent(bruta);
  return Boolean(c?.imageMessage?.viewOnce || c?.videoMessage?.viewOnce || c?.audioMessage?.viewOnce);
}

/** Texto (ou legenda) de um conteúdo. */
function textoDe(c: Conteudo): string | undefined {
  const n = normalizeMessageContent(c);
  return n?.conversation ?? n?.extendedTextMessage?.text ?? n?.imageMessage?.caption ?? n?.videoMessage?.caption ?? n?.documentMessage?.caption ?? undefined;
}

export type Alteracao = { tipo: "apagada"; id: string } | { tipo: "editada"; id: string; texto: string };

/**
 * Apagada para todos (REVOKE) ou editada (MESSAGE_EDIT): o id da mensagem alvo e, na edição, o texto novo.
 * null para o resto. A Baileys também emite `messages.update` (lib/Utils/process-message.js:298 e 364), mas a
 * mensagem de protocolo chega no `messages.upsert`, que é por onde tudo aqui passa.
 */
export function alteracaoDaMensagem(msg: WAMessage): Alteracao | null {
  const pm = normalizeMessageContent(msg.message)?.protocolMessage;
  const id = pm?.key?.id;
  if (!pm || !id) return null;
  const T = proto.Message.ProtocolMessage.Type;
  if (pm.type === T.REVOKE) return { tipo: "apagada", id: id.slice(0, 100) };
  if (pm.type === T.MESSAGE_EDIT) {
    const texto = textoDe(pm.editedMessage);
    return texto ? { tipo: "editada", id: id.slice(0, 100), texto: texto.slice(0, MAXIMO_DE_TEXTO) } : null;
  }
  return null;
}

/** Quem escreveu a mensagem: eu, ou (em grupo) o número de quem escreveu, se conhecido. */
export function autorDaMensagem(msg: WAMessage, grupo: boolean): { de_mim: boolean; numero?: string } {
  const deMim = msg.key.fromMe === true;
  if (!grupo || deMim) return { de_mim: deMim };
  // Grupo com LID: o número vem em participantAlt (Baileys 7).
  const numero = numeroDe(msg.key.participantAlt) ?? (ehLid(msg.key.participant) ? undefined : numeroDe(msg.key.participant));
  return { de_mim: false, ...(numero ? { numero } : {}) };
}

/** Converte; devolve null para o que não é conversa (reação, aviso de protocolo, chave de grupo, mensagem vazia...). */
export function converterMensagem(msg: WAMessage, opcoes: { ts: number; grupo: boolean }): MensagemGuardada | null {
  const id = msg.key.id;
  if (!id) return null;
  const c = normalizeMessageContent(msg.message);
  if (!c) return null;
  // Reações e avisos de protocolo não viram mensagem. Apagada e editada mudam a guardada (alteracaoDaMensagem).
  if (c.reactionMessage || c.protocolMessage || c.pollUpdateMessage) return null;
  const unica = ehVisualizacaoUnica(msg.message);

  let tipo: TipoMensagem = "texto";
  let texto: string | undefined = c.conversation ?? c.extendedTextMessage?.text ?? undefined;
  let midia: MidiaMeta | undefined;
  if (c.imageMessage) {
    tipo = "imagem";
    texto = c.imageMessage.caption ?? undefined;
    midia = meta(c.imageMessage, false, unica);
  } else if (c.videoMessage) {
    tipo = "video";
    texto = c.videoMessage.caption ?? undefined;
    midia = meta(c.videoMessage, false, unica);
  } else if (c.audioMessage) {
    tipo = c.audioMessage.ptt ? "nota_de_voz" : "audio";
    midia = meta(c.audioMessage, false, unica);
  } else if (c.documentMessage) {
    tipo = "documento";
    texto = c.documentMessage.caption ?? undefined;
    midia = meta(c.documentMessage, true, unica);
  } else if (c.stickerMessage) {
    tipo = "figurinha";
    midia = meta(c.stickerMessage, false, unica);
  } else if (c.locationMessage || c.liveLocationMessage) {
    tipo = "localizacao";
    const nome = c.locationMessage?.name ?? c.locationMessage?.address ?? c.liveLocationMessage?.caption;
    texto = nome ? nome.slice(0, 500) : undefined;
  } else if (c.contactMessage || c.contactsArrayMessage) {
    tipo = "contato";
    // Só o nome do cartão: o vCard (com números) não é guardado.
    texto = c.contactMessage?.displayName ?? c.contactsArrayMessage?.displayName ?? undefined;
  } else if (c.pollCreationMessage || c.pollCreationMessageV2 || c.pollCreationMessageV3) {
    tipo = "enquete";
    texto = (c.pollCreationMessage ?? c.pollCreationMessageV2 ?? c.pollCreationMessageV3)?.name ?? undefined;
  }
  if (!texto && !midia && tipo === "texto") return null;

  const contexto =
    c.extendedTextMessage?.contextInfo ??
    c.imageMessage?.contextInfo ??
    c.videoMessage?.contextInfo ??
    c.audioMessage?.contextInfo ??
    c.stickerMessage?.contextInfo ??
    c.locationMessage?.contextInfo ??
    c.liveLocationMessage?.contextInfo ??
    c.contactMessage?.contextInfo ??
    c.contactsArrayMessage?.contextInfo ??
    c.documentMessage?.contextInfo;
  let citada: MensagemGuardada["citada"];
  if (contexto?.stanzaId) {
    const q = normalizeMessageContent(contexto.quotedMessage);
    const textoCitado = q?.conversation ?? q?.extendedTextMessage?.text ?? q?.imageMessage?.caption ?? q?.videoMessage?.caption ?? q?.documentMessage?.caption;
    citada = { id: contexto.stanzaId.slice(0, 100), ...(textoCitado ? { texto: textoCitado.slice(0, 200) } : {}) };
  }

  const deMim = msg.key.fromMe === true;
  let remetente: MensagemGuardada["remetente"];
  let participante: string | undefined;
  if (opcoes.grupo && !deMim) {
    const { numero } = autorDaMensagem(msg, true);
    const nome = corta(msg.pushName, 100);
    remetente = { ...(nome ? { nome } : {}), ...(numero ? { numero } : {}) };
    // A chave da mensagem em grupo precisa de quem escreveu (citar, reagir): guarda como veio.
    const p = msg.key.participant ? normalizar(msg.key.participant) : undefined;
    if (p && ehIndividual(p)) participante = p;
  }

  return {
    id: id.slice(0, 100),
    ts: opcoes.ts,
    de_mim: deMim,
    tipo,
    ...(texto ? { texto: texto.slice(0, MAXIMO_DE_TEXTO) } : {}),
    ...(midia ? { midia } : {}),
    ...(citada ? { citada } : {}),
    ...(remetente ? { remetente } : {}),
    ...(participante ? { participante } : {}),
  };
}
