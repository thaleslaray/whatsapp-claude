// Lock de dono da conexão: o segundo processo vira leitor; lock de PID morto pode ser tomado.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import { inicioDesteProcesso, inicioPeloPs, LockDeConexao, segundosDoEtime } from "../src/lock.ts";
import { ANA, assentar, chamar, conectar, conectarCliente, montar, pn, type Montagem } from "./ajuda.ts";
import { msg } from "./socket-falso.ts";

const SRC_LOCK = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "lock.ts");

describe("lock de dono da conexão", () => {
  const pastas: string[] = [];
  afterEach(() => {
    for (const p of pastas.splice(0)) rmSync(p, { recursive: true, force: true });
  });
  const pasta = () => {
    const p = mkdtempSync(join(tmpdir(), "wa-lock-"));
    pastas.push(p);
    return p;
  };

  it("o segundo no mesmo processo vira leitor; depois de liberar, pega", async () => {
    const dir = pasta();
    const a = new LockDeConexao(dir);
    const b = new LockDeConexao(dir);
    assert.deepEqual(await a.tentar(), { dono: true });
    assert.deepEqual(await b.tentar(), { dono: false, pid: process.pid }, "mesmo PID e mesma hora de início (medida pelo ps de verdade)");
    a.liberar();
    assert.deepEqual(await b.tentar(), { dono: true });
  });

  it("lock de PID morto é tomado; lock ilegível também", async () => {
    const dir = pasta();
    writeFileSync(join(dir, "conexao.lock"), JSON.stringify({ pid: 999_999, token: "velho", inicio: Date.now() }));
    assert.deepEqual(await new LockDeConexao(dir).tentar(), { dono: true });
    const dir2 = pasta();
    writeFileSync(join(dir2, "conexao.lock"), "{meio escrito");
    assert.deepEqual(await new LockDeConexao(dir2).tentar(), { dono: true });
  });

  it("o lock guarda a hora de início do processo", async () => {
    const dir = pasta();
    const l = new LockDeConexao(dir);
    await l.tentar();
    const gravado = JSON.parse(readFileSync(join(dir, "conexao.lock"), "utf8")) as { pid: number; inicio: number };
    assert.equal(gravado.pid, process.pid);
    assert.ok(Math.abs(gravado.inicio - inicioDesteProcesso()) < 1000);
    l.liberar();
  });

  it("PID reaproveitado: o PID está vivo, mas o processo começou em outra hora; o lock é tomado", async () => {
    const dir = pasta();
    // O dono antigo "começou" há uma hora; o processo vivo com o mesmo PID (este) começou agora.
    writeFileSync(join(dir, "conexao.lock"), JSON.stringify({ pid: process.pid, token: "de-outro", inicio: Date.now() - 3_600_000 }));
    assert.deepEqual(await new LockDeConexao(dir).tentar(), { dono: true });
  });

  it("na dúvida, o PID vivo vale como dono: lock da Fase 1 (sem hora) ou ps sem resposta", async () => {
    const dir = pasta();
    writeFileSync(join(dir, "conexao.lock"), JSON.stringify({ pid: process.pid, token: "fase-1" }));
    assert.deepEqual(await new LockDeConexao(dir).tentar(), { dono: false, pid: process.pid });
    const dir2 = pasta();
    writeFileSync(join(dir2, "conexao.lock"), JSON.stringify({ pid: process.pid, token: "x", inicio: 1 }));
    assert.deepEqual(await new LockDeConexao(dir2, { inicioDe: async () => undefined }).tentar(), { dono: false, pid: process.pid });
  });

  it("lê o etime do ps do macOS ([[dd-]hh:]mm:ss)", async () => {
    assert.equal(segundosDoEtime("00:05"), 5);
    assert.equal(segundosDoEtime("  01:02:03\n"), 3723);
    assert.equal(segundosDoEtime("2-01:00:00"), 2 * 86_400 + 3600);
    assert.equal(segundosDoEtime("lixo"), undefined);
    const falso = inicioPeloPs(async () => ({ codigo: 0, stdout: "01:00\n", stderr: "" }));
    const t = await falso(123);
    assert.ok(t !== undefined && Math.abs(Date.now() - 60_000 - t) < 1000);
    assert.equal(await inicioPeloPs(async () => ({ codigo: 1, stdout: "", stderr: "" }))(1), undefined);
  });

  it("outro processo de verdade com o lock: este vira leitor; quando ele morre, este pega", async () => {
    const dir = pasta();
    const codigo = `import { LockDeConexao } from ${JSON.stringify(SRC_LOCK)}; const l = new LockDeConexao(${JSON.stringify(dir)}); process.stdout.write(JSON.stringify(await l.tentar()) + "\\n"); setInterval(() => {}, 1000);`;
    const filho = spawn(process.execPath, ["--input-type=module", "-e", codigo], { stdio: ["ignore", "pipe", "inherit"] });
    try {
      const primeira = await new Promise<string>((ok, falha) => {
        filho.stdout.once("data", (d: Buffer) => ok(d.toString()));
        filho.once("exit", (c) => falha(new Error(`filho saiu com ${c}`)));
      });
      assert.deepEqual(JSON.parse(primeira), { dono: true });
      const aqui = new LockDeConexao(dir);
      assert.deepEqual(await aqui.tentar(), { dono: false, pid: filho.pid }, "o ps de verdade confirma a hora de início do filho");
      filho.kill("SIGKILL");
      await new Promise((ok) => filho.once("exit", ok));
      assert.deepEqual(await aqui.tentar(), { dono: true }, "PID morto: lock tomado");
      aqui.liberar();
    } finally {
      filho.kill("SIGKILL");
    }
  });
});

