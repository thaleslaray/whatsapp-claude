// 0.11.0: os `canal-*.sock` velhos (de cópias que morreram sem fechar o canal) saem da pasta de dados na partida.
// Só o que recusa conexão (ninguém ouvindo) é apagado; o socket vivo e os outros arquivos ficam; no Windows (named pipe)
// nada é tocado. Sem rede: só conexão por caminho (socket Unix).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { apagarCanaisOrfaos, PADRAO_DO_CANAL } from "../src/canal.ts";
import { CaixaPreta } from "../src/caixa-preta.ts";
import { montar, type Montagem } from "./ajuda.ts";

const pastas: string[] = [];
const servidores: net.Server[] = [];
let m: Montagem | undefined;
afterEach(async () => {
  for (const s of servidores.splice(0)) await new Promise<void>((pronto) => s.close(() => pronto()));
  await m?.fechar();
  m = undefined;
  for (const p of pastas.splice(0)) rmSync(p, { recursive: true, force: true });
});

function pasta(): string {
  // Caminho curto: o socket Unix do macOS aceita no máximo 104 bytes.
  const p = mkdtempSync(join(tmpdir(), "wa-c-"));
  pastas.push(p);
  return p;
}

const nome = (n: number) => `canal-${String(n).padStart(16, "0")}.sock`;

/** Um socket órfão de verdade: um processo escuta no caminho e morre com SIGKILL (o arquivo fica, ninguém ouve). */
async function orfao(caminho: string): Promise<void> {
  const filho = spawn(process.execPath, ["-e", `require("node:net").createServer().listen(${JSON.stringify(caminho)}, () => process.stdout.write("ok"))`], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((pronto) => filho.stdout!.once("data", () => pronto()));
  const saiu = new Promise<void>((pronto) => filho.once("exit", () => pronto()));
  filho.kill("SIGKILL");
  await saiu;
  assert.ok(existsSync(caminho), "o arquivo do socket ficou depois do SIGKILL");
}

async function vivo(caminho: string): Promise<net.Server> {
  const s = net.createServer((sock) => sock.destroy());
  await new Promise<void>((pronto) => s.listen(caminho, () => pronto()));
  servidores.push(s);
  return s;
}

describe("0.11.0: canais órfãos na pasta de dados", () => {
  it("apaga só os que recusam conexão; o vivo, o próprio e os outros arquivos ficam", async () => {
    const dir = pasta();
    await orfao(join(dir, nome(1)));
    await orfao(join(dir, nome(2)));
    await vivo(join(dir, nome(3)));
    await orfao(join(dir, nome(4))); // o "próprio" (o endereço deste processo) nunca é tocado
    writeFileSync(join(dir, "conexao.lock"), "{}");
    writeFileSync(join(dir, "canal-velho.txt"), "x");
    const apagados = await apagarCanaisOrfaos(dir, join(dir, nome(4)), "darwin");
    assert.equal(apagados, 2);
    assert.deepEqual(readdirSync(dir).sort(), ["canal-velho.txt", "conexao.lock", nome(3), nome(4)].sort());
    // O vivo continua aceitando conexão depois da varredura.
    await new Promise<void>((pronto, falha) => {
      const c = net.connect(join(dir, nome(3)));
      c.once("connect", () => {
        c.destroy();
        pronto();
      });
      c.once("error", falha);
    });
  });

  it("no Windows (named pipe) não toca em nada; pasta que não existe não é erro", async () => {
    const dir = pasta();
    await orfao(join(dir, nome(1)));
    assert.equal(await apagarCanaisOrfaos(dir, "\\\\.\\pipe\\whatsapp-claude-0000000000000000", "win32"), 0);
    assert.ok(existsSync(join(dir, nome(1))));
    assert.equal(await apagarCanaisOrfaos(join(dir, "nao-existe"), "x", "darwin"), 0);
    assert.ok(PADRAO_DO_CANAL.test(nome(9)));
    assert.equal(PADRAO_DO_CANAL.test("canal-xyz.sock"), false);
  });

  it("na partida do Contexto: o órfão sai, o vivo (de outra cópia) fica, e a caixa-preta só diz quantos", async () => {
    const base = pasta();
    const dados = join(base, "dados");
    mkdirSync(dados, { recursive: true });
    await orfao(join(dados, nome(1)));
    await vivo(join(dados, nome(2)));
    const linhas: string[] = [];
    const caixaPreta = new CaixaPreta({ saida: (l) => linhas.push(l) });
    m = await montar({ dir: base, caixaPreta });
    await m.ctx.partida();
    const sobra = readdirSync(dados).filter((n) => PADRAO_DO_CANAL.test(n));
    assert.ok(!sobra.includes(nome(1)), "o órfão saiu");
    assert.ok(sobra.includes(nome(2)), "o vivo ficou");
    const evento = linhas.find((l) => l.includes("canais_orfaos_apagados"));
    assert.ok(evento, linhas.join("\n"));
    assert.match(evento!, /"quantos":1/);
    assert.ok(!evento!.includes(dados), "sem caminho");
    assert.ok(!evento!.includes("canal-"), "sem nome de arquivo");
  });
});
