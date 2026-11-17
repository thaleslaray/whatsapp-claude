// Cofre automático do sistema (0.5.0, depois que o dono descartou a "Senha do cofre"):
// - Mac: a chave nasce aleatória e vai para o Keychain pela ENTRADA PADRÃO do `security -i` (nunca no argv), como na 0.4.0;
// - Windows: a chave nasce aleatória e é protegida pela DPAPI do usuário, pelo Windows PowerShell 5.1 só com cmdlets,
//   com o script pela entrada padrão; o bloco cifrado fica em `cofre-chave.dpapi` na pasta de dados;
// - outros sistemas: erro de configuração.
// Tudo com executor falso: nada toca o Keychain de verdade nem roda PowerShell.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { Banco } from "../src/banco.ts";
import {
  ARQUIVO_DPAPI,
  caminhoDoPowerShell,
  CofreDpapi,
  CofreEmMemoria,
  CofreKeychain,
  escolherCofre,
  scriptDeAbrir,
  scriptDeProteger,
} from "../src/cofre.ts";
import { ErroConfig, lerConfig } from "../src/config.ts";
import { esquecerSegredos, limpar } from "../src/segredos.ts";
import type { Executor, ResultadoComando } from "../src/sistema.ts";

function keychainFalso() {
  const guardado = new Map<string, string>();
  const chamadas: Array<{ comando: string; args: readonly string[]; entrada?: string }> = [];
  const executar: Executor = async (comando, args, entrada) => {
    chamadas.push({ comando, args, ...(entrada !== undefined ? { entrada } : {}) });
    if (args[0] === "find-generic-password") {
      const v = guardado.get(`${args[2]}/${args[4]}`);
      return v === undefined ? { codigo: 44, stdout: "", stderr: "" } : { codigo: 0, stdout: `${v}\n`, stderr: "" };
    }
    if (args[0] === "-i") {
      const m = /add-generic-password -s (\S+) -a (\S+) -w "([0-9a-f]{64})"/.exec(entrada ?? "");
      if (m) guardado.set(`${m[1]}/${m[2]}`, m[3]!);
      return { codigo: 0, stdout: "", stderr: "" };
    }
    return { codigo: 1, stdout: "", stderr: "" };
  };
  return { executar, chamadas, guardado };
}

