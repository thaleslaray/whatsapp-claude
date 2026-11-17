// 0.11.0: todo caminho de saída deixa rastro na caixa-preta, e a saída normal diz que é normal.
// Buracos fechados (ver FICHA.md, 0.11.0): o transporte do protocolo moderno que fechava (stdout quebrado) sem sair; a
// falha na partida depois da caixa-preta (cofre) que saía sem `saiu`; `process.exit` chamado direto e o laço que esvazia,
// que saíam só com um `saiu` sem motivo; o stderr quebrado dentro do tratador de erro solto; e o `saiu` "código 0,
// 0 s no ar" da troca de versão, que parecia queda e agora vem com o motivo e `normal: true`.
// Sem rede (test/setup.ts no filho também), pastas temporárias, cofre em memória.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, it } from "node:test";
import { ARQUIVO_DA_CAIXA_PRETA, CaixaPreta, nomesNaPilha } from "../src/caixa-preta.ts";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const pastas: string[] = [];
afterEach(() => {
  for (const p of pastas.splice(0)) rmSync(p, { recursive: true, force: true });
});
function pasta(): string {
  const p = mkdtempSync(join(tmpdir(), "wa-saida-"));
  pastas.push(p);
  return p;
}
const linhasDe = (dir: string): Array<Record<string, unknown>> => {
  const caminho = join(dir, ARQUIVO_DA_CAIXA_PRETA);
  if (!existsSync(caminho)) return [];
  return readFileSync(caminho, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
};
const eventos = (dir: string, evento: string) => linhasDe(dir).filter((l) => l.evento === evento);

/** Sobe src/stdio.ts com a trava de teste (socket inerte, cofre em memória, pastas temporárias) e sem rede. */
function subir(extra: Record<string, string> = {}) {
  const base = pasta();
  const logs = join(base, "logs");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("WA_")) env[k] = v;
  Object.assign(env, { HOME: base, WA_TESTE_CHAVE: randomBytes(32).toString("hex"), WA_DADOS_DIR: join(base, "dados"), WA_LOGS_DIR: logs, WA_TESTE_SOCKET: "falso" }, extra);
  const filho = spawn(process.execPath, ["--import", pathToFileURL(join(RAIZ, "test", "setup.ts")).href, join(RAIZ, "src", "stdio.ts")], { env, stdio: ["pipe", "pipe", "pipe"] });
  let erro = "";
  const pronto = new Promise<void>((ok, falha) => {
    const relogio = setTimeout(() => falha(new Error(`o servidor não subiu:\n${erro}`)), 20_000);
    filho.stderr!.on("data", (parte) => {
      erro += parte;
      if (erro.includes("papel_definido")) {
        clearTimeout(relogio);
        ok();
      }
    });
  });
  const saiu = new Promise<number | null>((ok) => filho.on("exit", (codigo) => ok(codigo)));
  const matar = setTimeout(() => filho.kill("SIGKILL"), 30_000);
  void saiu.then(() => clearTimeout(matar));
  return { base, filho, logs, pronto, saiu, erro: () => erro };
}

