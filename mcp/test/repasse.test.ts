// 0.6.0: o processo leitor repassa cada chamada de ferramenta ao processo dono da conexão pelo canal local, e devolve
// o resultado do dono como veio. Achado do primeiro uso real: o Claude Desktop sobe mais de uma cópia da extensão
// (conversa comum e aba Code); só uma pega o lock, e pela outra nada que escreve funcionava.
// Dois Contexto no mesmo processo de teste, mesma pasta temporária, socket falso da Baileys: nada de WhatsApp real.

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { chamarPeloCanal, chaveDoCanal } from "../src/canal.ts";
import { inicioDesteProcesso } from "../src/lock.ts";
import { INSTRUCOES } from "../src/servidor.ts";
import { codigoDeConversa, codigoEditado } from "../ui/edicao.js";
import { validarMatriz } from "../ui/qr.js";
import {
  ANA,
  assentar,
  CHAVE_TESTE,
  chamarCru,
  clicar,
  conectar,
  conectarCliente,
  GRUPO,
  montar,
  pedidoDa,
  pedidoPeloChat,
  pn,
  textoDe,
  type Montagem,
  type Resultado,
} from "./ajuda.ts";
import { msg, type SocketFalso } from "./socket-falso.ts";

type Cliente = Awaited<ReturnType<typeof conectarCliente>>["cliente"];

const montagens: Montagem[] = [];
const fechamentos: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const f of fechamentos.splice(0).reverse()) await f();
  for (const mm of montagens.splice(0).reverse()) await mm.ctx.encerrar();
});

async function cliente(mm: Montagem, comTela = true): Promise<Cliente> {
  const { cliente: c, fechar } = await conectarCliente(mm.ctx, { comTela });
  fechamentos.push(fechar);
  return c;
}

