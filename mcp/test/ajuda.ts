// Montagem comum dos testes: pasta temporária, cofre em memória, socket falso e cliente MCP em memória.
// Nada aqui toca a pasta de dados de verdade, o cofre de verdade ou a rede.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { BufferJSON, initAuthCreds } from "@whiskeysockets/baileys";
import { CofreEmMemoria, type Cofre } from "../src/cofre.ts";
import type { Config } from "../src/config.ts";
import type { ModeloEsperado } from "../src/modelo.ts";
import type { CarregarMotor, DecodificarAudio } from "../src/transcricao.ts";
import type { CaixaPreta } from "../src/caixa-preta.ts";
import type { CarregarSqlite } from "../src/busca.ts";
import { Contexto } from "../src/contexto.ts";
import { RegistroAcoes } from "../src/registro-acoes.ts";
import type { Sessao } from "../src/sessao.ts";
import { fabricaDeServidor, type RegistroExtra } from "../src/servidor.ts";
import type { Temporizador } from "../src/transporte.ts";
import { fabricaFalsa, type SocketFalso } from "./socket-falso.ts";

export const DONO = "5511988887777";
export const ANA = "5511912345678";
export const BETO = "5521987654321";
export const GRUPO = "120363000000000001@g.us";
export const OUTRO_GRUPO = "120363000000000002@g.us";
export const pn = (n: string) => `${n}@s.whatsapp.net`;

export interface Montagem {
  dir: string;
  config: Config;
  ctx: Contexto;
  fabrica: ReturnType<typeof fabricaFalsa>;
  caminhoRegistro: string;
  socket(): SocketFalso;
  fechar(): Promise<void>;
}

export interface OpcoesMontagem {
  /** Grava credenciais pareadas antes da partida (padrão true). */
  pareada?: boolean;
  /** Reaproveita a pasta (segundo processo). */
  dir?: string;
  pid?: number;
  cofre?: Cofre;
  chaveHex?: string;
  temporizador?: Temporizador;
  intervaloDoLockMs?: number;
  limiteDiario?: number;
  /** Relógio dos pedidos (validade de 10 min). */
  agora?: () => number;
  /** "Digitando…" antes de enviar (padrão nos testes: 5 ms). */
  esperaDigitandoMs?: () => number;
  /** Quanto o wa_confirmar do pareamento espera o primeiro QR (padrão do servidor: 20 s). */
  esperaDoQrMs?: number;
  /** Teto de mensagens por conversa (padrão 500 nos testes, de propósito: o do servidor é 5.000 desde a 0.9.2). */
  maxMensagens?: number;
  /** Conversas novas por dia (wa_iniciar_conversa; padrão 5). */
  limiteNovasConversas?: number;
  /** 0.13.0: pedidos de histórico por dia (padrão 30). */
  pedidosDeHistoricoPorDia?: number;
  /** Quanto o wa_buscar_historico espera a resposta do celular (padrão do servidor: 20 s). */
  esperaDoHistoricoMs?: number;
  /** O `fetch` do download de mídia (0.7.0, parte 2). Padrão nos testes: um que recusa tudo (nada de rede). */
  buscarMidia?: typeof fetch;
  /** 0.7.0, parte 3: idioma da transcrição (padrão pt). */
  idiomaTranscricao?: string;
  /** 0.7.0, parte 3: motor, decodificador, download do modelo e espera da transcrição (padrão nos testes: nada de rede nem motor de verdade). */
  carregarMotor?: CarregarMotor;
  decodificarAudio?: DecodificarAudio;
  buscarModelo?: typeof fetch;
  modeloEsperado?: ModeloEsperado;
  esperaDaTranscricaoMs?: number;
  /** 0.7.3: a caixa-preta do processo (padrão: a do Contexto, só na memória). */
  caixaPreta?: CaixaPreta;
  /** 0.8.0: carrega o `node:sqlite` da busca (padrão: o do Node). */
  carregarSqlite?: CarregarSqlite;
  /** 0.15.0: quanto o pedido da agenda espera os contatos (padrão nos testes: 300 ms). */
  esperaDosContatosMs?: number;
}

/** `fetch` de mídia que recusa: teste que não injeta um servidor falso não baixa nada. */
const semMidia: typeof fetch = async () => {
  throw new Error("Teste tentou baixar mídia sem servidor falso.");
};

/** Motor e download do modelo que recusam: teste que não injeta os seus nunca carrega o motor de verdade nem baixa nada. */
const semMotor: CarregarMotor = async () => {
  throw new Error("Teste tentou carregar o motor de transcrição sem um motor falso.");
};
const semModelo: typeof fetch = async () => {
  throw new Error("Teste tentou baixar o modelo sem servidor falso.");
};

export const CHAVE_TESTE = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

/** Credenciais de uma sessão já pareada (o `me` é o que o pair-success grava). */
export async function gravarSessaoPareada(sessao: Sessao): Promise<void> {
  const creds = { ...initAuthCreds(), me: { id: `${DONO}:7@s.whatsapp.net`, name: "Dono Teste" } };
  await sessao.set({ creds: JSON.stringify(creds, BufferJSON.replacer) });
}