describe("0.11.0: o servidor de verdade (stdio)", () => {
  it("protocolo moderno: stdout quebrado (EPIPE) fecha o transporte e a cópia SAI com rastro (antes ficava no ar sem cliente)", async () => {
    const s = subir({ WA_PROTOCOLO: "moderno" });
    await s.pronto;
    s.filho.stdout!.destroy();
    s.filho.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } })}\n`);
    const codigo = await s.saiu;
    assert.equal(codigo, 0);
    const saindo = eventos(s.logs, "saindo");
    assert.equal(saindo.length, 1, JSON.stringify(linhasDe(s.logs)));
    assert.equal(saindo[0]!.motivo, "transporte fechou");
    const saiu = eventos(s.logs, "saiu");
    assert.deepEqual([saiu[0]!.codigo, saiu[0]!.motivo, saiu[0]!.normal], [0, "transporte fechou", true]);
  });

  it("a cópia que o app abre e fecha em segundos (troca de versão): `saiu` com o motivo, `normal` e a leitura de que não é queda", async () => {
    const s = subir();
    await s.pronto;
    s.filho.stdin!.end();
    assert.equal(await s.saiu, 0);
    const saiu = eventos(s.logs, "saiu")[0]!;
    assert.equal(saiu.motivo, "entrada padrão terminou");
    assert.equal(saiu.normal, true);
    assert.match(String(saiu.leitura), /troca de versão.*não é queda/);
    assert.ok((saiu.no_ar_ha_s as number) < 5);
  });

  it("SIGTERM: `saiu` com motivo SIGTERM e normal (o SIGINT e o SIGHUP já eram provados na 0.7.3)", async () => {
    const s = subir();
    await s.pronto;
    s.filho.kill("SIGTERM");
    assert.equal(await s.saiu, 0);
    const saiu = eventos(s.logs, "saiu")[0]!;
    assert.deepEqual([saiu.motivo, saiu.normal], ["SIGTERM", true]);
  });

  it("falha na partida DEPOIS da caixa-preta (o cofre não sobe): `exit_direto` e `saiu` com código 1 (antes não havia `saiu`)", async () => {
    // WA_TESTE_CHAVE sem WA_DADOS_DIR: a config passa e o cofre recusa. HOME temporária: a pasta de logs também é.
    const base = pasta();
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("WA_")) env[k] = v;
    Object.assign(env, { HOME: base, WA_TESTE_CHAVE: randomBytes(32).toString("hex") });
    const r = spawnSync(process.execPath, ["--import", pathToFileURL(join(RAIZ, "test", "setup.ts")).href, join(RAIZ, "src", "stdio.ts")], { env, encoding: "utf8", timeout: 20_000 });
    assert.equal(r.status, 1, r.stderr);
    const logs = process.platform === "darwin" ? join(base, "Library", "Logs", "whatsapp-claude") : join(base, "logs");
    const saiu = eventos(logs, "saiu");
    assert.equal(saiu.length, 1, `${JSON.stringify(linhasDe(logs))}\n${r.stderr}`);
    assert.deepEqual([saiu[0]!.codigo, saiu[0]!.motivo, saiu[0]!.normal], [1, "process.exit chamado direto", false]);
    assert.equal(eventos(logs, "exit_direto")[0]!.codigo, 1);
  });
});

describe("0.11.0: saídas sem o `sair` do stdio", () => {
  /** Roda um script num filho com a caixa-preta e o rastro da saída instalados. */
  function rodar(dir: string, corpo: string) {
    const codigo = `
      const { CaixaPreta, instalarRastroDaSaida } = await import(${JSON.stringify(join(RAIZ, "src", "caixa-preta.ts"))});
      const caixa = new CaixaPreta({ dir: ${JSON.stringify(dir)}, saida: () => {} });
      caixa.partida();
      instalarRastroDaSaida(caixa, { estaSaindo: () => false });
      ${corpo}
    `;
    return spawnSync(process.execPath, ["--input-type=module", "-e", codigo], { encoding: "utf8", timeout: 20_000 });
  }

  it("`process.exit` chamado por uma biblioteca: `exit_direto` com o código e os NOMES de quem chamou; `saiu` não normal; vira a última queda", () => {
    const dir = pasta();
    const r = rodar(dir, `function fecharTudoNaBiblioteca() { process.exit(3); } setTimeout(fecharTudoNaBiblioteca, 5);`);
    assert.equal(r.status, 3, r.stderr);
    const exit = eventos(dir, "exit_direto")[0]!;
    assert.equal(exit.codigo, 3);
    assert.ok((exit.chamado_por as string[]).some((n) => n.endsWith("fecharTudoNaBiblioteca")), JSON.stringify(exit));
    assert.ok(!JSON.stringify(exit).includes(dir), "sem caminho");
    const saiu = eventos(dir, "saiu")[0]!;
    assert.deepEqual([saiu.codigo, saiu.motivo, saiu.normal], [3, "process.exit chamado direto", false]);
    const queda = new CaixaPreta({ dir, saida: () => {} }).ultimaQueda();
    assert.equal(queda?.como, "saiu com código 3");
  });

  it("laço de eventos vazio (`beforeExit`): `laco_vazio` e `saiu` com o motivo e normal", () => {
    const dir = pasta();
    const r = rodar(dir, `setTimeout(() => {}, 5);`);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(eventos(dir, "laco_vazio").length, 1);
    const saiu = eventos(dir, "saiu")[0]!;
    assert.deepEqual([saiu.codigo, saiu.motivo, saiu.normal], [0, "laço de eventos vazio", true]);
  });

  it("saída sem motivo nenhum fica marcada como tal (para não parecer normal)", () => {
    const dir = pasta();
    const c = new CaixaPreta({ dir, pid: 4242, saida: () => {} });
    c.partida();
    c.saiu(0);
    const saiu = eventos(dir, "saiu")[0]!;
    assert.deepEqual([saiu.motivo, saiu.normal], ["sem motivo registrado", false]);
    assert.equal("leitura" in saiu, false);
  });

  it("erro solto com o stderr quebrado: o registro fica e o processo segue (antes, o tratador lançava e o Node derrubava com 7)", () => {
    const dir = pasta();
    const codigo = `
      const { instalarTratadoresDeErro, observarErrosSoltos } = await import(${JSON.stringify(join(RAIZ, "src", "saida-segura.ts"))});
      const { CaixaPreta } = await import(${JSON.stringify(join(RAIZ, "src", "caixa-preta.ts"))});
      const c = new CaixaPreta({ dir: ${JSON.stringify(dir)}, saida: () => {} });
      instalarTratadoresDeErro(() => true, () => { const e = new Error("write EPIPE"); e.code = "EPIPE"; throw e; });
      observarErrosSoltos((t, n, f, cod) => c.erroSolto(t, n, f, cod));
      setTimeout(() => { throw new TypeError("estourou num tratador"); }, 5);
      setTimeout(() => process.stdout.write("vivo"), 40);
    `;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", codigo], { encoding: "utf8", timeout: 20_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "vivo");
    assert.equal(eventos(dir, "erro_solto")[0]!.nome, "TypeError");
  });

  it("nomesNaPilha: só nomes de função (sem caminho nem linha)", () => {
    const pilha =
      "Error\n    at exitComRastro (/Users/alguem/x.mjs:1:2)\n    at fecharTudo (/Users/alguem/y.mjs:3:4)\n    at /Users/alguem/z.mjs:5:6\n    at Timeout.fecharDepois [as _onTimeout] (/Users/alguem/w.mjs:1:1)\n    at async outraFuncao (node:internal/timers:1:1)";
    const nomes = nomesNaPilha(pilha, 1);
    assert.deepEqual(nomes, ["fecharTudo", "Timeout.fecharDepois", "outraFuncao"]);
    assert.ok(!nomes.join(" ").includes("/"));
  });
});