const lerLock = (mm: Montagem) => JSON.parse(readFileSync(join(mm.config.dirDados, "conexao.lock"), "utf8")) as { pid: number; canal?: string };
const envios = (s: SocketFalso) => s.chamadas.filter((c) => c.metodo === "sendMessage");
const linhasDoRegistro = (mm: Montagem) => readFileSync(mm.caminhoRegistro, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

/** Dono conectado (com uma mensagem da Ana e um grupo) e um leitor na mesma pasta. */
async function donoELeitor(opcoes: { leitorComTela?: boolean } = {}) {
  const dono = await montar();
  montagens.push(dono);
  const s = await conectar(dono, { grupos: { [GRUPO]: { id: GRUPO, subject: "Família", size: 5, participants: [] } } });
  s.mensagens([msg({ jid: pn(ANA), id: "A1", texto: "Que horas você chega?", nome: "Ana" })]);
  await assentar(dono);
  const leitor = await montar({ dir: dono.dir, pareada: false });
  montagens.push(leitor);
  await leitor.ctx.partida();
  assert.equal(leitor.ctx.papel, "leitor");
  assert.equal(leitor.fabrica.sockets.length, 0, "o leitor não abre socket");
  const c = await cliente(leitor, opcoes.leitorComTela ?? true);
  return { dono, leitor, s, c };
}

describe("o leitor repassa ao dono", () => {
  it("o dono escuta num canal com nome aleatório, gravado no lock", async () => {
    const { dono } = await donoELeitor();
    const canal = lerLock(dono).canal;
    assert.equal(typeof canal, "string");
    assert.match(canal!, /canal-[0-9a-f]{16}\.sock$/);
  });

  it("wa_estado pelo leitor: vem do dono e diz que esta sessão fala com o WhatsApp pela outra", async () => {
    const { c } = await donoELeitor();
    const e = await chamarCru(c, "wa_estado");
    assert.equal(e.isError, undefined, textoDe(e));
    assert.equal(e.structuredContent!.situacao, "conectado");
    assert.equal(e.structuredContent!.por_outra_sessao_do_claude, true);
    assert.match(String(e.structuredContent!.para_o_claude), /outra sessão do Claude/);
    assert.equal(e.structuredContent!.conversas_guardadas, 1);
  });

  it("ligar o envio e responder pelo leitor: prévia com o código no _meta, confirmação com texto, enviado pelo socket do DONO", async () => {
    const { dono, leitor, s, c } = await donoELeitor();
    const envio = await chamarCru(c, "wa_envio", { ligar: true });
    assert.equal(envio.isError, undefined, textoDe(envio));
    assert.equal((await clicar(c, envio)).isError, undefined);
    assert.equal((await dono.ctx.nucleo()).banco.envioLigado(), true);

    const previa = await chamarCru(c, "wa_responder", { conversa: ANA, texto: "Chego às 8" });
    assert.equal(previa.isError, undefined, textoDe(previa));
    const { id, codigo } = pedidoDa(previa);
    assert.equal(leitor.ctx.pedidos.situacao(id).estado, "inexistente", "o pedido nunca nasce no leitor");
    assert.equal(dono.ctx.pedidos.situacao(id).estado, "pendente", "nasce no dono");
    assert.equal(envios(s).length, 0, "nada sem o clique");

    // Aba Code: o cartão manda no chat o código (de conversa, 0.16.0) preso ao texto; o modelo confirma pelo leitor.
    const doChat = codigoEditado(codigoDeConversa(codigo), "Chego às 8");
    const ok = await chamarCru(c, "wa_confirmar", { id, codigo: doChat, texto: "Chego às 8" });
    assert.equal(ok.isError, undefined, textoDe(ok));
    assert.equal(envios(s).length, 1);
    assert.deepEqual(envios(s)[0]!.args[1], { text: "Chego às 8" });
    const estado = await chamarCru(c, "wa_estado_pedido_tela", { id });
    assert.equal(estado.structuredContent!.estado, "usado");
    // As regras de sempre continuam: o mesmo código de novo não envia.
    assert.equal((await chamarCru(c, "wa_confirmar", { id, codigo: doChat, texto: "Chego às 8" })).isError, true);
    assert.equal(envios(s).length, 1);
    // O registro de ações (do dono) anota o que veio pelo canal.
    const registro = linhasDoRegistro(dono);
    assert.ok(registro.some((l) => l.evento === "chamada_pelo_canal" && l.ferramenta === "wa_responder"));
    assert.ok(registro.some((l) => l.evento === "enviado" && l.via === "canal"));
    assert.ok(!JSON.stringify(registro).includes("Chego às 8"), "sem o texto no registro");
  });

  it("cancelar, listas com clique e desconectar pelo leitor", async () => {
    const { dono, s, c } = await donoELeitor();
    // Cancelar (wa_cancelar e o botão do cartão).
    await clicar(c, await chamarCru(c, "wa_envio", { ligar: true }));
    const previa = await chamarCru(c, "wa_responder", { conversa: ANA, texto: "x" });
    assert.equal((await chamarCru(c, "wa_cancelar", { id: pedidoDa(previa).id })).isError, undefined);
    assert.equal(dono.ctx.pedidos.situacao(pedidoDa(previa).id).estado, "cancelado");
    const outra = await chamarCru(c, "wa_responder", { conversa: ANA, texto: "y" });
    assert.equal((await chamarCru(c, "wa_cancelar_pedido", { id: pedidoDa(outra).id })).isError, undefined);
    assert.equal(envios(s).length, 0);

    // Listas: adicionar grupo (cartão) e bloquear conversa (direto).
    const grupo = await chamarCru(c, "wa_escolher_grupos", { adicionar: ["Família"] });
    assert.equal(grupo.isError, undefined, textoDe(grupo));
    assert.equal((await clicar(c, grupo)).isError, undefined);
    assert.deepEqual((await dono.ctx.nucleo()).banco.gruposPermitidos(), [GRUPO]);

    // Desconectar: logout de verdade no socket do dono.
    const desc = await chamarCru(c, "wa_desconectar");
    assert.equal(desc.isError, undefined, textoDe(desc));
    assert.equal((await clicar(c, desc)).isError, undefined);
    assert.equal(s.chamadas.filter((x) => x.metodo === "logout").length, 1);
  });

  it("o que o cliente do LEITOR declarou vale: sem MCP Apps, o dono responde \"Bloqueado\" e não cria pedido", async () => {
    const { dono, c } = await donoELeitor({ leitorComTela: false });
    const r = await chamarCru(c, "wa_envio", { ligar: true });
    assert.equal(r.isError, true);
    assert.match(textoDe(r), /Bloqueado/);
    assert.equal(dono.ctx.pedidos.ultimoConfirmado("envio"), undefined);
  });

  it("parear pelo leitor (aba Code): prévia, wa_confirmar com o QR no _meta, estado do pareamento e wa_qr", async () => {
    const dono = await montar({ pareada: false, esperaDoQrMs: 1_500 });
    montagens.push(dono);
    await dono.ctx.partida();
    const leitor = await montar({ dir: dono.dir, pareada: false });
    montagens.push(leitor);
    await leitor.ctx.partida();
    const c = await cliente(leitor);
    const previa = await chamarCru(c, "wa_parear");
    assert.equal(previa.isError, undefined, textoDe(previa));
    const promessa = chamarCru(c, "wa_confirmar", await pedidoPeloChat(previa));
    for (let i = 0; i < 200 && dono.fabrica.sockets.length === 0; i++) await new Promise((ok) => setTimeout(ok, 5));
    assert.equal(dono.fabrica.sockets.length, 1, "o socket abriu no DONO");
    dono.socket().qr("2@QR-DE-TESTE-DO-REPASSE");
    const r: Resultado = await promessa;
    assert.equal(r.isError, undefined, textoDe(r));
    assert.equal(r.structuredContent!.etapa, "qr");
    assert.ok(validarMatriz((r._meta as { qr_matriz?: unknown }).qr_matriz), "a matriz do QR voltou no _meta");
    assert.ok(!JSON.stringify(r.structuredContent).includes("QR-DE-TESTE"));
    const tela = await chamarCru(c, "wa_estado_pareamento_tela", { id: pedidoDa(previa).id });
    assert.equal(tela.structuredContent!.etapa, "qr");
    const qr = await chamarCru(c, "wa_qr", { pedido: pedidoDa(previa).id });
    assert.ok(validarMatriz((qr._meta as { qr_matriz?: unknown }).qr_matriz));
    assert.equal(leitor.fabrica.sockets.length, 0);
  });

  it("chamada que chega durante a partida (lock ainda sendo tentado) espera o papel e vai ao dono", async () => {
    // Achado do autoteste: o stdio aceita pedidos logo e a partida corre ao lado; sem esperar, a primeira chamada era
    // executada no leitor como se não houvesse dono.
    const dono = await montar();
    montagens.push(dono);
    await conectar(dono);
    const leitor = await montar({ dir: dono.dir, pareada: false });
    montagens.push(leitor);
    const c = await cliente(leitor);
    const partida = leitor.ctx.partida();
    const e = await chamarCru(c, "wa_estado");
    await partida;
    assert.equal(leitor.ctx.papel, "leitor");
    assert.equal(e.structuredContent!.por_outra_sessao_do_claude, true, textoDe(e));
  });

  it("pelo canal, só ferramentas do mapa e com argumentos válidos (o mesmo esquema do MCP)", async () => {
    const { dono, s } = await donoELeitor();
    const endereco = lerLock(dono).canal!;
    const chave = chaveDoCanal(Buffer.from(CHAVE_TESTE, "hex"));
    const fora = await chamarPeloCanal({ endereco, chave, pedido: { ferramenta: "eval", argumentos: {}, temTela: true } });
    assert.equal(fora.isError, true);
    const invalido = await chamarPeloCanal({ endereco, chave, pedido: { ferramenta: "wa_responder", argumentos: { conversa: 123, texto: "" }, temTela: true } });
    assert.equal(invalido.isError, true);
    const sobra = await chamarPeloCanal({ endereco, chave, pedido: { ferramenta: "wa_estado", argumentos: { extra: 1 }, temTela: true } });
    assert.equal(sobra.isError, true, "esquema estrito");
    assert.equal(envios(s).length, 0);
  });
});

describe("quando o canal não responde", () => {
  it("lock de versão antiga (sem canal): leitura cai no local; o resto recusa com frase clara, sem criar pedido", async () => {
    const { dono } = await donoELeitor();
    await dono.ctx.encerrar();
    montagens.splice(montagens.indexOf(dono), 1);
    // Um "dono" da 0.5.0: este mesmo processo vivo, sem o campo canal.
    writeFileSync(join(dono.config.dirDados, "conexao.lock"), JSON.stringify({ pid: process.pid, token: "da-0-5-0", inicio: inicioDesteProcesso() }));
    const leitor = await montar({ dir: dono.dir, pareada: false });
    montagens.push(leitor);
    await leitor.ctx.partida();
    assert.equal(leitor.ctx.papel, "leitor");
    const c = await cliente(leitor);
    const lista = await chamarCru(c, "wa_listar_conversas");
    assert.equal(lista.isError, undefined, textoDe(lista));
    assert.equal((lista.structuredContent!.conversas as unknown[]).length, 1, "leu o banco localmente");
    for (const [nome, args] of [["wa_parear", {}], ["wa_envio", { ligar: true }], ["wa_responder", { conversa: ANA, texto: "x" }], ["wa_confirmar", { id: "ab", codigo: "cd" }]] as const) {
      const r = await chamarCru(c, nome, args);
      assert.equal(r.isError, true, nome);
      assert.match(textoDe(r), /A conexão está com outra sessão do Claude e não consegui falar com ela agora; tente de novo em instantes/, nome);
      assert.equal(r._meta, undefined, `${nome}: nenhuma prévia`);
    }
    assert.equal(leitor.ctx.pedidos.ultimoConfirmado("envio"), undefined);
  });

  it("chave diferente no leitor: o aperto de mão falha e nada que escreve é feito", async () => {
    const { dono, s } = await donoELeitor();
    const leitor = await montar({ dir: dono.dir, pareada: false, chaveHex: "d".repeat(64) });
    montagens.push(leitor);
    await leitor.ctx.partida();
    const c = await cliente(leitor);
    const r = await chamarCru(c, "wa_responder", { conversa: ANA, texto: "x" });
    assert.match(textoDe(r), /não consegui falar com ela agora/);
    assert.equal(envios(s).length, 0);
  });

  it("promoção: o dono sai, o leitor vira dono e passa a escutar; um terceiro repassa a ele", async () => {
    const dono = await montar();
    montagens.push(dono);
    await conectar(dono);
    const leitor = await montar({ dir: dono.dir, pareada: false, intervaloDoLockMs: 20 });
    montagens.push(leitor);
    await leitor.ctx.partida();
    const canalAntigo = lerLock(dono).canal;
    await dono.ctx.encerrar();
    for (let i = 0; i < 200 && leitor.ctx.papel !== "dono_da_conexao"; i++) await new Promise((ok) => setTimeout(ok, 10));
    assert.equal(leitor.ctx.papel, "dono_da_conexao");
    for (let i = 0; i < 200 && lerLock(leitor).canal === canalAntigo; i++) await new Promise((ok) => setTimeout(ok, 10));
    assert.notEqual(lerLock(leitor).canal, canalAntigo, "canal novo, com nome novo");
    const terceiro = await montar({ dir: dono.dir, pareada: false });
    montagens.push(terceiro);
    await terceiro.ctx.partida();
    const c = await cliente(terceiro);
    let e: Resultado | undefined;
    for (let i = 0; i < 100; i++) {
      e = await chamarCru(c, "wa_estado");
      if (e.structuredContent?.por_outra_sessao_do_claude === true) break;
      await new Promise((ok) => setTimeout(ok, 10));
    }
    assert.equal(e!.structuredContent!.por_outra_sessao_do_claude, true, "o novo dono atende pelo canal");
  });

  it("as instruções não mandam mais \"responder pela outra sessão\"", () => {
    assert.ok(!/responda por ela/.test(INSTRUCOES));
    assert.match(INSTRUCOES, /outra sessão do Claude/);
  });
});
