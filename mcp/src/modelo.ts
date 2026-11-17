// 0.7.0, parte 3: o modelo de transcrição (whisper.cpp, ggml-small-q5_1.bin, 190 MB).
// NÃO vai no pacote: é baixado uma vez, com o clique do dono num cartão, para uma subpasta da pasta de dados
// (`modelos/`), SEM cifra (é um arquivo público, igual para todo mundo). O wa_desconectar não o apaga.
//
// Download seguro:
// - só HTTPS, e cada redirecionamento só para um host da lista fechada (HOSTS_DO_MODELO); nada de seguir sozinho
//   (`redirect: "manual"`), no máximo 5 saltos;
// - teto de tamanho (o tamanho exato esperado; passou, para) e o sha256 conferido enquanto baixa;
// - grava num `.tmp` e só troca de nome no fim, com o sha256 certo. Hash errado: apaga e avisa.
// O `fetch` é injetável: a suíte e o autoteste nunca usam a rede.

import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, renameSync, statSync, writeSync } from "node:fs";
import { apagarArquivo, garantirPasta, unir } from "./pasta.ts";

export interface ModeloEsperado {
  url: string;
  tamanho: number;
  sha256: string;
  nome: string;
}

/** O modelo de verdade: medido em 13/11/2026 (tamanho e sha256 conferem com o `x-linked-etag` do Hugging Face). */
export const MODELO_PADRAO: ModeloEsperado = {
  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin",
  tamanho: 190_085_487,
  sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
  nome: "ggml-small-q5_1.bin",
};

/**
 * Hosts para onde o download pode ir. `huggingface.co` e `us.aws.cdn.hf.co` foram vistos de verdade (302 para a CDN);
 * os outros são as CDNs conhecidas do Hugging Face (Europa, Xet e as LFS antigas), NÃO observadas neste teste.
 */
export const HOSTS_DO_MODELO: readonly string[] = [
  "huggingface.co",
  "us.aws.cdn.hf.co",
  "eu.aws.cdn.hf.co",
  "cas-bridge.xethub.hf.co",
  "cdn-lfs.hf.co",
  "cdn-lfs-us-1.hf.co",
  "cdn-lfs-eu-1.hf.co",
];

const MAXIMO_DE_SALTOS = 5;

export type EstadoDoModelo =
  | { situacao: "ausente" }
  | { situacao: "baixando"; recebidos: number; total: number }
  | { situacao: "pronto"; caminho: string }
  | { situacao: "erro"; motivo: string };

export const pastaDosModelos = (dirDados: string): string => unir(dirDados, "modelos");

export class Modelo {
  readonly caminho: string;
  readonly pasta: string;
  readonly esperado: ModeloEsperado;
  readonly #buscar: typeof fetch;
  #baixando: { recebidos: number; total: number } | undefined;
  #erro: string | undefined;
  /** O sha256 do arquivo no disco já foi conferido neste processo (e o tamanho e a data dele, quando). */
  #conferido: { tamanho: number; mtimeMs: number } | undefined;
  #download: Promise<void> | undefined;
  /** 0.7.3: a caixa-preta acompanha o download (só o nome da etapa). */
  readonly #acompanhar: ((trabalho: () => Promise<void>) => Promise<void>) | undefined;

  constructor(opcoes: { dirDados: string; buscar?: typeof fetch; esperado?: ModeloEsperado; acompanharDownload?: (trabalho: () => Promise<void>) => Promise<void> }) {
    this.esperado = opcoes.esperado ?? MODELO_PADRAO;
    this.pasta = pastaDosModelos(opcoes.dirDados);
    this.caminho = unir(this.pasta, this.esperado.nome);
    this.#buscar = opcoes.buscar ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.#acompanhar = opcoes.acompanharDownload;
  }

