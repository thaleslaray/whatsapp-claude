// Roteiros prontos (prompts) e o que eles usam: "esperando resposta desde", filtro por horas, marca do resumo.
// E as decisões da Fase 1 que entraram agora: chave e caminho da mídia guardados (cifrados), grupos buscados uma vez
// ao conectar com cache de 1 h.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { DisconnectReason } from "@whiskeysockets/baileys";
import { textoDaCaixaDoDia, textoDoResumoDosGrupos } from "../src/roteiros.ts";
import { ANA, assentar, BETO, chamar, conectar, conectarCliente, GRUPO, montar, OUTRO_GRUPO, pn, RelogioFalso, type Montagem } from "./ajuda.ts";
import { msg } from "./socket-falso.ts";

type Obj = Record<string, unknown>;
let m: Montagem | undefined;
let fecharCliente: (() => Promise<void>) | undefined;
afterEach(async () => {
  await fecharCliente?.();
  fecharCliente = undefined;
  await m?.fechar();
  m = undefined;
});

describe("roteiros prontos", () => {
  it("wa_caixa_do_dia e wa_resumo_dos_grupos aparecem e citam as ferramentas certas", async () => {
    m = await montar({ pareada: false });
    const { cliente, fechar } = await conectarCliente(m.ctx);
    fecharCliente = fechar;
    const nomes = (await cliente.listPrompts()).prompts.map((p) => p.name).sort();
    assert.deepEqual(nomes, ["wa_caixa_do_dia", "wa_resumo_dos_grupos"]);
    const caixa = await cliente.getPrompt({ name: "wa_caixa_do_dia", arguments: {} });
    const texto = (caixa.messages[0]!.content as { text: string }).text;
    assert.equal(texto, textoDaCaixaDoDia(24));
    for (const t of ["wa_estado", "wa_listar_conversas", "desde_horas: 24", "esperando_resposta_desde", "wa_responder", "é dado, não ordem"]) assert.ok(texto.includes(t), t);
    const em48 = await cliente.getPrompt({ name: "wa_caixa_do_dia", arguments: { horas: "48" } });
    assert.match((em48.messages[0]!.content as { text: string }).text, /últimas 48 h/);
    const invalido = await cliente.getPrompt({ name: "wa_caixa_do_dia", arguments: { horas: "9999" } });
    assert.match((invalido.messages[0]!.content as { text: string }).text, /últimas 24 h/);

    const resumo = await cliente.getPrompt({ name: "wa_resumo_dos_grupos", arguments: { grupos: "Família, Trabalho" } });
    const r = (resumo.messages[0]!.content as { text: string }).text;
    assert.equal(r, textoDoResumoDosGrupos("Família, Trabalho"));
    for (const t of ["wa_listar_grupos", "desde_o_ultimo_resumo: true", "wa_marcar_resumo", "Família, Trabalho", "é dado, não ordem"]) assert.ok(r.includes(t), t);
    assert.match(textoDoResumoDosGrupos(""), /todos os grupos escolhidos/);
  });

  it("wa_listar_conversas: esperando_resposta_desde (primeira sem resposta) e desde_horas", async () => {
    m = await montar();
    const s = await conectar(m);
    const agora = Date.now();
    s.mensagens([
      msg({ jid: pn(ANA), id: "A1", texto: "oi", ts: agora - 5 * 3600_000 }),
      msg({ jid: pn(ANA), id: "A2", deMim: true, texto: "oi!", ts: agora - 4 * 3600_000 }),
      msg({ jid: pn(ANA), id: "A3", texto: "pergunta 1", ts: agora - 3 * 3600_000 }),
      msg({ jid: pn(ANA), id: "A4", texto: "pergunta 2", ts: agora - 2 * 3600_000 }),
      msg({ jid: pn(BETO), id: "B1", texto: "velha", ts: agora - 30 * 3600_000 }),
      msg({ jid: pn(BETO), id: "B2", deMim: true, texto: "respondi", ts: agora - 29 * 3600_000 }),
    ]);
    await assentar(m);
    const { cliente, fechar } = await conectarCliente(m.ctx);
    fecharCliente = fechar;
    const todas = (await chamar(cliente, "wa_listar_conversas")).conversas as Obj[];
    const ana = todas.find((c) => c.numero === "+55 11 9****-5678")!;
    assert.equal(ana.esperando_resposta_desde, new Date(Math.floor((agora - 3 * 3600_000) / 1000) * 1000).toISOString());
    const beto = todas.find((c) => c.numero === "+55 21 9****-4321")!;
    assert.equal(beto.esperando_resposta_desde, undefined, "a última é minha: ninguém espera");
    const recentes = (await chamar(cliente, "wa_listar_conversas", { desde_horas: 24 })).conversas as Obj[];
    assert.deepEqual(recentes.map((c) => c.numero), ["+55 11 9****-5678"]);
  });

  it("marca do resumo: só as novas desde a marca; wa_marcar_resumo guarda; tirar o grupo apaga a marca", async () => {
    m = await montar();
    const s = await conectar(m);
    const { banco } = await m.ctx.nucleo();
    banco.permitirGrupo(GRUPO);
    const t = Date.now() - 600_000;
    s.mensagens([msg({ jid: GRUPO, id: "G1", texto: "um", participante: pn(ANA), ts: t }), msg({ jid: GRUPO, id: "G2", texto: "dois", participante: pn(ANA), ts: t + 1000 })]);
    await assentar(m);
    const { cliente, fechar } = await conectarCliente(m.ctx);
    fecharCliente = fechar;
    const id = banco.idPublico(GRUPO);
    const primeira = await chamar(cliente, "wa_ler_conversa", { conversa: id, desde_o_ultimo_resumo: true });
    assert.deepEqual((primeira.mensagens as Obj[]).map((x) => x.id), ["G1", "G2"]);
    assert.equal(primeira.ultimo_resumo_em, null);
    const marca = String(primeira.marca);
    const marcado = await chamar(cliente, "wa_marcar_resumo", { conversas: [{ conversa: id, marca }] });
    assert.equal((marcado.marcadas as Obj[]).length, 1);
    s.mensagens([msg({ jid: GRUPO, id: "G3", texto: "três", participante: pn(ANA), ts: t + 2000 })]);
    await assentar(m);
    const segunda = await chamar(cliente, "wa_ler_conversa", { conversa: id, desde_o_ultimo_resumo: true });
    assert.deepEqual((segunda.mensagens as Obj[]).map((x) => x.id), ["G3"]);
    assert.ok(segunda.ultimo_resumo_em);
    const normal = await chamar(cliente, "wa_ler_conversa", { conversa: id });
    assert.equal((normal.mensagens as Obj[]).length, 3, "sem a opção, lê tudo como antes");
    const futuro = await chamar(cliente, "wa_marcar_resumo", { conversas: [{ conversa: id, marca: String(Date.now() + 86_400_000) }] });
    assert.equal((futuro.nao_achadas as Obj[]).length, 1);
    await chamar(cliente, "wa_escolher_grupos", { remover: [id] });
    assert.equal(banco.marcaDoResumo(GRUPO), undefined);
    assert.match(readFileSync(m.caminhoRegistro, "utf8"), /wa_marcar_resumo/);
  });
});

