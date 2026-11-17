// Carregado antes de todo teste (`node --import ./test/setup.ts --test`). Nenhum teste sai para a rede:
// 1. fetch global que FALHA para qualquer host que não seja 127.0.0.1 (copiado do MCP do Instagram);
// 2. net.Socket.prototype.connect que FALHA para QUALQUER host/porta (nem 127.0.0.1 passa): é por aí que passa o
//    WebSocket (pacote `ws`, via tls/http), então a Baileys nunca abre conexão com o WhatsApp num teste. Só passa
//    conexão por CAMINHO (socket Unix / named pipe): é o canal leitor -> dono da 0.6.0, que não é rede;
// 3. a marca MARCA_SEM_REDE faz o `criarSocketReal` do transporte recusar rodar (socket falso obrigatório).

import net from "node:net";

const fetchOriginal = globalThis.fetch;

export class RedeBloqueada extends Error {
  override name = "RedeBloqueada";
}

globalThis.fetch = (async (entrada: string | URL | Request, init?: RequestInit) => {
  const url = new URL(entrada instanceof Request ? entrada.url : String(entrada));
  if (url.hostname !== "127.0.0.1") {
    throw new RedeBloqueada(`Teste tentou sair para ${url.host}: só 127.0.0.1 é permitido.`);
  }
  return fetchOriginal(entrada, init);
}) as typeof fetch;

const conectarOriginal = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  const primeiro = args[0];
  const opcoes = (Array.isArray(primeiro) ? primeiro[0] : primeiro) as { host?: string; path?: string; port?: number } | number | string | undefined;
  let host: string | undefined;
  let caminho: string | undefined;
  if (typeof opcoes === "object" && opcoes !== null) {
    host = opcoes.host;
    caminho = opcoes.path;
  } else if (typeof opcoes === "number") {
    host = typeof args[1] === "string" ? args[1] : "localhost";
  } else if (typeof opcoes === "string") {
    caminho = opcoes;
  }
  if (!caminho) {
    throw new RedeBloqueada(`Teste tentou abrir conexão com ${host ?? "localhost"}: rede bloqueada.`);
  }
  return (conectarOriginal as (...a: unknown[]) => net.Socket).apply(this, args);
} as typeof net.Socket.prototype.connect;

(globalThis as Record<symbol, unknown>)[Symbol.for("whatsapp-claude.sem-rede")] = true;
