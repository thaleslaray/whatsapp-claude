// Socket falso com a mesma interface que o transporte usa da Baileys: `ev`, `sendMessage`, `sendPresenceUpdate`,
// `logout`, `end`, `user`, `signalRepository`, `groupFetchAllParticipating` e `readMessages`; desde a 0.7.0 também
// `onWhatsApp` (quem tem WhatsApp) e `fetchMessageHistory` (histórico sob demanda); na parte 2, `updateMediaMessage`
// (pedir ao celular para reenviar mídia vencida); na 0.7.2, `ws` (ack e recibo do pedido de histórico) e
// `sendPeerDataOperationMessage` (a variação `pn_com_conta`), os dois opcionais. Na 0.7.4, todo nó que passa pelo `ws`
// falso sai antes como `frame` (como a Baileys, lib/Socket/socket.js:446), o teste chama o logger da config (`logar`) e
// manda credenciais novas (`credenciais`, ex. `creds.platform`). Reação, edição e exclusão passam
// pelo `sendMessage`, como na Baileys (`{ react }`, `{ text, edit }`, `{ delete }`).
// Guarda a config recebida e toda chamada, e deixa o teste disparar os eventos.

import { EventEmitter } from "node:events";
import type { UserFacingSocketConfig, WAMessage } from "@whiskeysockets/baileys";
import type { CriarSocket, SocketWa } from "../src/transporte.ts";

/** O que o socket falso viu de um pedido de histórico (pelo `fetchMessageHistory` ou pelo `sendPeerDataOperationMessage`). */
export interface PedidoDeHistoricoFalso {
  quantidade: number;
  chave: { remoteJid?: string; id?: string; fromMe?: boolean };
  ts: number;
  id: string;
  accountLid?: string;
}

export interface Chamada {
  metodo: string;
  args: unknown[];
}

export class SocketFalso {
  readonly config: UserFacingSocketConfig;
  readonly emissor = new EventEmitter();
  readonly chamadas: Chamada[] = [];
  user: { id: string; name?: string; lid?: string } | undefined;
  grupos: Record<string, { id: string; subject: string; size?: number; participants: unknown[] }> = {};
  lids = new Map<string, string>();
  encerrado = false;
  /** Teste: o id que o sendMessage devolve (padrão: o `messageId` pedido, como a Baileys). */
  idDevolvido: string | undefined;
  /** Teste: o sendMessage falha com este erro. */
  falharEnvio: Error | undefined;
  /** Teste: números (jid) que NÃO têm WhatsApp no onWhatsApp. */
  semWhatsApp = new Set<string>();
  /** Teste: o onWhatsApp devolve este jid no lugar do pedido (o WhatsApp corrige o nono dígito, por exemplo). */
  jidCorrigido = new Map<string, string>();
  /** Teste: o que acontece quando o servidor pede histórico ao celular (padrão: nada chega). */
  aoPedirHistorico: ((pedido: PedidoDeHistoricoFalso) => void) | undefined;
  /** Teste (0.7.2): o id que o pedido de histórico devolve (a resposta de verdade o traz em `peerDataRequestSessionId`). */
  idDoPedidoDeHistorico = "PEDIDO-DE-HISTORICO";
  /** Teste (0.7.2): o pedido de histórico falha ao sair. */
  falharPedidoDeHistorico: Error | undefined;
  /** Teste (0.7.2): o WebSocket da Baileys, só para o ack e o recibo. `undefined` = socket sem `ws` (como os antigos). */
  ws: EventEmitter | undefined = new EventEmitter();
  /** Teste (0.7.2): `undefined` = socket sem `sendPeerDataOperationMessage`. */
  sendPeerDataOperationMessage: ((pdo: Record<string, unknown>) => Promise<string>) | undefined = async (pdo) => {
    this.#registrar("sendPeerDataOperationMessage", [pdo]);
    if (this.falharPedidoDeHistorico) throw this.falharPedidoDeHistorico;
    const r = (pdo as { historySyncOnDemandRequest?: Record<string, unknown> }).historySyncOnDemandRequest ?? {};
    const pedido: PedidoDeHistoricoFalso = {
      quantidade: Number(r.onDemandMsgCount),
      chave: { remoteJid: r.chatJid as string, id: r.oldestMsgId as string, fromMe: r.oldestMsgFromMe as boolean },
      ts: Number(r.oldestMsgTimestampMs),
      id: this.idDoPedidoDeHistorico,
      ...(typeof r.accountLid === "string" ? { accountLid: r.accountLid } : {}),
    };
    if (this.aoPedirHistorico) setImmediate(() => this.aoPedirHistorico?.(pedido));
    return this.idDoPedidoDeHistorico;
  };
  /**
   * Teste (0.15.0): a ressincronização do app state (`resyncAppState(collections, isInitialSync)` da Baileys rc14).
   * `undefined` = socket sem ela (como os antigos). Ligue com `ligarRessincronizacao`.
   */
  resyncAppState: ((colecoes: readonly string[], inicial: boolean) => Promise<void>) | undefined;
  /** Teste (0.15.0): liga a ressincronização; `aoRessincronizar` decide o que o "celular" faz (padrão: termina sem nada). */
  ligarRessincronizacao(aoRessincronizar: (colecoes: readonly string[], inicial: boolean) => Promise<void> = async () => {}): void {
    this.resyncAppState = async (colecoes, inicial) => {
      this.#registrar("resyncAppState", [colecoes, inicial]);
      return aoRessincronizar(colecoes, inicial);
    };
  }
  /** Teste (0.7.0, parte 2): o que o celular faz quando o servidor pede para reenviar uma mídia vencida (padrão: falha). */
  aoPedirReenvio: ((mensagem: WAMessage) => WAMessage | Error) | undefined;

