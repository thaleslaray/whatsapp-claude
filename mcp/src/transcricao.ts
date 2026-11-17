// 0.7.0, parte 3: transcrição local de áudio com o whisper.cpp nativo (@fugood/node-whisper 1.2.0-rc.2).
// - O motor nativo vai no pacote, um por sistema: server/nativo/<sistema>-<arch>/index.node (darwin-arm64, darwin-x64,
//   win32-x64, win32-arm64). É carregado pelo caminho absoluto, só depois de conferir o sha256 contra a tabela abaixo,
//   e só quando a primeira transcrição pede (carga preguiçosa).
// - Mac com Apple Silicon: GPU (Metal), e o modelo fica carregado por 10 min sem uso, depois é solto. Os outros: CPU,
//   no máximo 4 threads (nunca todos os núcleos), e o modelo é solto assim que a fila esvazia.
// - Falha ao carregar não derruba a extensão: quem chama recebe o motivo (a ferramenta diz que a transcrição não está
//   disponível neste computador e devolve o caminho do áudio).
// - Áudio: OGG/Opus (nota de voz do WhatsApp) decodificado pelo `ogg-opus-decoder` (WASM, só converte o áudio), de
//   48 kHz para 16 kHz com um passa-baixa FIR (95 coeficientes, sinc com janela de Hamming, corte em 7,2 kHz) e
//   dizimação por 3, e então para PCM de 16 bits, que é o que o motor recebe.
// - Uma transcrição por vez (fila única). O stdout é do protocolo MCP: o motor nativo escreve os logs dele no stderr
//   (medido: 0 byte no stdout, com GPU e com CPU), e por isso o log nativo NÃO é desviado (`toggleNativeLog` com
//   callback segura o processo vivo para sempre).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { limpar } from "./segredos.ts";

/** sha256 de cada index.node do @fugood/node-whisper-<sistema>-<arch>@1.2.0-rc.2 (conferidos com a integridade do npm). */
export const NATIVOS: Readonly<Record<string, string>> = {
  "darwin-arm64": "e297604e0f0d8b73e798cabb113f014fc9464bf69d070eb9178d338b5bc64bbe",
  "darwin-x64": "cbfceeaa9b2a32798844f4b90c4fbe4aec73d6c1b909de7992499479e6d5837b",
  "win32-x64": "7fceedb85a05e62613c392cb2107c3fef42788c51fcc5374fd1c6e197c748572",
  "win32-arm64": "ff2bfd896776347076ad7aafa900cf94670edc98f780b5932709455b920b999c",
};

/** Teto de duração de um áudio a transcrever. */
export const DURACAO_MAXIMA_S = 30 * 60;
/** Mac com Apple Silicon: quanto o modelo fica carregado sem uso. */
export const OCIOSO_COM_GPU_MS = 10 * 60 * 1000;

export interface OpcoesDaTranscricao {
  idioma: string;
  prompt: string;
  onProgress?: (porcento: number) => void;
}

/** O que a ferramenta precisa do motor: transcrever PCM de 16 bits, 16 kHz, mono. */
export interface MotorDeTranscricao {
  transcrever(pcm: Int16Array, opcoes: OpcoesDaTranscricao): Promise<string>;
  liberar(): Promise<void>;
}

export type CarregarMotor = (caminhoDoModelo: string) => Promise<MotorDeTranscricao>;
export type DecodificarAudio = (ogg: Buffer) => Promise<Int16Array>;

/** Como o motor roda nesta máquina (GPU só no Mac com Apple Silicon; threads nunca todos os núcleos, no máximo 4). */
export function planoDoMotor(plataforma: string, arch: string, nucleos: number): { gpu: boolean; threads: number; ociosoMs: number } {
  const gpu = plataforma === "darwin" && arch === "arm64";
  return { gpu, threads: Math.min(4, Math.max(1, nucleos - 1)), ociosoMs: gpu ? OCIOSO_COM_GPU_MS : 0 };
}

/** O arquivo nativo desta máquina dentro do pacote, conferido pelo sha256. Lança com o motivo em português. */
export function conferirNativo(dirNativo: string, plataforma: string, arch: string): string {
  const chave = `${plataforma}-${arch}`;
  const esperado = NATIVOS[chave];
  if (!esperado) throw new Error(`não há motor de transcrição para este sistema (${chave}); só Mac (Apple Silicon e Intel) e Windows (x64 e ARM)`);
  const caminho = join(dirNativo, chave, "index.node");
  let conteudo: Buffer;
  try {
    conteudo = readFileSync(caminho);
  } catch {
    throw new Error(`o motor de transcrição não está no pacote (${chave}/index.node)`);
  }
  if (createHash("sha256").update(conteudo).digest("hex") !== esperado) throw new Error(`o motor de transcrição do pacote não confere (sha256, ${chave})`);
  return caminho;
}

