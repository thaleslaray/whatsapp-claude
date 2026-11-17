// Canal local do processo leitor para o processo dono da conexão (0.6.0).
//
// Por quê: o Claude Desktop sobe MAIS DE UMA cópia da extensão ao mesmo tempo (uma para a conversa comum, outra para a
// aba Code). Só uma pega o `conexao.lock`; a outra é leitora. Pelo canal, o leitor repassa a chamada de ferramenta
// inteira ao dono e devolve o resultado do dono como veio, então os pedidos de confirmação (que vivem na memória)
// ficam todos num processo só.
//
// - `node:net` com CAMINHO, nunca TCP: socket Unix no Mac/Linux (na pasta de dados, 0700; em `os.tmpdir()`, que no
//   macOS é por usuário, se o caminho passar de 100 bytes: o limite do macOS é 104); named pipe no Windows
//   (`\\.\pipe\whatsapp-claude-<aleatório>`). Nenhuma porta de rede.
// - Só o dono escuta. O endereço, com parte aleatória a cada partida, vai no próprio arquivo do lock (campo `canal`).
// - Autenticação mútua antes de qualquer pedido, com a chave do canal = HMAC-SHA256(chave da instalação,
//   "canal-do-dono:v1") (a chave AES nunca é usada direto) e nonces de 32 bytes:
//     1. dono -> cliente: {v:1, desafio: nD}
//     2. cliente -> dono: {desafio: nC, prova: HMAC(k, "cliente|nD|nC")}
//     3. dono -> cliente: {prova: HMAC(k, "dono|nC|nD")}   (o cliente confere: protege contra um pipe falso)
//     4. cliente -> dono: {ferramenta, argumentos, temTela}; dono -> cliente: {resultado} ou {erro}. Um pedido por conexão.
//   O dono não manda nada além do desafio antes de conferir a prova; prova errada fecha, sem dizer por quê. Comparação
//   em tempo constante (timingSafeEqual).
// - JSON delimitado por linha. Mensagem de até 2 MB, aperto de mão em até 5 s, pedido em até 90 s (o wa_confirmar de um
//   pareamento espera o QR por 20 s; o wa_responder mostra "digitando"), no máximo 8 conexões ao mesmo tempo.
//   Erro de protocolo nunca derruba o processo. Nada do canal (nonces, provas, conteúdo) vai para log.

import type { CallToolResult } from "@modelcontextprotocol/server";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import net from "node:net";
import { posix } from "node:path";
import { registrar } from "./segredos.ts";

export const LIMITES_DO_CANAL = { mensagemBytes: 2 * 1024 * 1024, apertoMs: 5_000, pedidoMs: 90_000, conexoes: 8 };
export type LimitesDoCanal = typeof LIMITES_DO_CANAL;

/** O que o leitor manda: a ferramenta, os argumentos (já validados do lado dele; o dono valida de novo) e se o cliente MCP dele mostra cartões. */
export interface PedidoDoCanal {
  ferramenta: string;
  argumentos: unknown;
  temTela: boolean;
}
export type ExecutarPedido = (pedido: PedidoDoCanal) => Promise<CallToolResult>;

/**
 * 0.7.3: o TIPO da falha, para a caixa-preta (nunca o endereço nem o conteúdo). `tempo_esgotado_no_aperto` = o dono
 * não respondeu em 5 s (processo travado ou ocupado); `conexao_recusada`/`canal_ausente` = ninguém escutando.
 */
export type TipoDaFalhaDoCanal =
  | "canal_ausente"
  | "conexao_recusada"
  | "erro_no_canal"
  | "tempo_esgotado"
  | "tempo_esgotado_no_aperto"
  | "tempo_esgotado_no_pedido"
  | "dono_fechou"
  | "resposta_invalida"
  | "aperto_invalido"
  | "dono_sem_prova"
  | "dono_falhou_ao_executar"
  | "outro";

