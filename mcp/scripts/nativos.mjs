// Prepara o motor de transcrição nativo para o pacote (prebuild): um index.node por sistema, de
// @fugood/node-whisper-<sistema>-<arch>@1.2.0-rc.2 (whisper.cpp), em mcpb/server/nativo/<sistema>-<arch>/index.node.
// - Cada pacote é baixado UMA vez com `npm pack` (do registro do npm) e guardado em mcp/nativo/ (fora do git);
// - o .tgz é conferido pela integridade (sha512) fixada aqui, e o index.node extraído pelo sha256 fixado aqui (o
//   mesmo de src/transcricao.ts, que confere de novo antes de carregar). Não confere: o build para.
// Nada de script de instalação: o .tgz só é aberto com `tar` e só o index.node sai dele.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(RAIZ, "nativo");
const DESTINO = join(RAIZ, "mcpb", "server", "nativo");
const VERSAO = "1.2.0-rc.2";

const NATIVOS = {
  "darwin-arm64": {
    integridade: "sha512-UfOd1pe4pwuHMklgOZ/e/Nu6iCa8AntdmBfqw05wY98/dqnYUOcQJ9Y83cHQyps5Giwy5RZL/9SL2mWJB/OuDg==",
    sha256: "e297604e0f0d8b73e798cabb113f014fc9464bf69d070eb9178d338b5bc64bbe",
  },
  "darwin-x64": {
    integridade: "sha512-LCZaJpJU9TC+/2zwywk0K31p9ducGZDRroWtuGnYiE/yFxO80lMb383kf8QdvgHaYjDttTe7zNGURNYZVQzu3w==",
    sha256: "cbfceeaa9b2a32798844f4b90c4fbe4aec73d6c1b909de7992499479e6d5837b",
  },
  "win32-x64": {
    integridade: "sha512-cS4wEGbH/SECExr6P2CE7fRBnQck1DxFKaRbvgCd2UA/76XZDJ1daVfQUWBrmHYCI5+gCiMfZ7llI0yFXQJ4hQ==",
    sha256: "7fceedb85a05e62613c392cb2107c3fef42788c51fcc5374fd1c6e197c748572",
  },
  "win32-arm64": {
    integridade: "sha512-KngEFr8YZi1lk9sRbJN7hKyKvUVbW3TCZYGKiGDgRu0JEqXtde37A1v9t7y96EwW94AbyP14iZxKFRWkukN/mA==",
    sha256: "ff2bfd896776347076ad7aafa900cf94670edc98f780b5932709455b920b999c",
  },
};

const integridadeDe = (b) => `sha512-${createHash("sha512").update(b).digest("base64")}`;
const sha256De = (b) => createHash("sha256").update(b).digest("hex");

// O sha256 daqui e o de src/transcricao.ts têm de ser os mesmos.
const fonte = readFileSync(join(RAIZ, "src", "transcricao.ts"), "utf8");
for (const [chave, { sha256 }] of Object.entries(NATIVOS)) {
  if (!fonte.includes(`"${chave}": "${sha256}"`)) throw new Error(`nativos: o sha256 de ${chave} difere do de src/transcricao.ts`);
}

mkdirSync(CACHE, { recursive: true });
rmSync(DESTINO, { recursive: true, force: true });
for (const [chave, esperado] of Object.entries(NATIVOS)) {
  const tgz = join(CACHE, `fugood-node-whisper-${chave}-${VERSAO}.tgz`);
  if (!existsSync(tgz)) {
    execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["pack", `@fugood/node-whisper-${chave}@${VERSAO}`, "--pack-destination", CACHE, "--silent"], {
      stdio: ["ignore", "ignore", "inherit"],
    });
  }
  const integridade = integridadeDe(readFileSync(tgz));
  if (integridade !== esperado.integridade) {
    rmSync(tgz, { force: true });
    throw new Error(`nativos: ${chave}: o .tgz não confere com a integridade fixada (apaguei; rode de novo para baixar)`);
  }
  const tmp = mkdtempSync(join(tmpdir(), "wa-nativo-"));
  try {
    execFileSync("tar", ["-xzf", tgz, "-C", tmp, "package/index.node"], { stdio: ["ignore", "ignore", "inherit"] });
    const node = join(tmp, "package", "index.node");
    if (sha256De(readFileSync(node)) !== esperado.sha256) throw new Error(`nativos: ${chave}: o index.node não confere (sha256)`);
    mkdirSync(join(DESTINO, chave), { recursive: true });
    copyFileSync(node, join(DESTINO, chave, "index.node"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
process.stderr.write(`nativos: ${Object.keys(NATIVOS).length} motores conferidos em mcpb/server/nativo\n`);