  constructor(config: UserFacingSocketConfig) {
    this.config = config;
  }

  get ev() {
    return {
      on: (evento: string, f: (...a: unknown[]) => void) => this.emissor.on(evento, f),
      off: (evento: string, f: (...a: unknown[]) => void) => this.emissor.off(evento, f),
      emit: (evento: string, dado: unknown) => this.emissor.emit(evento, dado),
    };
  }

  #registrar(metodo: string, args: unknown[]): void {
    this.chamadas.push({ metodo, args });
  }

  async sendMessage(...args: unknown[]) {
    this.#registrar("sendMessage", args);
    if (this.falharEnvio) throw this.falharEnvio;
    const pedido = (args[2] as { messageId?: string } | undefined)?.messageId;
    return { key: { remoteJid: args[0], fromMe: true, id: this.idDevolvido ?? pedido ?? "enviada" } };
  }
  async sendPresenceUpdate(...args: unknown[]) {
    this.#registrar("sendPresenceUpdate", args);
  }
  async readMessages(...args: unknown[]) {
    this.#registrar("readMessages", args);
  }
  async sendReceipt(...args: unknown[]) {
    this.#registrar("sendReceipt", args);
  }
  async logout(...args: unknown[]) {
    this.#registrar("logout", args);
    // Como a Baileys: o logout encerra a conexão com loggedOut (401).
    this.end();
    this.fechar(401);
  }
  end(...args: unknown[]) {
    this.#registrar("end", args);
    this.encerrado = true;
  }
  async onWhatsApp(...jids: string[]) {
    this.#registrar("onWhatsApp", jids);
    return jids.filter((j) => !this.semWhatsApp.has(j)).map((j) => ({ jid: this.jidCorrigido.get(j) ?? j, exists: true }));
  }
  async fetchMessageHistory(quantidade: number, chave: { remoteJid?: string; id?: string; fromMe?: boolean }, ts: number) {
    this.#registrar("fetchMessageHistory", [quantidade, chave, ts]);
    if (this.falharPedidoDeHistorico) throw this.falharPedidoDeHistorico;
    const pedido = { quantidade, chave, ts, id: this.idDoPedidoDeHistorico };
    if (this.aoPedirHistorico) setImmediate(() => this.aoPedirHistorico?.(pedido));
    return this.idDoPedidoDeHistorico;
  }
  async updateMediaMessage(mensagem: WAMessage) {
    this.#registrar("updateMediaMessage", [mensagem]);
    const r = this.aoPedirReenvio?.(structuredClone(mensagem)) ?? new Error("Media re-upload failed by device (NOT_FOUND)");
    if (r instanceof Error) throw r;
    return r;
  }
  async groupFetchAllParticipating() {
    this.#registrar("groupFetchAllParticipating", []);
    return this.grupos;
  }
  get signalRepository() {
    return {
      lidMapping: {
        getLIDForPN: async (pn: string) => this.lids.get(pn) ?? null,
        getPNForLID: async (lid: string) => [...this.lids].find(([, l]) => l === lid)?.[0] ?? null,
      },
    };
  }

  // ---- disparos ----
  emitir(evento: string, dado: unknown): void {
    this.emissor.emit(evento, dado);
  }
  abrir(): void {
    this.emitir("connection.update", { connection: "open" });
  }
  fechar(codigo?: number): void {
    this.emitir("connection.update", {
      connection: "close",
      lastDisconnect: { error: codigo === undefined ? new Error("caiu") : Object.assign(new Error(`código ${codigo}`), { output: { statusCode: codigo } }), date: new Date() },
    });
  }
  qr(valor = "2@QR-DE-TESTE"): void {
    this.emitir("connection.update", { qr: valor });
  }
  mensagens(messages: WAMessage[], type: "notify" | "append" = "notify"): void {
    this.emitir("messages.upsert", { messages, type });
  }
  historico(dado: { messages?: WAMessage[]; chats?: unknown[]; contacts?: unknown[]; lidPnMappings?: unknown[] }): void {
    this.emitir("messaging-history.set", { chats: [], contacts: [], messages: [], isLatest: true, ...dado });
  }
  /** Resposta do celular a um pedido de histórico (Baileys rc14: `messaging-history.set` com syncType ON_DEMAND = 6). */
  historicoSobDemanda(messages: WAMessage[], opcoes: { sessao?: string | null; chats?: unknown[] } = {}): void {
    const sessao = opcoes.sessao === undefined ? "sessao-1" : opcoes.sessao;
    this.emitir("messaging-history.set", { chats: opcoes.chats ?? [], contacts: [], messages, syncType: 6, isLatest: undefined, peerDataRequestSessionId: sessao });
  }
  /** 0.7.2: o ack do servidor a uma mensagem nossa (`CB:ack,class:message`), pelo `ws`. */
  ack(id: string, erro?: string): void {
    const no = { tag: "ack", attrs: { id, class: "message", ...(erro ? { error: erro } : {}) } };
    this.ws?.emit("frame", no);
    this.ws?.emit("CB:ack,class:message", no);
  }
  /** 0.7.2: um recibo (`CB:receipt`) de uma mensagem nossa, pelo `ws`; sem `tipo` = entregue. */
  recibo(id: string, tipo?: string, de = "5511988887777@s.whatsapp.net"): void {
    const no = { tag: "receipt", attrs: { id, from: de, ...(tipo ? { type: tipo } : {}) } };
    this.ws?.emit("frame", no);
    this.ws?.emit("CB:receipt", no);
  }
  /** 0.7.4: um nó qualquer pelo `ws`: o `frame` e depois o `CB:<tag>`, como a Baileys. */
  no(no: { tag: string; attrs?: Record<string, unknown>; content?: unknown }): void {
    this.ws?.emit("frame", no);
    this.ws?.emit(`CB:${no.tag}`, no);
  }
  /** 0.7.4: a Baileys chamando o logger que recebeu na config (`filho`: pelo `child()`, como ela faz). */
  logar(nivel: "trace" | "debug" | "info" | "warn" | "error" | "fatal", ...args: unknown[]): void {
    const l = this.config.logger as unknown as Record<string, (...a: unknown[]) => void> & { child(o: unknown): Record<string, (...a: unknown[]) => void> };
    l.child({ class: "baileys" })[nivel]!(...args);
  }
  /** 0.7.4: credenciais novas (`creds.update`), como o pair-success manda (`platform`, por exemplo). */
  credenciais(update: Record<string, unknown>): void {
    this.emitir("creds.update", update);
  }
}

