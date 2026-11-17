// 0.6.0: o canal local do leitor para o dono (socket Unix aqui; named pipe no Windows), com autenticação mútua por
// desafio e resposta (HMAC com a chave do canal, derivada da chave da instalação). Nada de rede: só caminho.

import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { chamarPeloCanal, chaveDoCanal, enderecoDoCanal, ErroDoCanal, LIMITES_DO_CANAL, ServidorDoCanal, type PedidoDoCanal } from "../src/canal.ts";
import { esquecerSegredos, limpar } from "../src/segredos.ts";

const pastas: string[] = [];
const servidores: ServidorDoCanal[] = [];
afterEach(async () => {
  for (const s of servidores.splice(0)) await s.fechar();
  for (const p of pastas.splice(0)) rmSync(p, { recursive: true, force: true });
});
const pasta = () => {
  const p = mkdtempSync(join(tmpdir(), "wa-canal-"));
  pastas.push(p);
  return p;
};

const CHAVE = chaveDoCanal(Buffer.alloc(32, 9));
const resultado = (texto: string): CallToolResult => ({ content: [{ type: "text", text: texto }], structuredContent: { ok: texto }, _meta: { codigo: "abc" } });

async function servidor(executar: (p: PedidoDoCanal) => Promise<CallToolResult>, extra: Partial<typeof LIMITES_DO_CANAL> = {}, chave = CHAVE) {
  const endereco = join(pasta(), "c.sock");
  const s = new ServidorDoCanal({ endereco, chave, executar, limites: extra });
  await s.ouvir();
  servidores.push(s);
  return { s, endereco };
}