interface ModuloNativo {
  WhisperContext: new (o: { filePath: string; useGpu: boolean }) => Promise<ContextoNativo> | ContextoNativo;
}
interface ContextoNativo {
  transcribeData(
    dados: ArrayBuffer,
    o: { language: string; maxThreads: number; prompt?: string; onProgress?: (p: number) => void },
  ): { promise: Promise<{ result: string }>; stop: () => void };
  release(): Promise<void> | void;
}

/** Carrega o .node pelo caminho absoluto (process.dlopen: nada de procurar em node_modules). */
function carregarModulo(caminho: string): ModuloNativo {
  const m = { exports: {} as unknown };
  process.dlopen(m as { exports: unknown } & NodeJS.Module, caminho);
  const mod = m.exports as Partial<ModuloNativo>;
  if (typeof mod.WhisperContext !== "function") throw new Error("o motor de transcrição carregou, mas não tem WhisperContext");
  return mod as ModuloNativo;
}

/** O carregador de verdade: confere o .node, carrega e abre o modelo (GPU no Mac com Apple Silicon). */
export function carregadorNativo(dirNativo: string, plataforma = process.platform, arch = process.arch): CarregarMotor {
  return async (caminhoDoModelo) => {
    const plano = planoDoMotor(plataforma, arch, availableParallelism());
    const mod = carregarModulo(conferirNativo(dirNativo, plataforma, arch));
    const ctx = await new mod.WhisperContext({ filePath: caminhoDoModelo, useGpu: plano.gpu });
    return {
      async transcrever(pcm, o) {
        const copia = pcm.slice(); // o motor recebe um ArrayBuffer só dele
        const { promise } = ctx.transcribeData(copia.buffer, {
          language: o.idioma,
          maxThreads: plano.threads,
          ...(o.prompt ? { prompt: o.prompt } : {}),
          ...(o.onProgress ? { onProgress: o.onProgress } : {}),
        });
        return (await promise).result;
      },
      async liberar() {
        await ctx.release();
      },
    };
  };
}

// ---------- áudio ----------

/** É OGG com Opus (a nota de voz do WhatsApp)? Pelo começo do arquivo, não pelo mimetype de quem mandou. */
export function ehOggOpus(b: Buffer): boolean {
  return b.length >= 36 && b.subarray(0, 4).toString("latin1") === "OggS" && b.subarray(28, 36).toString("latin1") === "OpusHead";
}

const COEFICIENTES = (() => {
  const taps = 95;
  const fc = 7200 / 48000;
  const h = new Float32Array(taps);
  let soma = 0;
  for (let i = 0; i < taps; i++) {
    const n = i - (taps - 1) / 2;
    const sinc = n === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
    h[i] = sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1)));
    soma += h[i]!;
  }
  for (let i = 0; i < taps; i++) h[i]! /= soma;
  return h;
})();

/** 48 kHz -> 16 kHz (passa-baixa FIR e dizimação por 3) e Float -> PCM de 16 bits. */
export function de48Para16(x: Float32Array): Int16Array {
  const h = COEFICIENTES;
  const meio = (h.length - 1) / 2;
  const y = new Int16Array(Math.floor(x.length / 3));
  for (let k = 0; k < y.length; k++) {
    const c = k * 3;
    let acc = 0;
    for (let i = 0; i < h.length; i++) {
      const j = c + i - meio;
      if (j >= 0 && j < x.length) acc += h[i]! * x[j]!;
    }
    y[k] = Math.round(Math.max(-1, Math.min(1, acc)) * 32767);
  }
  return y;
}

/** O decodificador de verdade (WASM, carregado só quando pedido). Mistura os canais em mono. */
export const decodificarOggOpus: DecodificarAudio = async (ogg) => {
  const { OggOpusDecoder } = await import("ogg-opus-decoder");
  const dec = new OggOpusDecoder();
  try {
    await dec.ready;
    const { channelData, sampleRate } = await dec.decodeFile(new Uint8Array(ogg));
    if (sampleRate !== 48000) throw new Error(`taxa inesperada (${sampleRate} Hz)`);
    const canais = channelData.filter((c) => c.length > 0);
    if (canais.length === 0) throw new Error("o áudio não tem som");
    const mono = canais.length === 1 ? canais[0]! : new Float32Array(canais[0]!.length).map((_, i) => canais.reduce((s, c) => s + (c[i] ?? 0), 0) / canais.length);
    return de48Para16(mono);
  } finally {
    dec.free();
  }
};