/** O canal não serviu (não há dono escutando, aperto de mão falhou, tempo, dono saiu no meio). */
export class ErroDoCanal extends Error {
  override name = "ErroDoCanal";
  readonly tipo: TipoDaFalhaDoCanal;
  constructor(mensagem: string, tipo: TipoDaFalhaDoCanal = "outro") {
    super(mensagem);
    this.tipo = tipo;
  }
}

/** O tipo de um erro do socket pelo código do sistema (só o código; a mensagem traz o endereço). */
function tipoDoErroDoSocket(erro: unknown): TipoDaFalhaDoCanal {
  const codigo = (erro as NodeJS.ErrnoException | undefined)?.code;
  if (codigo === "ECONNREFUSED") return "conexao_recusada";
  if (codigo === "ENOENT") return "canal_ausente";
  return "erro_no_canal";
}

const ROTULO = "canal-do-dono:v1";
const MAXIMO_DO_SOCKET = 100;
const NONCE = /^[0-9a-f]{64}$/;

/** O endereço do canal deste processo. Função pura: plataforma, pasta, sufixo aleatório e tmpdir entram de fora. */
export function enderecoDoCanal(plataforma: NodeJS.Platform, dirDados: string, sufixo: string, tmp: string): string {
  if (plataforma === "win32") return `\\\\.\\pipe\\whatsapp-claude-${sufixo}`;
  const naPasta = posix.join(dirDados, `canal-${sufixo}.sock`);
  if (Buffer.byteLength(naPasta) <= MAXIMO_DO_SOCKET) return naPasta;
  return posix.join(tmp, `whatsapp-claude-${sufixo}.sock`);
}

const ehPipe = (endereco: string): boolean => endereco.startsWith("\\\\.\\pipe\\");

/** 0.11.0: o nome do arquivo do canal na pasta de dados (`canal-<16 hex>.sock`, ver enderecoDoCanal). */
export const PADRAO_DO_CANAL = /^canal-[0-9a-f]{16}\.sock$/;

/**
 * Ninguém escuta neste socket? Tenta conectar: recusa (ECONNREFUSED) = órfão; conectou = vivo (desconecta na hora, sem
 * dizer nada); sumiu (ENOENT), tempo esgotado ou outro erro = na dúvida, vivo.
 */
function ninguemOuvindo(caminho: string, esperaMs: number): Promise<boolean> {
  return new Promise((pronto) => {
    const sock = net.connect(caminho);
    const fim = (orfao: boolean) => {
      clearTimeout(t);
      sock.destroy();
      pronto(orfao);
    };
    const t = setTimeout(() => fim(false), esperaMs);
    sock.once("connect", () => fim(false));
    sock.once("error", (e: NodeJS.ErrnoException) => fim(e.code === "ECONNREFUSED"));
  });
}

/**
 * 0.11.0: na partida, apaga da pasta de dados os `canal-*.sock` de processos que morreram sem fechar o canal (o arquivo
 * fica quando o processo é morto). Só os que recusam conexão; o vivo (o do dono atual) e o deste processo ficam. No
 * Windows o canal é named pipe, que some com o processo: nada a fazer. Nunca lança; devolve quantos apagou.
 */
export async function apagarCanaisOrfaos(dirDados: string, proprio: string, plataforma: NodeJS.Platform = process.platform, esperaMs = 1_000): Promise<number> {
  if (plataforma === "win32") return 0;
  let nomes: string[];
  try {
    nomes = readdirSync(dirDados).filter((n) => PADRAO_DO_CANAL.test(n));
  } catch {
    return 0;
  }
  const alvos = nomes.map((n) => posix.join(dirDados, n)).filter((c) => c !== proprio);
  const orfaos = await Promise.all(alvos.map(async (c) => ((await ninguemOuvindo(c, esperaMs)) ? c : undefined)));
  let apagados = 0;
  for (const c of orfaos) {
    if (!c) continue;
    try {
      rmSync(c, { force: true });
      apagados++;
    } catch {
      /* segue */
    }
  }
  return apagados;
}

/** A chave do canal, derivada da chave da instalação. Registrada como segredo. */
export function chaveDoCanal(chave: Buffer): Buffer {
  const k = createHmac("sha256", chave).update(ROTULO).digest();
  registrar(k);
  return k;
}