export async function montar(opcoes: OpcoesMontagem = {}): Promise<Montagem> {
  const dir = opcoes.dir ?? mkdtempSync(join(tmpdir(), "wa-teste-"));
  const config: Config = { dirDados: join(dir, "dados"), dirLogs: join(dir, "logs"), maxMensagens: opcoes.maxMensagens ?? 500, limiteDiario: opcoes.limiteDiario ?? 30, limiteNovasConversas: opcoes.limiteNovasConversas ?? 5, pedidosDeHistoricoPorDia: opcoes.pedidosDeHistoricoPorDia ?? 30, avisos: [], socketDeTeste: false, idiomaTranscricao: opcoes.idiomaTranscricao ?? "pt" };
  const caminhoRegistro = join(config.dirLogs, "acoes.jsonl");
  const fabrica = fabricaFalsa();
  const ctx = new Contexto({
    config,
    cofre: opcoes.cofre ?? new CofreEmMemoria(opcoes.chaveHex ?? CHAVE_TESTE),
    criarSocket: fabrica.criar,
    registro: new RegistroAcoes(caminhoRegistro, () => {}),
    ...(opcoes.pid !== undefined ? { pid: opcoes.pid } : {}),
    ...(opcoes.temporizador ? { temporizador: opcoes.temporizador } : {}),
    ...(opcoes.intervaloDoLockMs ? { intervaloDoLockMs: opcoes.intervaloDoLockMs } : {}),
    ...(opcoes.agora ? { agora: opcoes.agora } : {}),
    esperaDigitandoMs: opcoes.esperaDigitandoMs ?? (() => 5),
    ...(opcoes.esperaDoQrMs !== undefined ? { esperaDoQrMs: opcoes.esperaDoQrMs } : {}),
    ...(opcoes.esperaDoHistoricoMs !== undefined ? { esperaDoHistoricoMs: opcoes.esperaDoHistoricoMs } : {}),
    // Nunca a pasta Downloads de verdade: a da montagem, na pasta temporária.
    pastaDeDownloads: join(dir, "Downloads", "WhatsApp Claude"),
    // 0.16.0: a casa é a pasta temporária: o wa_enviar_arquivo só envia de dir/Documents, dir/Downloads...
    casa: dir,
    buscarMidia: opcoes.buscarMidia ?? semMidia,
    carregarMotor: opcoes.carregarMotor ?? semMotor,
    ...(opcoes.decodificarAudio ? { decodificarAudio: opcoes.decodificarAudio } : {}),
    buscarModelo: opcoes.buscarModelo ?? semModelo,
    ...(opcoes.modeloEsperado ? { modeloEsperado: opcoes.modeloEsperado } : {}),
    ...(opcoes.esperaDaTranscricaoMs !== undefined ? { esperaDaTranscricaoMs: opcoes.esperaDaTranscricaoMs } : {}),
    ...(opcoes.caixaPreta ? { caixaPreta: opcoes.caixaPreta } : {}),
    ...(opcoes.carregarSqlite ? { carregarSqlite: opcoes.carregarSqlite } : {}),
    esperaDosContatosMs: opcoes.esperaDosContatosMs ?? 300,
  });
  // Como o stdio.ts: a fábrica nasce na partida e enche o registro de ferramentas (o canal do dono executa por ele).
  fabricaDeServidor(ctx);
  if (opcoes.pareada ?? true) await gravarSessaoPareada((await ctx.nucleo()).sessao);
  return {
    dir,
    config,
    ctx,
    fabrica,
    caminhoRegistro,
    socket: () => fabrica.ultimo(),
    async fechar() {
      await ctx.encerrar();
      if (!opcoes.dir) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Parte e abre a conexão no socket falso. `grupos`: os grupos que o WhatsApp devolve (buscados ao conectar). */
export async function conectar(m: Montagem, opcoes: { grupos?: SocketFalso["grupos"] } = {}): Promise<SocketFalso> {
  await m.ctx.partida();
  const s = m.socket();
  if (opcoes.grupos) s.grupos = opcoes.grupos;
  s.user = { id: `${DONO}:7@s.whatsapp.net`, name: "Dono Teste" };
  s.abrir();
  return s;
}

/** Espera o transporte processar o que já foi disparado. */
export async function assentar(m: Montagem): Promise<void> {
  await m.ctx.transporte?.esperar();
}

export interface OpcoesCliente {
  /** O cliente declara MCP Apps (como o app do Claude). Padrão: true. */
  comTela?: boolean;
  extras?: readonly RegistroExtra[];
}

/** Capacidade de MCP Apps que o app do Claude declara. */
export const CAPACIDADE_DE_TELA = { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } };

export async function conectarCliente(ctx: Contexto, opcoes: OpcoesCliente = {}): Promise<{ cliente: Client; fechar(): Promise<void> }> {
  const server = fabricaDeServidor(ctx, opcoes.extras)();
  const [doCliente, doServidor] = InMemoryTransport.createLinkedPair();
  await server.connect(doServidor);
  const cliente = new Client({ name: "teste", version: "0.0.0" }, (opcoes.comTela ?? true) ? { capabilities: CAPACIDADE_DE_TELA } : {});
  await cliente.connect(doCliente);
  return {
    cliente,
    fechar: async () => {
      await cliente.close();
      await server.close();
    },
  };
}

/** Chama uma ferramenta e devolve o structuredContent (falha o teste se vier erro e `erro` não for esperado). */
export async function chamar(cliente: Client, nome: string, args: Record<string, unknown> = {}, esperaErro = false): Promise<Record<string, unknown>> {
  const r = await cliente.callTool({ name: nome, arguments: args });
  if (Boolean(r.isError) !== esperaErro) throw new Error(`${nome}: isError=${String(r.isError)} ${JSON.stringify(r.content)}`);
  return (r.structuredContent ?? {}) as Record<string, unknown>;
}

/** Temporizador manual: o teste avança o relógio. */
export class RelogioFalso implements Temporizador {
  agoraMs = Date.now();
  #fila: Array<{ quando: number; f: () => void; id: number }> = [];
  #seq = 0;
  setTimeout(f: () => void, ms: number) {
    const id = ++this.#seq;
    this.#fila.push({ quando: this.agoraMs + ms, f, id });
    return { id, unref() {} };
  }
  clearTimeout(t: unknown) {
    const id = (t as { id?: number } | undefined)?.id;
    this.#fila = this.#fila.filter((x) => x.id !== id);
  }
  agora() {
    return this.agoraMs;
  }
  get pendentes(): number[] {
    return this.#fila.map((x) => x.quando - this.agoraMs);
  }
  avancar(ms: number): void {
    this.agoraMs += ms;
    const vencidos = this.#fila.filter((x) => x.quando <= this.agoraMs).sort((a, b) => a.quando - b.quando);
    this.#fila = this.#fila.filter((x) => x.quando > this.agoraMs);
    for (const v of vencidos) v.f();
  }
}

export type Resultado = { isError?: boolean; content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown>; _meta?: Record<string, unknown> };

/** Chama uma ferramenta e devolve o resultado cru (com `_meta`). */
export async function chamarCru(cliente: Client, nome: string, args: Record<string, unknown> = {}): Promise<Resultado> {
  return (await cliente.callTool({ name: nome, arguments: args })) as unknown as Resultado;
}

/** O id do pedido (no structuredContent) e o código (só no `_meta`) de uma prévia. */
export function pedidoDa(previa: Resultado): { id: string; codigo: string } {
  const id = previa.structuredContent?.pedido;
  const codigo = previa._meta?.codigo;
  if (typeof id !== "string" || typeof codigo !== "string") throw new Error(`sem prévia: ${JSON.stringify(previa)}`);
  return { id, codigo };
}

/** O clique no botão do cartão: o que o cartão faz quando o app tem serverTools. */
export async function clicar(cliente: Client, previa: Resultado, texto?: string): Promise<Resultado> {
  const { id, codigo } = pedidoDa(previa);
  const { codigoEditado } = await import("../ui/edicao.js");
  const args = texto === undefined ? { id, codigo } : { id, codigo: codigoEditado(codigo, texto), texto };
  return chamarCru(cliente, "wa_confirmar_tela", args);
}

/**
 * 0.16.0: o caminho do chat (aba Code, cartão sem serverTools): a mensagem que o cartão manda (confirmacaoPeloChat, com o
 * código DE CONVERSA) e a chamada do wa_confirmar que o modelo faz com ela. Num pedido com texto editável, vai o texto
 * mostrado (ou `texto`, se o dono editou).
 */
export async function confirmarPeloChat(cliente: Client, previa: Resultado, texto?: string): Promise<Resultado> {
  const { id, codigo } = pedidoDa(previa);
  const { confirmacaoPeloChat } = await import("../ui/edicao.js");
  const p = previa._meta?.previa as { texto?: string; texto_editavel?: unknown } | undefined;
  const comTexto = p?.texto_editavel ? (texto ?? p.texto ?? "") : null;
  const mensagem = confirmacaoPeloChat(id, codigo, comTexto);
  const doChat = /código ([0-9a-f]+)/.exec(mensagem)![1]!;
  return chamarCru(cliente, "wa_confirmar", comTexto === null ? { id, codigo: doChat } : { id, codigo: doChat, texto: comTexto });
}

/** 0.16.0: o id e o código DE CONVERSA de uma prévia (o que chega ao modelo na mensagem do cartão, num pedido sem texto). */
export async function pedidoPeloChat(previa: Resultado): Promise<{ id: string; codigo: string }> {
  const { id, codigo } = pedidoDa(previa);
  const { codigoDeConversa } = await import("../ui/edicao.js");
  return { id, codigo: codigoDeConversa(codigo) };
}

/** Liga o envio com o clique no cartão do wa_envio. */
export async function ligarEnvio(cliente: Client): Promise<void> {
  const r = await clicar(cliente, await chamarCru(cliente, "wa_envio", { ligar: true }));
  if (r.isError) throw new Error(`não ligou o envio: ${JSON.stringify(r)}`);
}

export const textoDe = (r: Resultado): string => r.content.map((b) => b.text ?? "").join("\n");