/** O prompt do motor: só o nome da conversa e, em grupo, quem falou. Limpo (sem jid, número, controle) e curto. */
export function promptDaTranscricao(o: { nome?: string | undefined; grupo: boolean; quemFalou?: string | undefined }): string {
  const limparNome = (s: string | undefined) =>
    limpar(s ?? "")
      .replace(/[\p{Cc}\p{Cf}]/gu, " ")
      .replace(/\+?\d[\d\s().-]{6,}\d/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
  const nome = limparNome(o.nome);
  const quem = limparNome(o.quemFalou);
  const partes = o.grupo ? [nome && `Grupo ${nome}.`, quem && `Fala de ${quem}.`] : [nome && `Conversa com ${nome}.`];
  return partes.filter(Boolean).join(" ").slice(0, 200);
}

// ---------- fila ----------

export type SituacaoDoTrabalho = "na_fila" | "transcrevendo" | "pronta" | "erro";

export interface Trabalho {
  chave: string;
  situacao: SituacaoDoTrabalho;
  progresso: number;
  duracaoS: number;
  inicio: number;
  gastoMs?: number;
  texto?: string;
  erro?: string;
  /** Resolve quando termina (bem ou mal); nunca rejeita. */
  fim: Promise<void>;
}

export interface OpcoesDaFila {
  carregar: () => Promise<MotorDeTranscricao>;
  ociosoMs: number;
  agora?: () => number;
}

/**
 * Fila única de transcrições: uma por vez, com o motor carregado sob demanda e solto quando fica ocioso. Um trabalho
 * por mensagem (`chave` = "jid|id"): pedir de novo a mesma mensagem acompanha o trabalho que já existe.
 */
export class FilaDeTranscricao {
  readonly trabalhos = new Map<string, Trabalho>();
  readonly #o: OpcoesDaFila;
  #cauda: Promise<void> = Promise.resolve();
  #motor: Promise<MotorDeTranscricao> | undefined;
  #ocioso: ReturnType<typeof setTimeout> | undefined;
  #andando = 0;

  constructor(o: OpcoesDaFila) {
    this.#o = o;
  }

  /** O motor carregado (ou carregando). Falha não fica guardada: a próxima tentativa carrega de novo. */
  motor(): Promise<MotorDeTranscricao> {
    clearTimeout(this.#ocioso);
    this.#motor ??= this.#o.carregar();
    this.#motor.catch(() => {
      this.#motor = undefined;
    });
    return this.#motor;
  }

  /** Põe um trabalho na fila. `aoTerminar` grava o texto (no banco) antes de o trabalho virar "pronta". */
  colocar(chave: string, duracaoS: number, executar: (motor: MotorDeTranscricao, progresso: (p: number) => void) => Promise<string>, aoTerminar: (texto: string) => void): Trabalho {
    const agora = this.#o.agora ?? Date.now;
    let terminar!: () => void;
    const t: Trabalho = { chave, situacao: "na_fila", progresso: 0, duracaoS, inicio: agora(), fim: new Promise((r) => (terminar = r)) };
    this.trabalhos.set(chave, t);
    this.#andando++;
    this.#cauda = this.#cauda.then(async () => {
      t.situacao = "transcrevendo";
      const comeco = agora();
      try {
        const motor = await this.motor();
        const texto = (await executar(motor, (p) => (t.progresso = Math.max(t.progresso, Math.min(100, Math.round(p)))))).trim();
        aoTerminar(texto);
        t.texto = texto;
        t.progresso = 100;
        t.situacao = "pronta";
      } catch (erro) {
        t.erro = limpar(erro instanceof Error ? erro.message : String(erro));
        t.situacao = "erro";
      } finally {
        t.gastoMs = agora() - comeco;
        this.#andando--;
        if (this.#andando === 0) this.#agendarSoltura();
        terminar();
      }
    });
    return t;
  }

  #agendarSoltura(): void {
    clearTimeout(this.#ocioso);
    if (this.#o.ociosoMs <= 0) {
      void this.liberar();
      return;
    }
    this.#ocioso = setTimeout(() => void this.liberar(), this.#o.ociosoMs);
    this.#ocioso.unref?.();
  }

  /** Solta o motor (se nada está andando). */
  async liberar(): Promise<void> {
    clearTimeout(this.#ocioso);
    if (this.#andando > 0 || !this.#motor) return;
    const m = this.#motor;
    this.#motor = undefined;
    try {
      await (await m).liberar();
    } catch {
      // não carregou: nada a soltar
    }
  }

  /** Quantos trabalhos estão na frente deste. */
  naFrente(chave: string): number {
    let n = 0;
    for (const t of this.trabalhos.values()) {
      if (t.chave === chave) break;
      if (t.situacao === "na_fila" || t.situacao === "transcrevendo") n++;
    }
    return n;
  }
}