describe("o segundo processo vira leitor", () => {
  let dono: Montagem | undefined;
  let leitor: Montagem | undefined;
  afterEach(async () => {
    await leitor?.ctx.encerrar();
    await dono?.fechar();
    dono = leitor = undefined;
  });

  it("não abre socket, lê o banco do dono e assume a conexão quando o dono sai", async () => {
    dono = await montar();
    const s = await conectar(dono);
    s.mensagens([msg({ jid: pn(ANA), texto: "guardada pelo dono" })]);
    await assentar(dono);

    leitor = await montar({ dir: dono.dir, pareada: false, intervaloDoLockMs: 20 });
    await leitor.ctx.partida();
    assert.equal(leitor.ctx.papel, "leitor");
    assert.equal(leitor.fabrica.sockets.length, 0, "o leitor não abre socket");
    assert.equal(leitor.ctx.transporte, null);

    const { cliente, fechar } = await conectarCliente(leitor.ctx);
    try {
      // 0.6.0: o leitor repassa ao dono pelo canal; o que volta é o resultado do dono.
      const estado = await chamar(cliente, "wa_estado");
      assert.equal(estado.situacao, "conectado");
      assert.equal(estado.por_outra_sessao_do_claude, true);
      assert.match(String(estado.para_o_claude), /outra sessão do Claude/);
      const conversa = await chamar(cliente, "wa_ler_conversa", { conversa: ANA });
      assert.equal((conversa.mensagens as Array<{ conteudo_de_terceiros: { texto: string } }>)[0]!.conteudo_de_terceiros.texto, "guardada pelo dono");
      const grupos = await chamar(cliente, "wa_listar_grupos");
      assert.ok(grupos.atualizada_em, "o leitor vê a lista que o dono buscou ao conectar");
      // O que escreve vira prévia NO DONO; nada sai sem o clique, e o leitor não cria pedido.
      (await leitor.ctx.nucleo()).banco.definirEnvio(true); // o envio ligado vale para os dois processos (banco)
      const resposta = await chamar(cliente, "wa_responder", { conversa: ANA, texto: "oi" });
      assert.equal(typeof resposta.pedido, "string");
      assert.equal(dono.ctx.pedidos.situacao(String(resposta.pedido)).estado, "pendente");
      assert.equal(leitor.ctx.pedidos.situacao(String(resposta.pedido)).estado, "inexistente");
      assert.equal(dono.socket().chamadas.filter((c) => c.metodo === "sendMessage").length, 0);
    } finally {
      await fechar();
    }

    await dono.ctx.encerrar();
    for (let i = 0; i < 100 && leitor.fabrica.sockets.length === 0; i++) await new Promise((ok) => setTimeout(ok, 10));
    assert.equal(leitor.ctx.papel, "dono_da_conexao");
    assert.equal(leitor.fabrica.sockets.length, 1, "o antigo leitor conectou");
  });
});