  estado(): EstadoDoModelo {
    if (this.#baixando) return { situacao: "baixando", ...this.#baixando };
    if (this.#temArquivo()) return { situacao: "pronto", caminho: this.caminho };
    if (this.#erro) return { situacao: "erro", motivo: this.#erro };
    return { situacao: "ausente" };
  }

  #temArquivo(): boolean {
    try {
      const s = statSync(this.caminho);
      return s.isFile() && s.size === this.esperado.tamanho;
    } catch {
      return false;
    }
  }

  /**
   * Confere o sha256 do arquivo no disco antes de carregá-lo (uma vez por processo, enquanto o arquivo não mudar).
   * Não confere: apaga e lança. Lê em pedaços (não segura 190 MB na memória).
   */
  conferir(): string {
    const s = statSync(this.caminho);
    if (this.#conferido && this.#conferido.tamanho === s.size && this.#conferido.mtimeMs === s.mtimeMs) return this.caminho;
    const h = createHash("sha256");
    const fd = openSync(this.caminho, "r");
    try {
      const b = Buffer.alloc(4 * 1024 * 1024);
      for (;;) {
        const n = readSync(fd, b, 0, b.length, null);
        if (n === 0) break;
        h.update(b.subarray(0, n));
      }
    } finally {
      closeSync(fd);
    }
    if (h.digest("hex") !== this.esperado.sha256) {
      apagarArquivo(this.caminho);
      this.#conferido = undefined;
      this.#erro = "O modelo guardado não conferia (sha256) e foi apagado.";
      throw new Error("O modelo de transcrição guardado não confere (sha256): apaguei. Baixe de novo pelo wa_transcrever.");
    }
    this.#conferido = { tamanho: s.size, mtimeMs: s.mtimeMs };
    return this.caminho;
  }

  /** Começa o download em segundo plano (uma vez; um segundo pedido só acompanha o primeiro). */
  iniciarDownload(): Promise<void> {
    if (this.#temArquivo()) return Promise.resolve();
    this.#download ??= (this.#acompanhar ? this.#acompanhar(() => this.#baixar()) : this.#baixar()).finally(() => {
      this.#download = undefined;
    });
    return this.#download;
  }

  async #baixar(): Promise<void> {
    this.#erro = undefined;
    this.#baixando = { recebidos: 0, total: this.esperado.tamanho };
    const tmp = `${this.caminho}.tmp`;
    try {
      garantirPasta(this.pasta);
      apagarArquivo(tmp);
      const resposta = await this.#seguir(this.esperado.url);
      const declarado = Number(resposta.headers.get("content-length") ?? "NaN");
      if (Number.isFinite(declarado) && declarado !== this.esperado.tamanho) {
        throw new Error(`o servidor anunciou ${declarado} bytes, e o modelo tem ${this.esperado.tamanho}`);
      }
      if (!resposta.body) throw new Error("a resposta veio sem conteúdo");
      const h = createHash("sha256");
      const fd = openSync(tmp, "wx", 0o600);
      let recebidos = 0;
      try {
        const leitor = resposta.body.getReader();
        for (;;) {
          const { done, value } = await leitor.read();
          if (done) break;
          recebidos += value.length;
          if (recebidos > this.esperado.tamanho) {
            await leitor.cancel().catch(() => {});
            throw new Error(`o arquivo passou de ${this.esperado.tamanho} bytes`);
          }
          h.update(value);
          writeSync(fd, value);
          this.#baixando = { recebidos, total: this.esperado.tamanho };
        }
      } finally {
        closeSync(fd);
      }
      if (recebidos !== this.esperado.tamanho) throw new Error(`chegaram ${recebidos} de ${this.esperado.tamanho} bytes`);
      if (h.digest("hex") !== this.esperado.sha256) {
        apagarArquivo(tmp);
        throw new Error("o arquivo baixado não confere (sha256) e foi apagado");
      }
      renameSync(tmp, this.caminho);
      this.#conferido = { tamanho: statSync(this.caminho).size, mtimeMs: statSync(this.caminho).mtimeMs };
    } catch (erro) {
      apagarArquivo(tmp);
      this.#erro = `O download do modelo falhou: ${erro instanceof Error ? erro.message : String(erro)}.`;
    } finally {
      this.#baixando = undefined;
    }
  }

  /** GET sem seguir redirecionamento sozinho: cada salto é conferido (HTTPS e host da lista). */
  async #seguir(inicio: string): Promise<Response> {
    let url = inicio;
    for (let salto = 0; salto <= MAXIMO_DE_SALTOS; salto++) {
      const alvo = new URL(url);
      if (alvo.protocol !== "https:") throw new Error(`endereço recusado (só HTTPS): ${alvo.protocol}//${alvo.hostname}`);
      if (!HOSTS_DO_MODELO.includes(alvo.hostname)) throw new Error(`endereço recusado (host fora da lista): ${alvo.hostname}`);
      const r = await this.#buscar(alvo.href, { redirect: "manual" });
      if ([301, 302, 303, 307, 308].includes(r.status)) {
        const proximo = r.headers.get("location");
        await r.body?.cancel().catch(() => {});
        if (!proximo) throw new Error("redirecionamento sem destino");
        url = new URL(proximo, alvo).href;
        continue;
      }
      if (r.status !== 200) {
        await r.body?.cancel().catch(() => {});
        throw new Error(`o servidor respondeu ${r.status}`);
      }
      return r;
    }
    throw new Error("redirecionamentos demais");
  }

  /** Para os testes: espera o download em andamento terminar. */
  async esperar(): Promise<void> {
    await this.#download;
  }

  existeTemporario(): boolean {
    return existsSync(`${this.caminho}.tmp`);
  }
}