function prova(chave: Buffer, ...partes: string[]): string {
  return createHmac("sha256", chave).update(partes.join("|")).digest("hex");
}

function iguais(a: unknown, b: string): boolean {
  if (typeof a !== "string" || a.length !== b.length || !NONCE.test(a)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/**
 * Lê mensagens JSON (uma por linha) de um socket. `proxima(ms)` devolve a próxima mensagem ou rejeita (tempo, lixo,
 * tamanho, fechou). Ao rejeitar, o socket é destruído.
 */
function leitor(sock: net.Socket, maximoBytes: number) {
  let buf = "";
  const fila: unknown[] = [];
  let erro: Error | null = null;
  let acordar: (() => void) | null = null;
  const falhar = (e: Error) => {
    erro ??= e;
    acordar?.();
  };
  sock.setEncoding("utf8");
  sock.on("data", (parte: string) => {
    buf += parte;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const linha = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        fila.push(JSON.parse(linha));
      } catch {
        falhar(new ErroDoCanal("mensagem inválida", "resposta_invalida"));
        return;
      }
    }
    if (Buffer.byteLength(buf) > maximoBytes) falhar(new ErroDoCanal("mensagem grande demais", "resposta_invalida"));
    acordar?.();
  });
  sock.on("close", () => falhar(new ErroDoCanal("o outro lado fechou", "dono_fechou")));
  sock.on("error", (e) => falhar(new ErroDoCanal("erro no canal", tipoDoErroDoSocket(e))));
  return async (ms: number): Promise<Record<string, unknown>> => {
    const fim = Date.now() + ms;
    for (;;) {
      if (fila.length > 0) {
        const m = fila.shift();
        if (typeof m !== "object" || m === null || Array.isArray(m)) {
          sock.destroy();
          throw new ErroDoCanal("mensagem inválida", "resposta_invalida");
        }
        return m as Record<string, unknown>;
      }
      if (erro) {
        sock.destroy();
        throw erro;
      }
      const falta = fim - Date.now();
      if (falta <= 0) {
        sock.destroy();
        throw new ErroDoCanal("tempo esgotado", "tempo_esgotado");
      }
      await new Promise<void>((pronto) => {
        const t = setTimeout(pronto, falta);
        acordar = () => {
          clearTimeout(t);
          acordar = null;
          pronto();
        };
      });
    }
  };
}

const enviar = (sock: net.Socket, mensagem: unknown): void => {
  if (!sock.destroyed) sock.write(`${JSON.stringify(mensagem)}\n`);
};

export interface OpcoesDoServidor {
  endereco: string;
  chave: Buffer;
  executar: ExecutarPedido;
  limites?: Partial<LimitesDoCanal>;
}

/** O lado do dono: escuta, autentica e executa um pedido por conexão. */
export class ServidorDoCanal {
  readonly endereco: string;
  readonly #chave: Buffer;
  readonly #executar: ExecutarPedido;
  readonly #limites: LimitesDoCanal;
  readonly #conexoes = new Set<net.Socket>();
  #servidor: net.Server | null = null;

  constructor(opcoes: OpcoesDoServidor) {
    this.endereco = opcoes.endereco;
    this.#chave = opcoes.chave;
    this.#executar = opcoes.executar;
    this.#limites = { ...LIMITES_DO_CANAL, ...opcoes.limites };
  }

