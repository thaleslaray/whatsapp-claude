// Socket INERTE do autoteste (npm run autoteste), no lugar da Baileys de verdade.
// Só é usado com `WA_TESTE_SOCKET=falso`, que vale SÓ junto com a trava de teste (WA_TESTE_CHAVE + WA_DADOS_DIR,
// ver config.ts), como o IG_GRAPH_BASE do Instagram. Fora dela o servidor nem sobe.
//
// Não abre conexão nenhuma: não usa rede, nem WebSocket, nem DNS. Ao ser criado (só depois do clique no cartão do
// wa_parear) dispara "conectando" e um QR FALSO, que não é QR do WhatsApp e não pareia nada; serve para o autoteste
// conferir que o caminho do pareamento e o desenho do QR funcionam dentro do pacote.
//
// 0.6.0: "leitura" simulada do QR, para o autoteste provar o pareamento e uma resposta pela SEGUNDA cópia do servidor
// (a leitora, que repassa ao dono pelo canal). O autoteste cria o arquivo `autoteste-qr-lido` na pasta de dados de
// TESTE; o socket que mostrou o QR vê o arquivo e faz o que a Baileys faz no pair-success (isNewLogin, credenciais com
// um `me` falso, fecha com 515 para reiniciar). O socket seguinte, com o arquivo lá, abre a "conexão", entrega UMA
// mensagem falsa de um número falso e aceita enviar, devolvendo só o id (nada sai: não há rede).
//
// 0.7.0, parte 3: se o autoteste deixou `autoteste-audio.json` na pasta de dados de TESTE, a "conexão" entrega também
// essa mensagem de áudio (do mesmo contato falso). A mídia dela é servida por `midiaDoAutoteste`, que lê a subpasta
// `autoteste-midia/` da mesma pasta de teste no lugar do servidor de mídia do WhatsApp: nada sai para a rede.

import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { CriarSocket, SocketWa } from "./transporte.ts";

/** O texto do QR falso: o prefixo deixa claro em qualquer lugar que não é de verdade. */
export const QR_DO_AUTOTESTE = "AUTOTESTE-NAO-E-QR-DO-WHATSAPP,nao-pareia-nada";

/** O número e o `me` falsos do autoteste (não existem no WhatsApp). */
export const DONO_DO_AUTOTESTE = { id: "5511900000000:1@s.whatsapp.net", name: "Autoteste" };
export const CONTATO_DO_AUTOTESTE = "5511900000001@s.whatsapp.net";
export const ARQUIVO_QR_LIDO = "autoteste-qr-lido";
export const ARQUIVO_DO_AUDIO = "autoteste-audio.json";
export const PASTA_DA_MIDIA = "autoteste-midia";

class SocketDeAutoteste {
  readonly #emissor = new EventEmitter();
  readonly #marca: string;
  #espera: ReturnType<typeof setInterval> | undefined;
  #user: { id: string; name: string } | undefined;

  readonly #audio: string;

