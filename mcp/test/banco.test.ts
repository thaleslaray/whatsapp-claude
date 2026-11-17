// Banco cifrado: nada em claro no disco, AAD por conversa, limite de 500, listas que apagam.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Banco, type MensagemGuardada } from "../src/banco.ts";
import { ANA, assentar, BETO, chamar, conectar, conectarCliente, GRUPO, montar, pn, type Montagem } from "./ajuda.ts";
import { msg } from "./socket-falso.ts";

const CHAVE = Buffer.alloc(32, 7);
const m1 = (id: string, texto: string, ts = Date.now()): MensagemGuardada => ({ id, ts, de_mim: false, tipo: "texto", texto });

function todosOsArquivos(pasta: string): string[] {
  return readdirSync(pasta).flatMap((n) => {
    const c = join(pasta, n);
    const st = statSync(c);
    // O socket do canal (0.6.0) não é arquivo: não tem conteúdo para ler. O nome dele é conferido abaixo como os outros.
    if (st.isSocket()) {
      assert.match(n, /^canal-[0-9a-f]{16}\.sock$/);
      return [];
    }
    return st.isDirectory() ? todosOsArquivos(c) : [c];
  });
}

describe("banco", () => {
  let dir: string;
  let banco: Banco;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wa-banco-"));
    banco = new Banco({ dir, chave: CHAVE });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("apagarTudo guarda a contagem de envios do dia; com a chave trocada, ela vira \"limite atingido hoje\"", () => {
    const agora = Date.now();
    banco.reservarEnvio(agora, 30);
    banco.reservarEnvio(agora, 30);
    banco.apagarTudo();
    assert.equal(banco.enviosDoDia(agora), 2, "a contagem sobrevive");
    // A chave do cofre se perdeu: chave nova, a contagem antiga não abre.
    const comOutraChave = new Banco({ dir, chave: Buffer.alloc(32, 9) });
    assert.throws(() => comOutraChave.enviosDoDia(agora), /chave do cofre deste computador se perdeu/);
    comOutraChave.apagarTudo();
    assert.equal(comOutraChave.enviosDoDia(agora), 200, "na dúvida, conta: limite atingido hoje");
    assert.throws(() => comOutraChave.reservarEnvio(agora, 200), /limite de 200 respostas por dia/);
    assert.equal(comOutraChave.enviosDoDia(agora + 24 * 3600_000), 0, "volta amanhã");
  });

  it("gravarMensagens recusa grupo fora da lista, bloqueado, status e canal (defesa em profundidade)", () => {
    assert.equal(banco.gravarMensagens(GRUPO, [m1("a", "x")]), 0);
    assert.equal(banco.gravarMensagens("status@broadcast", [m1("b", "x")]), 0);
    assert.equal(banco.gravarMensagens("120363111111111111@newsletter", [m1("c", "x")]), 0);
    banco.bloquear(pn(ANA));
    assert.equal(banco.gravarMensagens(pn(ANA), [m1("d", "x")]), 0);
    assert.equal(banco.gravarMensagens(pn(BETO), [m1("e", "x")]), 1);
    assert.deepEqual(banco.listarConversas().map((c) => c.jid), [pn(BETO)]);
  });

  it("limite de 500 por conversa, guardando as mais recentes", () => {
    const pequeno = new Banco({ dir, chave: CHAVE, maxMensagens: 500 });
    const lote = Array.from({ length: 600 }, (_, i) => m1(`M${i}`, `t${i}`, 1_000 + i));
    assert.equal(pequeno.gravarMensagens(pn(ANA), lote), 600);
    const guardadas = pequeno.lerMensagens(pn(ANA));
    assert.equal(guardadas.length, 500);
    assert.equal(guardadas[0]!.id, "M100");
    assert.equal(pequeno.entrada(pn(ANA))?.total, 500);
  });

  it("remover grupo e bloquear conversa apagam o que estava gravado", () => {
    banco.permitirGrupo(GRUPO);
    banco.gravarMensagens(GRUPO, [m1("g1", "do grupo"), m1("g2", "do grupo 2")]);
    banco.mapearLid("12345000001@lid", pn(ANA));
    banco.gravarMensagens(pn(ANA), [m1("a1", "da ana")]);
    assert.equal(banco.removerGrupo(GRUPO), 2);
    assert.equal(banco.lerMensagens(GRUPO).length, 0);
    assert.equal(banco.entrada(GRUPO), undefined);
    assert.equal(banco.deveIgnorar(GRUPO), true);
    assert.equal(banco.bloquear(pn(ANA)), 1);
    assert.equal(banco.lerMensagens(pn(ANA)).length, 0);
    assert.equal(banco.entrada(pn(ANA)), undefined);
    assert.ok(banco.bloqueados().includes("12345000001@lid"), "o LID conhecido entra junto");
    assert.equal(banco.liberar(pn(ANA)), true);
    assert.deepEqual(banco.bloqueados(), []);
  });

  it("linha copiada para outra conversa não abre (AAD = conversa)", () => {
    banco.gravarMensagens(pn(ANA), [m1("a1", "da ana")]);
    banco.gravarMensagens(pn(BETO), [m1("b1", "do beto")]);
    const arquivos = readdirSync(join(dir, "conversas")).map((n) => join(dir, "conversas", n));
    const [a, b] = arquivos.map((f) => readFileSync(f, "utf8"));
    writeFileSync(arquivos[1]!, a! + b!);
    const lidas = [...banco.lerMensagens(pn(ANA)), ...banco.lerMensagens(pn(BETO))];
    assert.equal(lidas.length, 2, "a linha copiada foi descartada");
    assert.ok(banco.linhasIlegiveis >= 1);
  });

  it("nome de arquivo é HMAC com a chave: não é o SHA-256 do jid nem tem o número", () => {
    banco.gravarMensagens(pn(ANA), [m1("a1", "oi")]);
    const nomes = readdirSync(join(dir, "conversas")).join(" ");
    assert.ok(!nomes.includes(ANA));
    assert.ok(!nomes.includes(createHash("sha256").update(pn(ANA)).digest("hex").slice(0, 32)));
    const outro = new Banco({ dir: mkdtempSync(join(tmpdir(), "wa-banco2-")), chave: Buffer.alloc(32, 9) });
    outro.gravarMensagens(pn(ANA), [m1("a1", "oi")]);
    assert.notDeepEqual(readdirSync(join(outro.dir, "conversas")), readdirSync(join(dir, "conversas")));
    rmSync(outro.dir, { recursive: true, force: true });
  });

  it("chave errada não abre o banco", () => {
    banco.gravarMensagens(pn(ANA), [m1("a1", "oi")]);
    const errado = new Banco({ dir, chave: Buffer.alloc(32, 1) });
    assert.throws(() => errado.listarConversas(), /chave do cofre deste computador se perdeu/);
  });

  it("pasta 0700 e arquivos 0600", () => {
    banco.gravarMensagens(pn(ANA), [m1("a1", "oi")]);
    banco.permitirGrupo(GRUPO);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    for (const f of todosOsArquivos(dir)) assert.equal(statSync(f).mode & 0o777, 0o600, f);
  });
});