  async ouvir(): Promise<void> {
    if (this.#servidor) return;
    // Socket velho de um dono que morreu: removido antes de escutar (o pipe do Windows some com o processo).
    if (!ehPipe(this.endereco)) rmSync(this.endereco, { force: true });
    const servidor = net.createServer((sock) => void this.#atender(sock));
    servidor.maxConnections = this.#limites.conexoes;
    servidor.on("error", () => {});
    await new Promise<void>((pronto, falha) => {
      servidor.once("error", falha);
      servidor.listen(this.endereco, () => {
        servidor.off("error", falha);
        pronto();
      });
    });
    this.#servidor = servidor;
  }

  async #atender(sock: net.Socket): Promise<void> {
    this.#conexoes.add(sock);
    sock.on("close", () => this.#conexoes.delete(sock));
    sock.on("error", () => {});
    const proxima = leitor(sock, this.#limites.mensagemBytes);
    try {
      const nD = randomBytes(32).toString("hex");
      enviar(sock, { v: 1, desafio: nD });
      const resposta = await proxima(this.#limites.apertoMs);
      const nC = resposta.desafio;
      if (typeof nC !== "string" || !NONCE.test(nC) || !iguais(resposta.prova, prova(this.#chave, "cliente", nD, nC))) {
        sock.destroy();
        return;
      }
      enviar(sock, { prova: prova(this.#chave, "dono", nC, nD) });
      const pedido = await proxima(this.#limites.apertoMs);
      if (typeof pedido.ferramenta !== "string" || pedido.ferramenta.length > 100) {
        sock.destroy();
        return;
      }
      let saida: unknown;
      try {
        saida = { resultado: await this.#executar({ ferramenta: pedido.ferramenta, argumentos: pedido.argumentos ?? {}, temTela: pedido.temTela === true }) };
      } catch {
        saida = { erro: "O dono não conseguiu executar o pedido." };
      }
      enviar(sock, saida);
      sock.end();
    } catch {
      sock.destroy();
    }
  }

  /** Para de escutar, derruba as conexões abertas e apaga o socket. */
  async fechar(): Promise<void> {
    const servidor = this.#servidor;
    this.#servidor = null;
    for (const s of this.#conexoes) s.destroy();
    if (servidor) await new Promise<void>((pronto) => servidor.close(() => pronto()));
    if (!ehPipe(this.endereco)) rmSync(this.endereco, { force: true });
  }
}

export interface OpcoesDoCliente {
  endereco: string;
  chave: Buffer;
  pedido: PedidoDoCanal;
  limites?: Partial<LimitesDoCanal>;
}

/** O lado do leitor: conecta, autentica o dono e repassa um pedido. Qualquer falha vira ErroDoCanal. */
export async function chamarPeloCanal(opcoes: OpcoesDoCliente): Promise<CallToolResult> {
  const limites = { ...LIMITES_DO_CANAL, ...opcoes.limites };
  const sock = net.connect(opcoes.endereco);
  sock.on("error", () => {});
  const proxima = leitor(sock, limites.mensagemBytes);
  // 0.7.3: em que fase estava (o tempo esgotado no aperto de mão diz "dono travado"; no pedido, "pedido demorado").
  let fase: "aperto" | "pedido" = "aperto";
  try {
    const desafio = await proxima(limites.apertoMs);
    const nD = desafio.desafio;
    if (desafio.v !== 1 || typeof nD !== "string" || !NONCE.test(nD)) throw new ErroDoCanal("aperto de mão inválido", "aperto_invalido");
    const nC = randomBytes(32).toString("hex");
    enviar(sock, { desafio: nC, prova: prova(opcoes.chave, "cliente", nD, nC) });
    const doDono = await proxima(limites.apertoMs);
    if (!iguais(doDono.prova, prova(opcoes.chave, "dono", nC, nD))) throw new ErroDoCanal("o dono não provou que tem a chave", "dono_sem_prova");
    enviar(sock, opcoes.pedido);
    fase = "pedido";
    const fim = await proxima(limites.pedidoMs);
    const resultado = fim.resultado as CallToolResult | undefined;
    if (!resultado || typeof resultado !== "object" || !Array.isArray(resultado.content)) {
      throw new ErroDoCanal("o dono não devolveu um resultado", typeof fim.erro === "string" ? "dono_falhou_ao_executar" : "resposta_invalida");
    }
    return resultado;
  } catch (erro) {
    if (!(erro instanceof ErroDoCanal)) throw new ErroDoCanal("o canal falhou");
    if (erro.tipo === "tempo_esgotado") throw new ErroDoCanal(erro.message, fase === "aperto" ? "tempo_esgotado_no_aperto" : "tempo_esgotado_no_pedido");
    throw erro;
  } finally {
    sock.destroy();
  }
}