/** Fábrica que guarda cada socket criado. */
export function fabricaFalsa(): { criar: CriarSocket; sockets: SocketFalso[]; ultimo(): SocketFalso } {
  const sockets: SocketFalso[] = [];
  return {
    sockets,
    criar: (config) => {
      const s = new SocketFalso(config);
      sockets.push(s);
      return s as unknown as SocketWa;
    },
    ultimo() {
      const s = sockets[sockets.length - 1];
      if (!s) throw new Error("nenhum socket criado");
      return s;
    },
  };
}

let seq = 0;
/** Mensagem no formato da Baileys. */
export function msg(o: {
  jid: string;
  texto?: string;
  id?: string;
  deMim?: boolean;
  ts?: number;
  participante?: string;
  participanteAlt?: string;
  jidAlt?: string;
  nome?: string;
  message?: Record<string, unknown>;
}): WAMessage {
  return {
    key: {
      remoteJid: o.jid,
      id: o.id ?? `MSG${++seq}`,
      fromMe: o.deMim ?? false,
      ...(o.participante ? { participant: o.participante } : {}),
      ...(o.participanteAlt ? { participantAlt: o.participanteAlt } : {}),
      ...(o.jidAlt ? { remoteJidAlt: o.jidAlt } : {}),
    },
    messageTimestamp: Math.floor((o.ts ?? Date.now()) / 1000),
    ...(o.nome ? { pushName: o.nome } : {}),
    message: (o.message ?? { conversation: o.texto ?? "oi" }) as WAMessage["message"],
  } as WAMessage;
}