describe("o disco não tem texto em claro (fluxo completo)", () => {
  let m: Montagem;
  afterEach(async () => m.fechar());

  it("mensagens, nomes, números, credenciais e o registro de ações", async () => {
    m = await montar();
    const s = await conectar(m);
    const { banco } = await m.ctx.nucleo();
    banco.permitirGrupo(GRUPO);
    s.mensagens([
      msg({ jid: pn(ANA), texto: "TEXTO-SECRETO-DA-ANA senha do portão 4321", nome: "Ana Sigilosa" }),
      msg({ jid: GRUPO, texto: "TEXTO-SECRETO-DO-GRUPO", participante: pn(BETO), nome: "Beto Sigiloso" }),
      msg({ jid: pn(ANA), message: { documentMessage: { fileName: "ARQUIVO-SECRETO.pdf", mimetype: "application/pdf", fileLength: 1234, url: "https://mmg.whatsapp.net/d/x", directPath: "/v/x" } } }),
    ]);
    s.historico({ messages: [msg({ jid: pn(BETO), texto: "HISTORICO-SECRETO" })], chats: [{ id: GRUPO, name: "GRUPO-NOME-SECRETO" }] });
    await assentar(m);
    const { cliente, fechar } = await conectarCliente(m.ctx);
    try {
      await chamar(cliente, "wa_bloquear_conversas", { bloquear: [BETO] });
      await chamar(cliente, "wa_ler_conversa", { conversa: ANA });
    } finally {
      await fechar();
    }
    await m.ctx.transporte!.esperar();
    const proibidos = ["TEXTO-SECRETO", "senha do portão", "Ana Sigilosa", "Beto Sigiloso", "ARQUIVO-SECRETO", "HISTORICO-SECRETO", "GRUPO-NOME-SECRETO", ANA, BETO, "Dono Teste", "88887777"];
    const arquivos = todosOsArquivos(m.dir);
    assert.ok(arquivos.length >= 5, "há arquivos para conferir");
    for (const arquivo of arquivos) {
      const bruto = readFileSync(arquivo).toString("latin1");
      for (const p of proibidos) assert.ok(!bruto.includes(p), `"${p}" em claro em ${arquivo}`);
      for (const p of proibidos) assert.ok(!arquivo.includes(p), `"${p}" no nome de ${arquivo}`);
    }
    // E o banco abre com a chave certa.
    assert.equal(banco.lerMensagens(pn(ANA))[0]!.texto, "TEXTO-SECRETO-DA-ANA senha do portão 4321");
  });
});