/** Cliente cru, para mandar o que quiser e ver o que volta. */
function cru(endereco: string) {
  const sock = net.connect(endereco);
  const linhas: string[] = [];
  let buf = "";
  let fechado = false;
  sock.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      linhas.push(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  sock.on("error", () => {});
  const fim = new Promise<void>((ok) => sock.on("close", () => ((fechado = true), ok())));
  const linha = async (n: number) => {
    for (let t = 0; t < 400 && linhas.length < n && !fechado; t++) await new Promise((ok) => setTimeout(ok, 5));
    return linhas[n - 1];
  };
  return { sock, linhas, linha, fim, get fechado() { return fechado; } };
}
const campoOk = (r: CallToolResult): unknown => (r.structuredContent as Record<string, unknown> | undefined)?.ok;
const hmac = (k: Buffer, ...partes: string[]) => createHmac("sha256", k).update(partes.join("|")).digest("hex");

describe("canal local do leitor para o dono", () => {
  it("endereço por sistema: named pipe no Windows; socket na pasta de dados, ou em tmpdir se o caminho for longo", () => {
    assert.equal(enderecoDoCanal("win32", "C:\\x", "ab12", "C:\\tmp"), "\\\\.\\pipe\\whatsapp-claude-ab12");
    assert.equal(enderecoDoCanal("darwin", "/Users/a/dados", "ab12", "/tmp/u"), "/Users/a/dados/canal-ab12.sock");
    const longa = "/Users/a/" + "x".repeat(120);
    assert.equal(enderecoDoCanal("darwin", longa, "ab12", "/var/folders/t"), "/var/folders/t/whatsapp-claude-ab12.sock");
    assert.equal(enderecoDoCanal("linux", "/home/a/d", "ff", "/tmp"), "/home/a/d/canal-ff.sock");
  });

  it("a chave do canal é derivada (HMAC com rótulo), não é a chave da instalação, e é registrada como segredo", () => {
    esquecerSegredos();
    const base = Buffer.alloc(32, 5);
    const k = chaveDoCanal(base);
    assert.equal(k.length, 32);
    assert.notDeepEqual(k, base);
    assert.deepEqual(k, createHmac("sha256", base).update("canal-do-dono:v1").digest());
    assert.equal(limpar(`k=${k.toString("hex")}`), "k=‹segredo›");
    esquecerSegredos();
  });

  it("caminho feliz: aperto de mão nos dois sentidos e o resultado volta inteiro (content, structuredContent, _meta)", async () => {
    const vistos: PedidoDoCanal[] = [];
    const { endereco } = await servidor(async (p) => (vistos.push(p), resultado(`oi ${p.ferramenta}`)));
    const r = await chamarPeloCanal({ endereco, chave: CHAVE, pedido: { ferramenta: "wa_estado", argumentos: { a: 1 }, temTela: true } });
    assert.deepEqual(r, resultado("oi wa_estado"));
    assert.deepEqual(vistos, [{ ferramenta: "wa_estado", argumentos: { a: 1 }, temTela: true }]);
    // Um pedido por conexão, e vários em paralelo.
    const varios = await Promise.all([1, 2, 3].map((i) => chamarPeloCanal({ endereco, chave: CHAVE, pedido: { ferramenta: `f${i}`, argumentos: {}, temTela: false } })));
    assert.deepEqual(varios.map((x) => x.structuredContent), [{ ok: "oi f1" }, { ok: "oi f2" }, { ok: "oi f3" }]);
  });

  it("chave diferente: o dono recusa sem executar nada", async () => {
    let chamadas = 0;
    const { endereco } = await servidor(async () => (chamadas++, resultado("x")));
    await assert.rejects(chamarPeloCanal({ endereco, chave: chaveDoCanal(Buffer.alloc(32, 1)), pedido: { ferramenta: "wa_estado", argumentos: {}, temTela: false } }), ErroDoCanal);
    assert.equal(chamadas, 0);
  });

  it("prova errada: o dono não manda nada além do desafio e fecha, sem dizer por quê", async () => {
    let chamadas = 0;
    const { endereco } = await servidor(async () => (chamadas++, resultado("x")));
    const c = cru(endereco);
    const desafio = JSON.parse((await c.linha(1))!) as { v: number; desafio: string };
    assert.equal(desafio.v, 1);
    assert.match(desafio.desafio, /^[0-9a-f]{64}$/, "nonce de 32 bytes");
    c.sock.write(`${JSON.stringify({ desafio: randomBytes(32).toString("hex"), prova: "00".repeat(32) })}\n`);
    await c.fim;
    assert.equal(c.linhas.length, 1, "só o desafio");
    assert.equal(chamadas, 0);
  });

  it("servidor falso que não sabe a chave (pipe com o mesmo nome): o cliente confere a prova do dono e não manda o pedido", async () => {
    const endereco = join(pasta(), "falso.sock");
    const recebidas: string[] = [];
    const falso = net.createServer((s) => {
      s.on("error", () => {});
      s.write(`${JSON.stringify({ v: 1, desafio: randomBytes(32).toString("hex") })}\n`);
      s.on("data", (d) => {
        recebidas.push(...d.toString().split("\n").filter(Boolean));
        if (recebidas.length === 1) s.write(`${JSON.stringify({ prova: "ab".repeat(32) })}\n`);
      });
    });
    await new Promise<void>((ok) => falso.listen(endereco, ok));
    try {
      await assert.rejects(chamarPeloCanal({ endereco, chave: CHAVE, pedido: { ferramenta: "wa_responder", argumentos: { texto: "segredo" }, temTela: true } }), ErroDoCanal);
      await new Promise((ok) => setTimeout(ok, 20));
      assert.equal(recebidas.length, 1, "só a prova do cliente; o pedido nunca saiu");
      assert.ok(!recebidas.join("").includes("segredo"));
    } finally {
      await new Promise((ok) => falso.close(ok));
    }
  });

  it("lixo, mensagem grande demais e silêncio: o dono fecha e continua de pé", async () => {
    const { endereco } = await servidor(async () => resultado("ok"), { mensagemBytes: 4096, apertoMs: 150 });
    const lixo = cru(endereco);
    await lixo.linha(1);
    lixo.sock.write("isto não é json\n");
    await lixo.fim;
    const grande = cru(endereco);
    await grande.linha(1);
    grande.sock.write("x".repeat(10_000));
    await grande.fim;
    const mudo = cru(endereco);
    await mudo.fim; // aperto de mão em até 150 ms
    assert.equal(mudo.linhas.length, 1);
    const r = await chamarPeloCanal({ endereco, chave: CHAVE, pedido: { ferramenta: "f", argumentos: {}, temTela: false } });
    assert.equal(campoOk(r), "ok", "o dono continua atendendo");
    assert.equal(LIMITES_DO_CANAL.mensagemBytes, 2 * 1024 * 1024);
  });

  it("tempo do pedido estourado e dono que some no meio: o cliente desiste com ErroDoCanal", async () => {
    const parado = await servidor(() => new Promise<CallToolResult>(() => {}));
    const t0 = Date.now();
    await assert.rejects(
      chamarPeloCanal({ endereco: parado.endereco, chave: CHAVE, pedido: { ferramenta: "f", argumentos: {}, temTela: false }, limites: { pedidoMs: 150 } }),
      ErroDoCanal,
    );
    assert.ok(Date.now() - t0 < 2_000);
    const some = await servidor(() => new Promise<CallToolResult>(() => {}));
    const p = chamarPeloCanal({ endereco: some.endereco, chave: CHAVE, pedido: { ferramenta: "f", argumentos: {}, temTela: false } });
    await new Promise((ok) => setTimeout(ok, 50));
    await some.s.fechar();
    await assert.rejects(p, ErroDoCanal);
    await assert.rejects(chamarPeloCanal({ endereco: join(pasta(), "nao-existe.sock"), chave: CHAVE, pedido: { ferramenta: "f", argumentos: {}, temTela: false } }), ErroDoCanal);
  });

  it("no máximo 8 conexões ao mesmo tempo; o socket velho é removido antes de escutar e o arquivo some ao fechar", async () => {
    const { s, endereco } = await servidor(async () => resultado("x"), { apertoMs: 2_000 });
    const abertos = Array.from({ length: 8 }, () => cru(endereco));
    await Promise.all(abertos.map((c) => c.linha(1)));
    const nono = cru(endereco);
    await nono.fim;
    assert.equal(nono.linhas.length, 0, "a nona conexão é recusada");
    for (const c of abertos) c.sock.destroy();
    await s.fechar();
    assert.ok(!existsSync(endereco), "fechou e apagou o socket");
    // Socket velho no lugar (processo que morreu): o próximo dono escuta mesmo assim.
    const velho = net.createServer();
    await new Promise<void>((ok) => velho.listen(endereco, ok));
    await new Promise((ok) => velho.close(ok));
    const novo = new ServidorDoCanal({ endereco, chave: CHAVE, executar: async () => resultado("novo") });
    servidores.push(novo);
    await novo.ouvir();
    assert.equal(campoOk(await chamarPeloCanal({ endereco, chave: CHAVE, pedido: { ferramenta: "f", argumentos: {}, temTela: false } })), "novo");
  });

  it("o aperto de mão usa HMAC com os rótulos \"cliente\" e \"dono\" e os dois nonces", async () => {
    const { endereco } = await servidor(async () => resultado("x"));
    const c = cru(endereco);
    const { desafio } = JSON.parse((await c.linha(1))!) as { desafio: string };
    const meu = randomBytes(32).toString("hex");
    c.sock.write(`${JSON.stringify({ desafio: meu, prova: hmac(CHAVE, "cliente", desafio, meu) })}\n`);
    const resposta = JSON.parse((await c.linha(2))!) as { prova: string };
    assert.equal(resposta.prova, hmac(CHAVE, "dono", meu, desafio));
    c.sock.write(`${JSON.stringify({ ferramenta: "f", argumentos: {}, temTela: false })}\n`);
    const fim = JSON.parse((await c.linha(3))!) as { resultado: CallToolResult };
    assert.equal(campoOk(fim.resultado), "x");
    c.sock.destroy();
  });
});

describe("bloqueio de rede: só conexão por caminho (socket Unix ou pipe) passa", () => {
  it("nos testes (test/setup.ts): host e porta continuam bloqueados, até 127.0.0.1; caminho passa", async () => {
    for (const alvo of [{ host: "127.0.0.1", port: 9 }, { host: "localhost", port: 9 }, { host: "example.com", port: 443 }]) {
      assert.throws(() => net.connect(alvo), /rede bloqueada|RedeBloqueada|Teste tentou/, JSON.stringify(alvo));
    }
    assert.throws(() => net.connect(9, "127.0.0.1"), /bloqueada|Teste tentou/);
    const { endereco } = await servidor(async () => resultado("caminho"));
    assert.equal(campoOk(await chamarPeloCanal({ endereco, chave: CHAVE, pedido: { ferramenta: "f", argumentos: {}, temTela: false } })), "caminho");
  });

  it("no autoteste (scripts/sem-rede.mjs): caminho passa, host e porta não", async () => {
    const semRede = fileURLToPath(new URL("../scripts/sem-rede.mjs", import.meta.url));
    const { endereco } = await servidor(async () => resultado("x"));
    // Assíncrono: o servidor do canal roda neste processo e precisa do laço de eventos livre para responder.
    const { stdout: saida } = await promisify(execFile)(
      process.execPath,
      ["--import", semRede, "-e", `
        const net = require("node:net");
        let bloqueios = 0;
        try { net.connect(443, "127.0.0.1"); } catch { bloqueios++; }
        try { net.connect({ host: "example.com", port: 443 }); } catch { bloqueios++; }
        const s = net.connect(${JSON.stringify(endereco)});
        s.on("data", () => { console.log("bloqueios=" + bloqueios + " caminho=ok"); s.destroy(); });
        s.on("error", (e) => console.log("bloqueios=" + bloqueios + " caminho=" + e.message));
      `],
      { encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(saida.trim(), "bloqueios=2 caminho=ok");
  });
});