  constructor(marca: string, audio: string) {
    this.#marca = marca;
    this.#audio = audio;
    const lido = existsSync(marca);
    setImmediate(() => {
      this.#emissor.emit("connection.update", { connection: "connecting" });
      if (lido) {
        this.#user = DONO_DO_AUTOTESTE;
        this.#emissor.emit("connection.update", { connection: "open" });
        this.#emissor.emit("messages.upsert", {
          type: "notify",
          messages: [
            {
              key: { remoteJid: CONTATO_DO_AUTOTESTE, fromMe: false, id: "AUTOTESTE00000001" },
              message: { conversation: "Mensagem falsa do autoteste" },
              messageTimestamp: Math.floor(Date.now() / 1000),
              pushName: "Contato do autoteste",
            },
          ],
        });
        if (existsSync(this.#audio)) {
          const m = JSON.parse(readFileSync(this.#audio, "utf8")) as { id: string; audioMessage: Record<string, unknown> };
          this.#emissor.emit("messages.upsert", {
            type: "notify",
            messages: [
              {
                key: { remoteJid: CONTATO_DO_AUTOTESTE, fromMe: false, id: m.id },
                message: { audioMessage: m.audioMessage },
                messageTimestamp: Math.floor(Date.now() / 1000),
                pushName: "Contato do autoteste",
              },
            ],
          });
        }
        return;
      }
      this.#emissor.emit("connection.update", { qr: QR_DO_AUTOTESTE });
      this.#espera = setInterval(() => this.#verSeLeu(), 50);
      this.#espera.unref();
    });
  }

  get user() {
    return this.#user;
  }

  #verSeLeu(): void {
    if (!existsSync(this.#marca)) return;
    clearInterval(this.#espera);
    this.#emissor.emit("connection.update", { isNewLogin: true });
    this.#emissor.emit("creds.update", { me: DONO_DO_AUTOTESTE });
    this.#emissor.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: Object.assign(new Error("reinício do autoteste"), { output: { statusCode: 515 } }), date: new Date() },
    });
  }

  get ev() {
    return {
      on: (evento: string, f: (...a: unknown[]) => void) => this.#emissor.on(evento, f),
      off: (evento: string, f: (...a: unknown[]) => void) => this.#emissor.off(evento, f),
      emit: (evento: string, dado: unknown) => this.#emissor.emit(evento, dado),
    };
  }

  async sendMessage(jid: string, _conteudo: unknown, opcoes?: { messageId?: string }): Promise<unknown> {
    if (!this.#user) throw new Error("Socket do autoteste: sem conexão, nada é enviado.");
    return { key: { remoteJid: jid, fromMe: true, id: opcoes?.messageId ?? "AUTOTESTE-ENVIO" } };
  }
  async sendPresenceUpdate(): Promise<void> {}
  /** 0.7.0: sem rede, responde que todo número tem WhatsApp (o autoteste não começa conversa nova). */
  async onWhatsApp(...jids: string[]): Promise<Array<{ jid: string; exists: boolean }>> {
    return jids.map((jid) => ({ jid, exists: true }));
  }
  /** 0.7.0: sem rede, o pedido de histórico "sai" e nada volta (como um celular desligado). */
  async fetchMessageHistory(): Promise<string> {
    if (!this.#user) throw new Error("Socket do autoteste: sem conexão, nada é pedido.");
    return "AUTOTESTE-PEDIDO-DE-HISTORICO";
  }
  /** 0.7.0, parte 2: sem rede, o celular "não reenvia" mídia vencida. */
  async updateMediaMessage(): Promise<never> {
    throw new Error("Socket do autoteste: não há celular para reenviar mídia.");
  }
  async groupFetchAllParticipating(): Promise<Record<string, never>> {
    return {};
  }
  async logout(): Promise<void> {
    this.end();
    this.#emissor.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: Object.assign(new Error("logout do autoteste"), { output: { statusCode: 401 } }), date: new Date() },
    });
  }
  end(): void {
    clearInterval(this.#espera);
    this.#emissor.removeAllListeners("messages.upsert");
  }
  get signalRepository() {
    return { lidMapping: { getLIDForPN: async () => null, getPNForLID: async () => null } };
  }
}

/** O socket do autoteste, com a marca de "QR lido" na pasta de dados de teste. */
export const socketDeAutoteste =
  (dirDados: string): CriarSocket =>
  () =>
    new SocketDeAutoteste(join(dirDados, ARQUIVO_QR_LIDO), join(dirDados, ARQUIVO_DO_AUDIO)) as unknown as SocketWa;

/** O "servidor de mídia" do autoteste: o arquivo cifrado vem da pasta de teste, pelo nome do caminho pedido. Sem rede. */
export const midiaDoAutoteste =
  (dirDados: string): typeof fetch =>
  async (entrada) => {
    const nome = basename(new URL(String(entrada instanceof Request ? entrada.url : entrada)).pathname);
    const caminho = join(dirDados, PASTA_DA_MIDIA, nome);
    if (!/^[A-Za-z0-9._-]+$/.test(nome) || !existsSync(caminho)) return new Response("nao", { status: 404 });
    return new Response(new Uint8Array(readFileSync(caminho)), { status: 200 });
  };
