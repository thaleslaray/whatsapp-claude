// 0.17.0: wa_responder_lote. Um cartão, várias conversas, um clique. Garantias do wa_responder item a item.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { contarMarcados, itensDoLoteParaMostrar, lerLote, resultadoDoLoteParaMostrar, rotuloDoBotaoDoLote, serializarLote } from "../ui/edicao.js";
import { ANA, assentar, BETO, chamarCru, clicar, confirmarPeloChat, conectar, conectarCliente, GRUPO, ligarEnvio, montar, pedidoDa, pn, textoDe, type Montagem } from "./ajuda.ts";
import { msg, type SocketFalso } from "./socket-falso.ts";

type Cliente = Awaited<ReturnType<typeof conectarCliente>>["cliente"];
let m: Montagem | undefined;
let fecharCliente: (() => Promise<void>) | undefined;
afterEach(async () => {
  await fecharCliente?.();
  fecharCliente = undefined;
  await m?.fechar();
  m = undefined;
});

const envios = (s: SocketFalso) => s.chamadas.filter((c) => c.metodo === "sendMessage");
const enviado = (s: SocketFalso): Array<[string, string]> => envios(s).map((c) => [c.args[0] as string, (c.args[1] as { text: string }).text]);
const registro = (mm: Montagem): Array<Record<string, unknown>> =>
  readFileSync(mm.caminhoRegistro, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

async function cenario(opcoes: { limiteDiario?: number } = {}): Promise<{ s: SocketFalso; c: Cliente }> {
  m = await montar(opcoes);
  const s = await conectar(m);
  const { banco } = await m.ctx.nucleo();
  banco.permitirGrupo(GRUPO);
  const t = Date.now() - 60_000;
  s.mensagens([
    msg({ jid: pn(ANA), id: "A1", texto: "Que horas você chega?", nome: "Ana Paula", ts: t }),
    msg({ jid: pn(BETO), id: "B1", texto: "reunião amanhã", nome: "Beto", ts: t + 1000 }),
    msg({ jid: GRUPO, id: "G1", texto: "almoço?", participante: pn(BETO), ts: t + 2000 }),
  ]);
  await assentar(m);
  const { cliente, fechar } = await conectarCliente(m.ctx);
  fecharCliente = fechar;
  await ligarEnvio(cliente);
  return { s, c: cliente };
}

const itens = (...x: Array<[string, string[]]>) => x.map(([conversa, mensagens]) => ({ conversa, mensagens }));

describe("wa_responder_lote: validação antes do cartão", () => {
  it("envio desligado, conversa desconhecida, grupo fora da lista, nunca ler, citação falsa, duplicada e texto vazio recusam o lote inteiro", async () => {
    const { s, c } = await cenario();
    const { banco } = await m!.ctx.nucleo();
    const casos: Array<[Record<string, unknown>, RegExp]> = [
      [{ itens: itens([ANA, ["oi"]], ["Fulano de Tal", ["oi"]]) }, /Item 2 \(Fulano de Tal\).*Não achei conversa/],
      [{ itens: itens([ANA, ["oi"]], ["120363000000000009@g.us", ["oi"]]) }, /Item 2.*wa_escolher_grupos/],
      [{ itens: [{ conversa: ANA, mensagens: ["oi"], citar: "NAO-EXISTE" }] }, /Item 1.*não achei essa mensagem/],
      [{ itens: itens([ANA, ["oi"]], ["Ana Paula", ["de novo"]]) }, /Item 2.*já aparece em outro item/],
      [{ itens: itens([ANA, ["   "]]) }, /Item 1.*vazio/],
      [{ itens: itens([ANA, ["x".repeat(4097)]]) }, /Item 1.*máximo é 4096/],
    ];
    for (const [args, erro] of casos) {
      const r = await chamarCru(c, "wa_responder_lote", args);
      assert.equal(r.isError, true, JSON.stringify(args).slice(0, 80));
      assert.match(String(r.structuredContent?.erro), erro);
      assert.equal(r._meta, undefined, "sem prévia");
    }
    banco.bloquear(pn(BETO));
    const bloqueado = await chamarCru(c, "wa_responder_lote", { itens: itens([ANA, ["oi"]], [pn(BETO), ["oi"]]) });
    assert.match(String(bloqueado.structuredContent?.erro), /Item 2.*nunca ler/);
    banco.definirEnvio(false);
    const desligado = await chamarCru(c, "wa_responder_lote", { itens: itens([ANA, ["oi"]]) });
    assert.match(String(desligado.structuredContent?.erro), /wa_envio/);
    assert.equal(envios(s).length, 0);
  });

  it("o esquema limita 1 a 10 itens e 1 a 5 mensagens por item", async () => {
    const { c } = await cenario();
    for (const args of [{ itens: [] }, { itens: Array.from({ length: 11 }, () => ({ conversa: ANA, mensagens: ["a"] })) }, { itens: [{ conversa: ANA, mensagens: [] }] }, { itens: [{ conversa: ANA, mensagens: ["1", "2", "3", "4", "5", "6"] }] }]) {
      const r = await chamarCru(c, "wa_responder_lote", args);
      assert.equal(r.isError, true);
      assert.equal(r._meta, undefined);
    }
  });

  it("limite diário: cada mensagem conta 1 e o lote inteiro tem de caber; a recusa diz quantas cabem", async () => {
    const { s, c } = await cenario({ limiteDiario: 3 });
    const r = await chamarCru(c, "wa_responder_lote", { itens: itens([ANA, ["1", "2"]], [BETO, ["3", "4"]]) });
    assert.equal(r.isError, true);
    assert.match(String(r.structuredContent?.erro), /4 mensagens.*limite do dia \(3\).*cabem só 3/);
    assert.equal(r._meta, undefined);
    const cabe = await chamarCru(c, "wa_responder_lote", { itens: itens([ANA, ["1", "2"]], [BETO, ["3"]]) });
    assert.equal(cabe.isError, undefined, textoDe(cabe));
    assert.equal((await clicar(c, cabe)).isError, undefined);
    assert.equal(envios(s).length, 3);
    const cheio = await chamarCru(c, "wa_responder_lote", { itens: itens([ANA, ["x"]]) });
    assert.match(String(cheio.structuredContent?.erro), /não cabe nenhuma/);
  });

  it("o limite é conferido de novo no clique", async () => {
    const { s, c } = await cenario({ limiteDiario: 3 });
    const lote = await chamarCru(c, "wa_responder_lote", { itens: itens([ANA, ["1", "2"]]) });
    const a1 = await chamarCru(c, "wa_responder", { conversa: BETO, texto: "x" });
    const a2 = await chamarCru(c, "wa_responder", { conversa: BETO, texto: "y" });
    assert.equal((await clicar(c, a1)).isError, undefined);
    assert.equal((await clicar(c, a2)).isError, undefined);
    const r = await clicar(c, lote);
    assert.equal(r.isError, true);
    assert.match(textoDe(r), /já não comporta o lote.*cabem 1/);
    assert.equal(envios(s).length, 2, "só as avulsas saíram");
  });
});

describe("wa_responder_lote: o cartão e o envio", () => {
  it("a prévia: uma seção por item, última recebida, destaque de grupo; o modelo só vê pedido e orientação", async () => {
    const { s, c } = await cenario();
    const r = await chamarCru(c, "wa_responder_lote", { itens: [{ conversa: "Ana Paula", mensagens: ["Chego às 8!", "E levo o bolo"], citar: "A1" }, { conversa: GRUPO, mensagens: ["bora"] }] });
    assert.equal(r.isError, undefined, textoDe(r));
    assert.deepEqual(Object.keys(r.structuredContent!).sort(), ["para_o_claude", "pedido", "se_o_cartao_nao_apareceu"]);
    assert.match(String(r.structuredContent!.para_o_claude), /Pare aqui e espere o clique/);
    const visivel = JSON.stringify(r.structuredContent) + textoDe(r);
    for (const proibido of ["Ana Paula", ANA, "Chego às 8", "bora", String(r._meta!.codigo)]) assert.ok(!visivel.includes(proibido), `o modelo viu ${proibido}`);
    const previa = r._meta!.previa as Record<string, any>;
    assert.equal(previa.tipo, "responder_lote");
    assert.equal(previa.botao, "Enviar todas (2)");
    assert.equal(previa.texto, serializarLote([true, true], [["Chego às 8!", "E levo o bolo"], ["bora"]]));
    assert.ok(previa.texto_editavel);
    assert.equal(previa.lote.length, 2);
    assert.match(previa.lote[0].alvo, /^\+55 11 9\*\*\*\*-5678 · c_/);
    assert.match(previa.lote[1].destaque, /^GRUPO:/);
    assert.equal(previa.conteudo_de_terceiros.lote[0].nome, "Ana Paula");
    assert.equal(previa.conteudo_de_terceiros.lote[0].ultima.texto, "Que horas você chega?");
    assert.equal(previa.conteudo_de_terceiros.lote[0].citada, "Que horas você chega?");
    assert.equal(envios(s).length, 0, "a prévia não envia");
  });

  it("sem clique nada sai; com um clique saem todas, em ordem, e o segundo clique não reenvia", async () => {
    const { s, c } = await cenario();
    const previa = await chamarCru(c, "wa_responder_lote", { itens: itens([ANA, ["a1", "a2", "a3"]], [BETO, ["b1"]]) });
    await new Promise((ok) => setTimeout(ok, 30));
    assert.equal(envios(s).length, 0);
    const r = await clicar(c, previa);
    assert.equal(r.isError, undefined, textoDe(r));
    assert.deepEqual(enviado(s), [[pn(ANA), "a1"], [pn(ANA), "a2"], [pn(ANA), "a3"], [pn(BETO), "b1"]]);
    const resultado = r.structuredContent!.resultado as { itens: Array<{ estado: string; enviadas: number }>; mensagens_enviadas: number; respostas_hoje: number };
    assert.deepEqual(resultado.itens.map((i) => [i.estado, i.enviadas]), [["enviado", 3], ["enviado", 1]]);
    assert.equal(resultado.mensagens_enviadas, 4);
    assert.equal(resultado.respostas_hoje, 4);
    assert.equal((await m!.ctx.nucleo()).banco.enviosDoDia(Date.now()), 4);
    assert.equal((await clicar(c, previa)).isError, true);
    assert.equal(envios(s).length, 4);
  });

  it("citar vale só para a primeira mensagem do item", async () => {
    const { s, c } = await cenario();
    const previa = await chamarCru(c, "wa_responder_lote", { itens: [{ conversa: ANA, mensagens: ["um", "dois"], citar: "A1" }] });
    await clicar(c, previa);
    const opcoes = envios(s).map((e) => e.args[2] as { quoted?: { key: { id: string } } });
    assert.equal(opcoes[0]!.quoted?.key.id, "A1");
    assert.equal(opcoes[1]!.quoted, undefined);
  });

  it("item desmarcado não sai; as edições do dono valem e ficam gravadas para o aprendizado", async () => {
    const { s, c } = await cenario();
    const { banco } = await m!.ctx.nucleo();
    const previa = await chamarCru(c, "wa_responder_lote", { itens: itens([ANA, ["proposta ana"]], [BETO, ["proposta beto"]], [GRUPO, ["proposta grupo"]]) });
    const forjado = await chamarCru(c, "wa_confirmar_tela", { id: pedidoDa(previa).id, codigo: pedidoDa(previa).codigo, texto: serializarLote([true, false, true], [["x"], ["y"], ["z"]]) });
    assert.equal(forjado.isError, true, "o código original não vale para outra decisão");
    assert.equal(envios(s).length, 0);
    const r = await clicar(c, previa, serializarLote([true, false, true], [["texto que EU escrevi"], ["proposta beto"], ["proposta grupo"]]));
    assert.equal(r.isError, undefined, textoDe(r));
    assert.deepEqual(enviado(s), [[pn(ANA), "texto que EU escrevi"], [GRUPO, "proposta grupo"]]);
    const resultado = r.structuredContent!.resultado as { itens: Array<{ estado: string }>; respostas_hoje: number };
    assert.deepEqual(resultado.itens.map((i) => i.estado), ["enviado", "nao_enviado", "enviado"]);
    assert.equal(resultado.respostas_hoje, 2);
    const guardada = banco.lerMensagens(pn(ANA)).at(-1)!;
    assert.equal(guardada.texto, "texto que EU escrevi");
    assert.equal(guardada.rascunho_da_ia, "editado", "a mensagem leva a marca de rascunho editado (aprendizado)");
    const edicoes = banco.edicoes();
    assert.equal(edicoes.length, 1, "só a mensagem editada vira edição guardada");
    assert.equal(edicoes[0]!.rascunho, "proposta ana");
    assert.equal(edicoes[0]!.enviado, "texto que EU escrevi");
    assert.equal(edicoes[0]!.ferramenta, "wa_responder");
  });

  it("decisão recusada: nenhuma marcada, mensagem vazia, número de mensagens mudado; o pedido segue de pé", async () => {
    const { s, c } = await cenario();
    const previa = await chamarCru(c, "wa_responder_lote", { itens: itens([ANA, ["a", "b"]], [BETO, ["c"]]) });
    const nenhuma = await clicar(c, previa, serializarLote([false, false], [["a", "b"], ["c"]]));
    assert.match(textoDe(nenhuma), /Nenhuma conversa está marcada/);
    const vazio = await clicar(c, previa, serializarLote([true, true], [["a", "  "], ["c"]]));
    assert.match(textoDe(vazio), /Item 1, mensagem 2.*vazio/);
    assert.equal(envios(s).length, 0);
    const ok = await clicar(c, previa, serializarLote([true, false], [["a", "b2"], ["c"]]));
    assert.equal(ok.isError, undefined, textoDe(ok));
    assert.deepEqual(enviado(s), [[pn(ANA), "a"], [pn(ANA), "b2"]]);
  });

  it("trocar o número de mensagens de um item é recusado", async () => {
    const { s, c } = await cenario();
    const previa = await chamarCru(c, "wa_responder_lote", { itens: itens([ANA, ["a", "b"]]) });
    const menos = await clicar(c, previa, serializarLote([true], [["a"]]));
    assert.match(textoDe(menos), /mudou o número de mensagens/);
    assert.equal(envios(s).length, 0);
  });

  it("pelo chat (aba Code): o wa_confirmar só vale com o texto da decisão", async () => {
    const { s, c } = await cenario();
    const previa = await chamarCru(c, "wa_responder_lote", { itens: itens([ANA, ["oi ana"]], [BETO, ["oi beto"]]) });
    const r = await confirmarPeloChat(c, previa);
    assert.equal(r.isError, undefined, textoDe(r));
    assert.equal(enviado(s).length, 2);
    const outra = await chamarCru(c, "wa_responder_lote", { itens: itens([ANA, ["de novo"]]) });
    const editado = await confirmarPeloChat(c, outra, serializarLote([true], [["editado no cartão"]]));
    assert.equal(editado.isError, undefined, textoDe(editado));
    assert.deepEqual(enviado(s).at(-1), [pn(ANA), "editado no cartão"]);
  });

  it("falha num item não derruba os outros; as mensagens seguintes do item que falhou não saem; o resultado diz por quê", async () => {
    const { s, c } = await cenario();
    s.falharEnvioNumero = 2; // a 2ª mensagem da Ana
    const previa = await chamarCru(c, "wa_responder_lote", { itens: itens([ANA, ["a1", "a2", "a3"]], [BETO, ["b1"]]) });
    const r = await clicar(c, previa);
    assert.equal(r.isError, undefined, textoDe(r));
    const resultado = r.structuredContent!.resultado as { itens: Array<{ estado: string; enviadas: number; erro?: string }> };
    assert.deepEqual(resultado.itens.map((i) => [i.estado, i.enviadas]), [["parcial", 1], ["enviado", 1]]);
    assert.ok(resultado.itens[0]!.erro);
    assert.match(textoDe(r), /falhou na mensagem 2 de 3/);
    // O socket registra a tentativa que falhou (a2); a3 nunca foi tentada.
    assert.deepEqual(enviado(s).map((x) => x[1]), ["a1", "a2", "b1"]);
    assert.deepEqual((await m!.ctx.nucleo()).banco.lerMensagens(pn(ANA)).filter((x) => x.de_mim).map((x) => x.texto), ["a1"]);
  });

  it("cada envio entra no registro de ações, sem o texto", async () => {
    const { c } = await cenario();
    const previa = await chamarCru(c, "wa_responder_lote", { itens: itens([ANA, ["segredo-do-texto-1", "segredo-do-texto-2"]], [BETO, ["b"]]) });
    const { id } = pedidoDa(previa);
    await clicar(c, previa);
    const linhas = registro(m!).filter((l) => l.ferramenta === "wa_responder_lote" && l.evento === "enviado");
    const porMensagem = linhas.filter((l) => l.mensagem_id);
    assert.equal(porMensagem.length, 3);
    assert.deepEqual(porMensagem.map((l) => l.ordem), [1, 2, 1]);
    assert.ok(porMensagem.every((l) => l.pedido === id && typeof l.conversa === "string" && l.conversa.startsWith("c_")));
    assert.ok(linhas.some((l) => l.confirmacao === "wa_confirmar_tela" && !l.mensagem_id), "a linha do pedido");
    assert.ok(!readFileSync(m!.caminhoRegistro, "utf8").includes("segredo-do-texto"), "o registro nunca leva o texto");
  });

  it("cancelar não envia nada", async () => {
    const { s, c } = await cenario();
    const previa = await chamarCru(c, "wa_responder_lote", { itens: itens([ANA, ["x"]]) });
    assert.equal((await chamarCru(c, "wa_cancelar_pedido", { id: pedidoDa(previa).id })).isError, undefined);
    assert.equal((await clicar(c, previa)).isError, true);
    assert.equal(envios(s).length, 0);
  });
});

describe("wa_responder_lote: lógica do cartão (ui/edicao.js)", () => {
  it("a decisão vai e volta; o botão conta os marcados; lixo é recusado", () => {
    const t = serializarLote([true, false], [["a", "b"], ["c"]]);
    assert.deepEqual(lerLote(t), { enviar: [true, false], mensagens: [["a", "b"], ["c"]] });
    assert.equal(contarMarcados([true, false, true]), 2);
    assert.equal(rotuloDoBotaoDoLote(0), "Enviar todas (0)");
    for (const lixo of ["não é json", "{}", '{"enviar":[true],"mensagens":[]}', '{"enviar":["sim"],"mensagens":[["a"]]}', '{"enviar":[true],"mensagens":[[1]]}']) assert.throws(() => lerLote(lixo), /não é válida/);
  });

  it("itens e resultado para mostrar", () => {
    const itensDoCartao = itensDoLoteParaMostrar({ lote: [{ alvo: "c_1", destaque: "GRUPO: 3" }, { alvo: "c_2" }], conteudo_de_terceiros: { lote: [{ nome: "Ana", ultima: { data: "2026-11-17T10:00:00Z", texto: "oi" } }, {}] } });
    assert.deepEqual(itensDoCartao.map((i) => [i.alvo, i.nome, i.destaque, i.ultima?.texto ?? null]), [["c_1", "Ana", "GRUPO: 3", "oi"], ["c_2", "", "", null]]);
    assert.deepEqual(resultadoDoLoteParaMostrar({ itens: [{ conversa: "c_1", estado: "enviado", frase: "ok" }, { x: 1 }] }), [{ conversa: "c_1", estado: "enviado", texto: "ok" }]);
  });
});