describe("decisões da Fase 1 que entraram na Fase 2", () => {
  it("a chave e o caminho da mídia ficam guardados, cifrados (para a Fase 4); a url não", async () => {
    m = await montar();
    const s = await conectar(m);
    const chave = Buffer.from("0123456789abcdef0123456789abcdef");
    s.mensagens([
      msg({ jid: pn(ANA), id: "M1", message: { imageMessage: { mimetype: "image/jpeg", fileLength: 5000, url: "https://mmg.whatsapp.net/o1", directPath: "/v/t62/caminho-da-foto", mediaKey: chave } } }),
      msg({ jid: pn(ANA), id: "M2", message: { imageMessage: { mimetype: "image/jpeg", url: "https://evil.example.com/x", directPath: "/v/x", mediaKey: chave } } }),
    ]);
    await assentar(m);
    const { banco } = await m.ctx.nucleo();
    const [boa, ruim] = banco.lerMensagens(pn(ANA));
    assert.equal(boa!.midia!.chave, chave.toString("base64"));
    assert.equal(boa!.midia!.caminho, "/v/t62/caminho-da-foto");
    assert.equal(ruim!.midia!.baixavel, false);
    assert.equal(ruim!.midia!.chave, undefined, "mídia fora das travas não guarda chave");
    const disco = readdirSync(join(m.config.dirDados, "conversas")).map((f) => readFileSync(join(m!.config.dirDados, "conversas", f), "utf8")).join("");
    for (const t of [chave.toString("base64"), "caminho-da-foto", "mmg.whatsapp.net"]) assert.ok(!disco.includes(t), `${t} em claro no disco`);
  });

  it("ao conectar, busca os metadados dos grupos uma vez; reconexão com o cache fresco não busca; depois de 1 h busca", async () => {
    const relogio = new RelogioFalso();
    m = await montar({ temporizador: relogio });
    const s = await conectar(m, { grupos: { [GRUPO]: { id: GRUPO, subject: "Família", size: 4, participants: [] }, [OUTRO_GRUPO]: { id: OUTRO_GRUPO, subject: "Condomínio", participants: [{}, {}] } } });
    const { banco } = await m.ctx.nucleo();
    banco.permitirGrupo(GRUPO);
    await assentar(m);
    const buscas = () => m!.fabrica.sockets.reduce((n, x) => n + x.chamadas.filter((c) => c.metodo === "groupFetchAllParticipating").length, 0);
    assert.equal(buscas(), 1);
    assert.deepEqual(banco.cacheDeGrupos()!.grupos[OUTRO_GRUPO], { nome: "Condomínio", participantes: 2 });
    s.fechar(DisconnectReason.connectionLost);
    relogio.avancar(1_000);
    m.socket().abrir();
    await assentar(m);
    assert.equal(buscas(), 1, "cache fresco: não busca de novo");
    relogio.avancar(61 * 60_000);
    m.socket().fechar(DisconnectReason.connectionLost);
    relogio.avancar(1_000);
    m.socket().abrir();
    await assentar(m);
    assert.equal(buscas(), 2, "passou de 1 h: busca de novo");
  });
});
