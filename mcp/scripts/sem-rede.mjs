// Carregado com `node --import` antes do servidor no autoteste: NENHUMA conexão de rede sai do processo.
// Bloqueia (e anota no stderr com o prefixo SEM-REDE) toda tentativa por:
//   - net.Socket.prototype.connect: é por aí que passam tls, http(s), o pacote `ws` (WebSocket da Baileys) e o undici;
//   - dns.lookup / dns.promises.lookup e os resolve*: nem a pergunta de DNS sai;
//   - fetch e WebSocket globais.
// Como no test/setup.ts, nem 127.0.0.1 passa. A única conexão permitida é por CAMINHO (socket Unix / named pipe): o
// canal leitor -> dono da 0.6.0, entre duas cópias do servidor na mesma máquina, que não é rede.
// NÃO marca o símbolo "sem-rede" do transporte: o autoteste quer que o caminho de produção rode (com o socket de teste
// escolhido por variável); se a Baileys de verdade fosse criada, a tentativa cairia aqui e o autoteste falharia.

import dns from "node:dns";
import net from "node:net";

function bloquear(onde, alvo) {
  const frase = `SEM-REDE: tentativa bloqueada (${onde}${alvo ? ` ${alvo}` : ""})`;
  process.stderr.write(`${frase}\n`);
  return Object.assign(new Error(frase), { code: "ECONNREFUSED" });
}

const conectarOriginal = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const a = Array.isArray(args[0]) ? args[0][0] : args[0];
  const caminho = typeof a === "string" ? a : typeof a === "object" && a !== null ? a.path : undefined;
  if (typeof caminho === "string" && caminho.length > 0) return conectarOriginal.apply(this, args);
  const alvo = typeof a === "object" && a !== null ? (a.path ?? `${a.host ?? "localhost"}:${a.port}`) : `${typeof args[1] === "string" ? args[1] : "localhost"}:${a}`;
  throw bloquear("net.connect", alvo);
};

for (const nome of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny", "resolveSrv", "resolveTxt"]) {
  if (typeof dns[nome] === "function") {
    dns[nome] = (host, ...resto) => {
      const cb = resto.findLast((x) => typeof x === "function");
      const erro = bloquear(`dns.${nome}`, String(host));
      if (cb) process.nextTick(() => cb(erro));
      else throw erro;
    };
  }
  if (typeof dns.promises?.[nome] === "function") {
    dns.promises[nome] = async (host) => {
      throw bloquear(`dns.promises.${nome}`, String(host));
    };
  }
}

globalThis.fetch = async (entrada) => {
  throw bloquear("fetch", String(entrada instanceof Request ? entrada.url : entrada));
};
globalThis.WebSocket = class {
  constructor(url) {
    throw bloquear("WebSocket", String(url));
  }
};

process.stderr.write("SEM-REDE: ativo\n");
