// Pasta de dados 0700 e arquivos 0600, com gravação atômica (arquivo temporário + rename).
//
// Windows: `chmod` não protege nada lá (só liga e desliga "somente leitura"); a pasta em %LOCALAPPDATA% já é só do
// usuário. Então o chmod nem é chamado (protegerPermissao). E o `rename` sobre um arquivo que existe pode falhar por um
// instante (EPERM/EACCES/EBUSY: antivírus ou outro processo lendo): renomearComTentativas tenta de novo poucas vezes,
// com esperas curtas. No Mac e no Linux, nada muda: a primeira falha sobe.

import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

const ESPERA = new Int32Array(new SharedArrayBuffer(4));
const dormir = (ms: number): void => {
  Atomics.wait(ESPERA, 0, 0, ms);
};

/** chmod onde ele protege (Mac, Linux). No Windows não é chamado: lá não protege e não pode quebrar. */
export function protegerPermissao(
  caminho: string,
  modo: number,
  plataforma: NodeJS.Platform = process.platform,
  chmod: (caminho: string, modo: number) => void = chmodSync,
): void {
  if (plataforma === "win32") return;
  chmod(caminho, modo);
}

/** Erros passageiros do rename no Windows. */
const PASSAGEIROS = new Set(["EPERM", "EACCES", "EBUSY"]);
/** Esperas entre as tentativas (ms): 4 novas tentativas, 300 ms no total, no pior caso. */
const ESPERAS_DO_RENAME = [20, 40, 80, 160];

export interface OpcoesDoRename {
  plataforma?: NodeJS.Platform;
  renomear?: (de: string, para: string) => void;
  esperar?: (ms: number) => void;
}

/** `rename` com poucas tentativas curtas no Windows, só para os erros passageiros. Fora do Windows: um `rename` só. */
export function renomearComTentativas(de: string, para: string, opcoes: OpcoesDoRename = {}): void {
  const renomear = opcoes.renomear ?? renameSync;
  const esperar = opcoes.esperar ?? dormir;
  const windows = (opcoes.plataforma ?? process.platform) === "win32";
  for (let tentativa = 0; ; tentativa++) {
    try {
      renomear(de, para);
      return;
    } catch (erro) {
      const code = (erro as NodeJS.ErrnoException).code ?? "";
      if (!windows || !PASSAGEIROS.has(code) || tentativa >= ESPERAS_DO_RENAME.length) throw erro;
      esperar(ESPERAS_DO_RENAME[tentativa]!);
    }
  }
}

export function garantirPasta(caminho: string): void {
  mkdirSync(caminho, { recursive: true, mode: 0o700 });
  protegerPermissao(caminho, 0o700);
}

export function gravarAtomico(caminho: string, conteudo: string): void {
  garantirPasta(dirname(caminho));
  const temporario = `${caminho}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temporario, conteudo, { mode: 0o600 });
  protegerPermissao(temporario, 0o600);
  try {
    renomearComTentativas(temporario, caminho);
  } catch (erro) {
    rmSync(temporario, { force: true });
    throw erro;
  }
}

export function lerOuNulo(caminho: string): string | null {
  try {
    return readFileSync(caminho, "utf8");
  } catch (erro) {
    if ((erro as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw erro;
  }
}

export function apagarArquivo(caminho: string): void {
  rmSync(caminho, { force: true });
}

export function apagarPasta(caminho: string): void {
  if (existsSync(caminho)) rmSync(caminho, { recursive: true, force: true });
}

export function listar(caminho: string): string[] {
  try {
    return readdirSync(caminho);
  } catch {
    return [];
  }
}

/**
 * Nome de arquivo derivado do id com HMAC-SHA256 e a chave da instalação: o número não aparece no nome e,
 * sem a chave, não dá para testar números um a um até achar o arquivo de uma conversa
 * (com SHA-256 puro dava: o espaço de números de telefone é pequeno).
 */
export function nomeDoArquivo(chave: Buffer, id: string): string {
  return createHmac("sha256", chave).update(`arquivo:${id}`).digest("hex").slice(0, 32);
}

/** Marca de versão de um arquivo (inode, data e tamanho): muda a cada gravação atômica. "ausente" se não existe. */
export function marcaDoArquivo(caminho: string): string {
  try {
    const s = statSync(caminho);
    return `${s.ino}:${s.mtimeMs}:${s.size}`;
  } catch {
    return "ausente";
  }
}

/**
 * Trava entre processos para quem grava no banco (o dono da conexão e um leitor que mexe nas listas).
 * Arquivo criado com `wx`; trava com mais de 10 s é considerada abandonada. Síncrona, como o banco.
 */
export function comTravaDeArquivo<T>(caminho: string, trabalho: () => T, esperaMaximaMs = 5_000): T {
  const inicio = Date.now();
  for (;;) {
    try {
      const fd = openSync(caminho, "wx", 0o600);
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      break;
    } catch (erro) {
      if ((erro as NodeJS.ErrnoException).code !== "EEXIST") throw erro;
      try {
        if (Date.now() - statSync(caminho).mtimeMs > 10_000) {
          unlinkSync(caminho);
          continue;
        }
      } catch {
        continue; // sumiu no meio: tenta de novo
      }
      if (Date.now() - inicio > esperaMaximaMs) throw new Error("O banco está ocupado por outro processo do Claude; tente de novo em instantes.");
      dormir(5);
    }
  }
  try {
    return trabalho();
  } finally {
    try {
      unlinkSync(caminho);
    } catch {
      /* já sumiu */
    }
  }
}

export const unir = join;