describe("cofre do Mac (Keychain)", () => {
  it("cria a chave uma vez, pela entrada padrão, e depois só lê", async () => {
    esquecerSegredos();
    const k = keychainFalso();
    const cofre = new CofreKeychain({ executar: k.executar });
    const chave = await cofre.obterChave();
    assert.equal(chave.length, 32);
    const hex = chave.toString("hex");
    for (const c of k.chamadas) assert.ok(!c.args.join(" ").includes(hex), "a chave nunca vai no argv");
    assert.ok(k.chamadas.some((c) => c.entrada?.includes(hex)), "foi pela entrada padrão");
    assert.ok(k.chamadas.every((c) => c.comando === "security"));
    assert.ok(k.guardado.has("whatsapp-claude/chave-aes"), "serviço whatsapp-claude, conta chave-aes");
    assert.equal((await new CofreKeychain({ executar: k.executar }).obterChave()).toString("hex"), hex);
    assert.equal(limpar(`vazou ${hex} e ${chave.toString("base64")}`), "vazou ‹segredo› e ‹segredo›");
    esquecerSegredos();
  });

  it("Keychain trancado: erro que diz o que fazer (o contexto tenta de novo, M6)", async () => {
    const cofre = new CofreKeychain({ executar: async () => ({ codigo: 36, stdout: "", stderr: "" }) });
    await assert.rejects(cofre.obterChave(), /Keychain.*código 36.*desbloqueado/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
/**
 * DPAPI falsa: "protege" com XOR 0x5a e prefixo, e só abre o que ela mesma protegeu (como a DPAPI de outra conta não
 * abre). Anota cada chamada. `quebrar` muda o comportamento para simular os casos de falha.
 */
function dpapiFalsa(opcoes: { atraso?: boolean } = {}) {
  const chamadas: Array<{ comando: string; args: readonly string[]; entrada: string }> = [];
  const conhecidos = new Set<string>();
  let modo: "ok" | "sem-powershell" | "nao-abre" | "nunca-abre" | "proteger-falha" | "saida-ruim" = "ok";
  const proteger = (hex: string) => "01000000d08c9ddf" + Buffer.from(Buffer.from(hex, "hex").map((b) => b ^ 0x5a)).toString("hex");
  const executar: Executor = async (comando, args, entrada = "") => {
    chamadas.push({ comando, args, entrada });
    if (opcoes.atraso) await new Promise((ok) => setImmediate(ok));
    if (modo === "sem-powershell") throw new Error(`Não consegui rodar o comando ${comando} (ENOENT).`);
    const r = (codigo: number, stdout: string, stderr = ""): ResultadoComando => ({ codigo, stdout, stderr });
    const p = /ConvertTo-SecureString -String '([0-9a-f]+)' -AsPlainText -Force/.exec(entrada);
    if (p) {
      if (modo === "proteger-falha") return r(1, "", "erro");
      if (modo === "saida-ruim") return r(0, "isto não é hex\r\n");
      const bloco = proteger(p[1]!);
      conhecidos.add(bloco);
      return r(0, `${bloco}\r\n`);
    }
    const a = /ConvertTo-SecureString -String '([0-9a-f]+)'\)\)/.exec(entrada);
    if (a) {
      if (modo === "nunca-abre") return r(1, "", "Cannot access property in this language mode");
      if (modo === "nao-abre" || !conhecidos.has(a[1]!)) return r(1, "", "Key not valid for use in specified state.");
      const hex = Buffer.from(Buffer.from(a[1]!.slice(16), "hex").map((b) => b ^ 0x5a)).toString("hex");
      return r(0, `${hex}\r\n`);
    }
    return r(1, "", "script desconhecido");
  };
  return {
    executar,
    chamadas,
    conhecidos,
    set modo(m: typeof modo) {
      modo = m;
    },
  };
}

const pastas: string[] = [];
afterEach(() => {
  for (const p of pastas.splice(0)) rmSync(p, { recursive: true, force: true });
});
const pasta = () => {
  const p = mkdtempSync(join(tmpdir(), "wa-cofre-"));
  pastas.push(p);
  return p;
};
const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const novoDpapi = (dirDados: string, executar: Executor) => new CofreDpapi({ dirDados, executar, env: {} });

describe("cofre do Windows (DPAPI pelo PowerShell, só cmdlets)", () => {
  it("o PowerShell é chamado pelo caminho absoluto, de %SystemRoot% (ou %windir%, ou C:\\Windows)", () => {
    assert.equal(caminhoDoPowerShell({ SystemRoot: "D:\\Win" }), "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    assert.equal(caminhoDoPowerShell({ windir: "E:\\W" }), "E:\\W\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    assert.equal(caminhoDoPowerShell({}), POWERSHELL);
  });

  it("os dois scripts: uma instrução por linha, só cmdlets e tipos do modo restrito, e só aceitam hexadecimal", () => {
    const hex = "ab".repeat(32);
    assert.equal(
      scriptDeProteger(hex),
      `$ErrorActionPreference = 'Stop'\nConvertFrom-SecureString -SecureString (ConvertTo-SecureString -String '${hex}' -AsPlainText -Force)\n`,
    );
    assert.equal(
      scriptDeAbrir("01000000d08c"),
      "$ErrorActionPreference = 'Stop'\n(New-Object System.Management.Automation.PSCredential 'x', (ConvertTo-SecureString -String '01000000d08c')).GetNetworkCredential().Password\n",
    );
    for (const s of [scriptDeProteger(hex), scriptDeAbrir("abcd")]) assert.ok(!/Add-Type|ProtectedData|\[Convert\]|EncodedCommand/.test(s));
    for (const ruim of ["", "ab'cd", "ab\ncd", "abcd' ; Remove-Item x ; '", "xyz"]) {
      assert.throws(() => scriptDeAbrir(ruim), /hexadecimal/, JSON.stringify(ruim));
      assert.throws(() => scriptDeProteger(ruim), /hexadecimal/, JSON.stringify(ruim));
    }
    assert.throws(() => scriptDeProteger("ab".repeat(31)), /hexadecimal/, "a chave tem 64 caracteres");
  });

  it("primeira partida: chave aleatória protegida (segredo só pela entrada padrão), conferida e guardada no arquivo", async () => {
    esquecerSegredos();
    const dir = pasta();
    const d = dpapiFalsa();
    const chave = await novoDpapi(dir, d.executar).obterChave();
    assert.equal(chave.length, 32);
    const hex = chave.toString("hex");
    for (const c of d.chamadas) {
      assert.equal(c.comando, POWERSHELL);
      assert.deepEqual(c.args, ["-NoProfile", "-NonInteractive", "-Command", "-"]);
      assert.ok(!c.args.join(" ").includes(hex), "a chave nunca vai no argv");
    }
    assert.ok(d.chamadas[0]!.entrada.includes(hex), "a chave foi pela entrada padrão");
    assert.equal(d.chamadas.length, 2, "protege e confere que abre (senão a chave se perderia na próxima partida)");
    const arquivo = JSON.parse(readFileSync(join(dir, ARQUIVO_DPAPI), "utf8")) as { versao: number; bloco: string };
    assert.equal(arquivo.versao, 1);
    assert.ok(d.conhecidos.has(arquivo.bloco), "o arquivo guarda o bloco que a DPAPI devolveu, sem o \\r\\n");
    assert.ok(!readFileSync(join(dir, ARQUIVO_DPAPI), "utf8").includes(hex), "a chave não fica em claro");
    assert.equal(limpar(`vazou ${hex}`), "vazou ‹segredo›");

    // Partida seguinte: só abre o bloco (pela entrada padrão) e devolve a mesma chave.
    d.chamadas.length = 0;
    assert.equal((await novoDpapi(dir, d.executar).obterChave()).toString("hex"), hex);
    assert.equal(d.chamadas.length, 1);
    assert.ok(d.chamadas[0]!.entrada.includes(arquivo.bloco));
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
    esquecerSegredos();
  });

  it("dois processos criando ao mesmo tempo acabam com a mesma chave", async () => {
    const dir = pasta();
    const d = dpapiFalsa({ atraso: true });
    const chaves = await Promise.all([1, 2, 3, 4].map(() => novoDpapi(dir, d.executar).obterChave()));
    assert.equal(new Set(chaves.map((c) => c.toString("hex"))).size, 1);
    assert.equal((await novoDpapi(dir, d.executar).obterChave()).toString("hex"), chaves[0]!.toString("hex"));
  });

  it("(a) o PowerShell não roda: frase própria, nada é apagado nem criado", async () => {
    const dir = pasta();
    const d = dpapiFalsa();
    d.modo = "sem-powershell";
    await assert.rejects(novoDpapi(dir, d.executar).obterChave(), /Não consegui usar a proteção de dados do Windows/);
    assert.ok(!existsSync(join(dir, ARQUIVO_DPAPI)), "nada criado");
    d.modo = "ok";
    const chave = await novoDpapi(dir, d.executar).obterChave();
    const antes = readFileSync(join(dir, ARQUIVO_DPAPI), "utf8");
    d.modo = "sem-powershell";
    await assert.rejects(novoDpapi(dir, d.executar).obterChave(), /Não consegui usar a proteção de dados do Windows/);
    assert.equal(readFileSync(join(dir, ARQUIVO_DPAPI), "utf8"), antes, "o bloco ficou intacto");
    assert.ok(!existsSync(join(dir, `${ARQUIVO_DPAPI}.antiga`)));
    d.modo = "ok";
    assert.deepEqual(await novoDpapi(dir, d.executar).obterChave(), chave, "quando o PowerShell volta, a chave é a mesma");
  });

  it("(a) proteger falha ou devolve lixo, ou o que acabou de proteger não abre (modo restrito): nada é guardado", async () => {
    for (const modo of ["proteger-falha", "saida-ruim", "nunca-abre"] as const) {
      const dir = pasta();
      const d = dpapiFalsa();
      d.modo = modo;
      await assert.rejects(novoDpapi(dir, d.executar).obterChave(), /Não consegui usar a proteção de dados do Windows/, modo);
      assert.ok(!existsSync(join(dir, ARQUIVO_DPAPI)), `${modo}: nada guardado`);
    }
  });

  it("(b) o bloco existe mas o Windows não abre (senha da conta redefinida, outra máquina): vira .antiga e nasce outra chave", async () => {
    const dir = pasta();
    const velha = dpapiFalsa();
    const chaveVelha = await novoDpapi(dir, velha.executar).obterChave();
    const conteudoVelho = readFileSync(join(dir, ARQUIVO_DPAPI), "utf8");
    const outraConta = dpapiFalsa(); // não conhece o bloco: "Key not valid for use in specified state"
    const nova = await novoDpapi(dir, outraConta.executar).obterChave();
    assert.notDeepEqual(nova, chaveVelha);
    assert.equal(readFileSync(join(dir, `${ARQUIVO_DPAPI}.antiga`), "utf8"), conteudoVelho, "o bloco antigo não foi apagado");
    assert.equal((await novoDpapi(dir, outraConta.executar).obterChave()).toString("hex"), nova.toString("hex"));
  });

  it("(a), não (b): se o PowerShell não abre NADA (nem um bloco recém-protegido), não troca a chave", async () => {
    const dir = pasta();
    const d = dpapiFalsa();
    await novoDpapi(dir, d.executar).obterChave();
    const antes = readFileSync(join(dir, ARQUIVO_DPAPI), "utf8");
    d.modo = "nunca-abre";
    await assert.rejects(novoDpapi(dir, d.executar).obterChave(), /Não consegui usar a proteção de dados do Windows/);
    assert.equal(readFileSync(join(dir, ARQUIVO_DPAPI), "utf8"), antes);
    assert.ok(!existsSync(join(dir, `${ARQUIVO_DPAPI}.antiga`)));
  });

  it("(b) arquivo estragado: vira .antiga sem ir ao PowerShell, e nasce outra chave", async () => {
    for (const conteudo of ["{meio escrito", JSON.stringify({ versao: 1, bloco: "ab'; Remove-Item C:\\ ; '" }), JSON.stringify({ versao: 9, bloco: "abcd" })]) {
      const dir = pasta();
      writeFileSync(join(dir, ARQUIVO_DPAPI), conteudo);
      const d = dpapiFalsa();
      const chave = await novoDpapi(dir, d.executar).obterChave();
      assert.equal(chave.length, 32);
      assert.equal(readFileSync(join(dir, `${ARQUIVO_DPAPI}.antiga`), "utf8"), conteudo);
      assert.ok(d.chamadas.every((c) => !c.entrada.includes("Remove-Item")), "o conteúdo estragado nunca vai para o script");
    }
  });

  it("o arquivo sobrevive ao apagarTudo (como o envios.enc)", () => {
    const dir = pasta();
    writeFileSync(join(dir, ARQUIVO_DPAPI), JSON.stringify({ versao: 1, bloco: "abcd" }));
    new Banco({ dir, chave: Buffer.alloc(32, 1), maxMensagens: 500 }).apagarTudo();
    assert.ok(existsSync(join(dir, ARQUIVO_DPAPI)));
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("escolha do cofre", () => {
  it("Mac = Keychain, Windows = DPAPI, outros sistemas = erro claro; WA_TESTE_CHAVE só com WA_DADOS_DIR", () => {
    const hex = "ab".repeat(32);
    assert.ok(escolherCofre("/x", {}, "darwin", keychainFalso().executar) instanceof CofreKeychain);
    assert.ok(escolherCofre("/x", {}, "win32", dpapiFalsa().executar) instanceof CofreDpapi);
    assert.throws(() => escolherCofre("/x", {}, "linux"), (e: unknown) => e instanceof ErroConfig && /Só Mac e Windows são suportados/.test(e.message));
    assert.ok(escolherCofre("/x", { WA_TESTE_CHAVE: hex, WA_DADOS_DIR: "/x" }, "linux") instanceof CofreEmMemoria);
    assert.throws(() => escolherCofre("/x", { WA_TESTE_CHAVE: hex }, "darwin"), /só vale nos testes/);
    assert.throws(() => lerConfig({ WA_DADOS_DIR: "/x" }), /só valem nos testes/);
  });
});
