// 0.7.0, parte 1: escritas novas e histórico. O dono ampliou o escopo (13/11/2026): enviar para grupo escolhido,
// começar conversa com número novo, reagir, editar, apagar e pedir histórico antigo ao celular. Continuam valendo:
// nunca marcar como lida, nunca aparecer online, ler só os grupos escolhidos, prévia de link fora e o clique no cartão
// em toda escrita que não dá para desfazer. Um teste por comportamento, escrito antes do código.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import type { WAMessage } from "@whiskeysockets/baileys";
import { mensagemPublica } from "../src/apresentacao.ts";
import { lerConfig, lerLimiteNovasConversas } from "../src/config.ts";
import { converterMensagem } from "../src/conversao.ts";
import { INSTRUCOES } from "../src/servidor.ts";
import { destaqueParaMostrar, mensagemAtualParaMostrar } from "../ui/edicao.js";
import { ANA, assentar, BETO, chamarCru, clicar, conectar, conectarCliente, GRUPO, ligarEnvio, montar, OUTRO_GRUPO, pn, textoDe, type Montagem, type OpcoesMontagem, type Resultado } from "./ajuda.ts";
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

const NOVO = "5531999990000";
const envios = (s: SocketFalso) => s.chamadas.filter((c) => c.metodo === "sendMessage");
const registro = (mm: Montagem): Array<Record<string, unknown>> =>
  readFileSync(mm.caminhoRegistro, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
const erroDe = (r: Resultado) => String(r.structuredContent?.erro ?? textoDe(r));

/** Ana (com uma mensagem minha), Beto, o grupo Família escolhido (12 participantes) e um grupo não escolhido. */
async function cenario(opcoes: OpcoesMontagem & { ligar?: boolean; minhaTs?: number } = {}): Promise<{ s: SocketFalso; c: Cliente }> {
  m = await montar(opcoes);
  const s = await conectar(m, {
    grupos: {
      [GRUPO]: { id: GRUPO, subject: "Família", size: 12, participants: [] },
      [OUTRO_GRUPO]: { id: OUTRO_GRUPO, subject: "Trabalho", size: 40, participants: [] },
    },
  });
  await assentar(m);
  const { banco } = await m.ctx.nucleo();
  banco.permitirGrupo(GRUPO);
  const agora = (opcoes.agora ?? Date.now)();
  const t = agora - 5 * 60_000;
  s.mensagens([
    msg({ jid: pn(ANA), id: "A1", texto: "Que horas você chega?", nome: "Ana", ts: t }),
    msg({ jid: pn(ANA), id: "A2", deMim: true, texto: "Chego às 8", ts: opcoes.minhaTs ?? t + 1000 }),
    msg({ jid: pn(BETO), id: "B1", texto: "reunião amanhã", nome: "Beto", ts: t + 2000 }),
    msg({ jid: GRUPO, id: "G1", texto: "almoço?", participante: pn(BETO), nome: "Beto", ts: t + 3000 }),
  ]);
  await assentar(m);
  const { cliente, fechar } = await conectarCliente(m.ctx);
  fecharCliente = fechar;
  if (opcoes.ligar ?? true) await ligarEnvio(cliente);
  return { s, c: cliente };
}

describe("enviar para grupo escolhido (wa_responder)", () => {
  it("grupo escolhido: prévia com o nome do grupo e quantos participantes recebem, bem visível; envia ao grupo e conta no limite", async () => {
    const { s, c } = await cenario();
    const previa = await chamarCru(c, "wa_responder", { conversa: "Família", texto: "Chego às 8" });
    assert.equal(previa.isError, undefined, textoDe(previa));
    const p = previa._meta!.previa as Record<string, unknown>;
    assert.match(String(p.destaque), /GRUPO/);
    assert.match(String(p.destaque), /12 participantes/);
    assert.equal((p.conteudo_de_terceiros as Record<string, unknown>).nome, "Família");
    assert.equal(destaqueParaMostrar(p), p.destaque);
    assert.equal(envios(s).length, 0, "nada sem o clique");
    const r = await clicar(c, previa, "Chego às 8");
    assert.equal(r.isError, undefined, textoDe(r));
    assert.equal(envios(s).length, 1);
    assert.equal(envios(s)[0]!.args[0], GRUPO);
    assert.deepEqual(envios(s)[0]!.args[1], { text: "Chego às 8" });
    const ordem = s.chamadas.filter((x) => x.metodo === "sendPresenceUpdate").map((x) => [x.args[0], x.args[1]]);
    assert.deepEqual(ordem, [["composing", GRUPO], ["paused", GRUPO]], "digitando no grupo, nunca available");
    const { banco } = await m!.ctx.nucleo();
    assert.equal(banco.enviosDoDia(Date.now()), 1);
    assert.equal(banco.lerMensagens(GRUPO).at(-1)!.de_mim, true);
  });

  it("grupo fora da lista: recusa antes da prévia, com frase que ensina a incluir", async () => {
    const { c } = await cenario();
    const r = await chamarCru(c, "wa_responder", { conversa: OUTRO_GRUPO, texto: "oi" });
    assert.equal(r.isError, true);
    assert.match(erroDe(r), /wa_escolher_grupos/);
    assert.equal(r._meta, undefined);
  });

  it("citar em grupo leva o participante na chave da mensagem citada", async () => {
    const { s, c } = await cenario();
    const r = await clicar(c, await chamarCru(c, "wa_responder", { conversa: GRUPO, texto: "eu topo", citar: "G1" }), "eu topo");
    assert.equal(r.isError, undefined, textoDe(r));
    const opcoes = envios(s)[0]!.args[2] as { quoted: { key: { id: string; participant?: string; remoteJid: string } } };
    assert.equal(opcoes.quoted.key.id, "G1");
    assert.equal(opcoes.quoted.key.remoteJid, GRUPO);
    assert.equal(opcoes.quoted.key.participant, pn(BETO));
  });

  it("grupo que saiu da lista depois da prévia: o clique não envia", async () => {
    const { s, c } = await cenario();
    const previa = await chamarCru(c, "wa_responder", { conversa: GRUPO, texto: "oi" });
    (await m!.ctx.nucleo()).banco.removerGrupo(GRUPO);
    const r = await clicar(c, previa, "oi");
    assert.equal(r.isError, true);
    assert.equal(envios(s).length, 0);
  });
});

describe("começar conversa com número novo (wa_iniciar_conversa)", () => {
  it("recusa número que não parece telefone, número sem WhatsApp, conversa que já existe e envio desligado, sem criar pedido", async () => {
    const { s, c } = await cenario();
    s.semWhatsApp.add(pn("5531988887777"));
    const casos: Array<[Record<string, unknown>, RegExp]> = [
      [{ numero: "abc", texto: "oi" }, /não parece um número de telefone/],
      [{ numero: "1234", texto: "oi" }, /não parece um número de telefone/],
      [{ numero: "+55 31 98888-7777", texto: "oi" }, /não tem WhatsApp/],
      [{ numero: `+${ANA}`, texto: "oi" }, /wa_responder/],
      [{ numero: NOVO, texto: "  " }, /vazio/],
    ];
    for (const [args, erro] of casos) {
      const r = await chamarCru(c, "wa_iniciar_conversa", args);
      assert.equal(r.isError, true, JSON.stringify(args));
      assert.match(erroDe(r), erro, JSON.stringify(args));
      assert.equal(r._meta, undefined, "sem prévia");
    }
    assert.ok(s.chamadas.some((x) => x.metodo === "onWhatsApp"), "conferiu no WhatsApp");
    assert.equal(m!.ctx.pedidos.situacao("x").estado, "inexistente");
  });

  it("feliz: o cartão mostra o número INTEIRO (só no _meta), o texto editável; o clique envia, a conversa passa a existir e conta nos dois limites", async () => {
    const { s, c } = await cenario();
    const previa = await chamarCru(c, "wa_iniciar_conversa", { numero: "+55 (31) 99999-0000", texto: "Oi, aqui é o Thales" });
    assert.equal(previa.isError, undefined, textoDe(previa));
    const p = previa._meta!.previa as Record<string, unknown>;
    assert.equal(p.tipo, "iniciar");
    assert.match(String(p.alvo), new RegExp(`\\+${NOVO}`));
    assert.match(String(p.destaque), new RegExp(`\\+${NOVO}`));
    assert.ok(p.texto_editavel, "texto editável");
    assert.ok(!JSON.stringify(previa.structuredContent).includes(NOVO), "o modelo não vê o número inteiro");
    assert.ok(!textoDe(previa).includes(NOVO));
    assert.equal(envios(s).length, 0);
    const r = await clicar(c, previa, "Oi, aqui é o Thales!");
    assert.equal(r.isError, undefined, textoDe(r));
    assert.equal(envios(s).length, 1);
    assert.equal(envios(s)[0]!.args[0], pn(NOVO));
    assert.deepEqual(envios(s)[0]!.args[1], { text: "Oi, aqui é o Thales!" });
    const { banco } = await m!.ctx.nucleo();
    assert.equal(banco.lerMensagens(pn(NOVO)).length, 1);
    assert.equal(banco.enviosDoDia(Date.now()), 1);
    assert.equal(banco.contagemDoDia("novas", Date.now()), 1);
    const lista = await chamarCru(c, "wa_listar_conversas");
    assert.ok((lista.structuredContent!.conversas as Array<{ id: string }>).some((x) => x.id === banco.idPublico(pn(NOVO))));
    assert.ok(!JSON.stringify(registro(m!)).includes(NOVO), "o registro de ações nunca leva o número");
  });

  it("o WhatsApp devolve outro jid (nono dígito): a prévia mostra e o envio vai para o jid devolvido", async () => {
    const { s, c } = await cenario();
    s.jidCorrigido.set(pn(NOVO), pn("553199990000"));
    const previa = await chamarCru(c, "wa_iniciar_conversa", { numero: NOVO, texto: "oi" });
    assert.match(String((previa._meta!.previa as Record<string, unknown>).alvo), /\+553199990000/);
    await clicar(c, previa, "oi");
    assert.equal(envios(s)[0]!.args[0], pn("553199990000"));
  });

  it("teto próprio por dia: 0 desliga a ferramenta; com 1, a segunda conversa nova é recusada", async () => {
    {
      const { c } = await cenario({ limiteNovasConversas: 0 });
      const r = await chamarCru(c, "wa_iniciar_conversa", { numero: NOVO, texto: "oi" });
      assert.equal(r.isError, true);
      assert.match(erroDe(r), /desligad/);
      await fecharCliente!();
      fecharCliente = undefined;
      await m!.fechar();
      m = undefined;
    }
    const { c } = await cenario({ limiteNovasConversas: 1 });
    assert.equal((await clicar(c, await chamarCru(c, "wa_iniciar_conversa", { numero: NOVO, texto: "oi" }), "oi")).isError, undefined);
    const segunda = await chamarCru(c, "wa_iniciar_conversa", { numero: "5531977776666", texto: "oi" });
    assert.equal(segunda.isError, true);
    assert.match(erroDe(segunda), /conversas novas por dia/);
  });

  it("o contador de conversas novas sobrevive ao apagarTudo (como o de respostas)", async () => {
    await cenario({ ligar: false });
    const { banco } = await m!.ctx.nucleo();
    banco.reservarContagens(Date.now(), [{ tipo: "novas", limite: 5, frase: "x" }]);
    banco.apagarTudo();
    assert.equal(banco.contagemDoDia("novas", Date.now()), 1);
  });

  it("o campo do manifesto: número de 0 a 20, padrão 5", () => {
    assert.equal(lerLimiteNovasConversas(""), 5);
    assert.equal(lerLimiteNovasConversas("0"), 0);
    assert.equal(lerLimiteNovasConversas("20.0"), 20);
    const avisos: string[] = [];
    assert.equal(lerLimiteNovasConversas("21", avisos), 20);
    assert.equal(lerLimiteNovasConversas("x", avisos), 5);
    assert.equal(avisos.length, 2);
    assert.equal(lerConfig({ WA_LIMITE_NOVAS_CONVERSAS: "${user_config.WA_LIMITE_NOVAS_CONVERSAS}" }).limiteNovasConversas, 5);
  });
});

describe("reagir (wa_reagir, direto e reversível)", () => {
  it("reage na hora, sem cartão, e fica no registro; emoji vazio tira a reação", async () => {
    const { s, c } = await cenario();
    const r = await chamarCru(c, "wa_reagir", { conversa: ANA, mensagem: "A1", emoji: "👍" });
    assert.equal(r.isError, undefined, textoDe(r));
    assert.equal(r._meta?.codigo, undefined, "sem cartão");
    assert.deepEqual(envios(s)[0]!.args, [pn(ANA), { react: { text: "👍", key: { remoteJid: pn(ANA), id: "A1", fromMe: false } } }]);
    const tirar = await chamarCru(c, "wa_reagir", { conversa: ANA, mensagem: "A1", emoji: "" });
    assert.equal(tirar.isError, undefined);
    assert.equal((envios(s)[1]!.args[1] as { react: { text: string } }).react.text, "");
    const linhas = registro(m!).filter((l) => l.evento === "reacao");
    assert.equal(linhas.length, 2);
  });

  it("em grupo escolhido a chave leva o participante", async () => {
    const { s, c } = await cenario();
    assert.equal((await chamarCru(c, "wa_reagir", { conversa: GRUPO, mensagem: "G1", emoji: "❤️" })).isError, undefined);
    const chave = (envios(s)[0]!.args[1] as { react: { key: Record<string, unknown> } }).react.key;
    assert.equal(chave.participant, pn(BETO));
  });

  it("recusa mais de um emoji, texto, mensagem que não existe, grupo fora da lista e envio desligado", async () => {
    const { s, c } = await cenario();
    for (const [args, erro] of [
      [{ conversa: ANA, mensagem: "A1", emoji: "👍👍" }, /um emoji/],
      [{ conversa: ANA, mensagem: "A1", emoji: "ok" }, /um emoji/],
      [{ conversa: ANA, mensagem: "NAO", emoji: "👍" }, /Não achei essa mensagem/],
      [{ conversa: OUTRO_GRUPO, mensagem: "X", emoji: "👍" }, /wa_escolher_grupos/],
    ] as Array<[Record<string, unknown>, RegExp]>) {
      const r = await chamarCru(c, "wa_reagir", args);
      assert.equal(r.isError, true, JSON.stringify(args));
      assert.match(erroDe(r), erro);
    }
    (await m!.ctx.nucleo()).banco.definirEnvio(false);
    assert.match(erroDe(await chamarCru(c, "wa_reagir", { conversa: ANA, mensagem: "A1", emoji: "👍" })), /envio/);
    assert.equal(envios(s).length, 0);
  });

  it("teto por dia igual ao limite diário: uma injeção não dispara reações sem fim", async () => {
    const { c } = await cenario({ limiteDiario: 2 });
    for (let i = 0; i < 2; i++) assert.equal((await chamarCru(c, "wa_reagir", { conversa: ANA, mensagem: "A1", emoji: "👍" })).isError, undefined);
    const r = await chamarCru(c, "wa_reagir", { conversa: ANA, mensagem: "A1", emoji: "😂" });
    assert.equal(r.isError, true);
    assert.match(erroDe(r), /reações por dia/);
  });
});

describe("editar (wa_editar, com cartão de antes e depois)", () => {
  it("só mensagem de texto do dono, de até 15 minutos: recusa antes do pedido", async () => {
    const { c } = await cenario();
    const alheia = await chamarCru(c, "wa_editar", { conversa: ANA, mensagem: "A1", texto: "x" });
    assert.match(erroDe(alheia), /só .*mensagem sua|sua própria/i);
    assert.equal(alheia._meta, undefined);
    await fecharCliente!();
    fecharCliente = undefined;
    await m!.fechar();
    const velha = await cenario({ minhaTs: Date.now() - 16 * 60_000 });
    const r = await chamarCru(velha.c, "wa_editar", { conversa: ANA, mensagem: "A2", texto: "x" });
    assert.equal(r.isError, true);
    assert.match(erroDe(r), /15 minutos/);
    assert.equal(r._meta, undefined);
  });

  it("feliz: o cartão mostra o texto de agora e o novo (editável); o clique edita no WhatsApp e no banco", async () => {
    const { s, c } = await cenario();
    const previa = await chamarCru(c, "wa_editar", { conversa: ANA, mensagem: "A2", texto: "Chego às 9" });
    assert.equal(previa.isError, undefined, textoDe(previa));
    const p = previa._meta!.previa as Record<string, unknown>;
    assert.equal(p.tipo, "editar");
    assert.equal(p.texto, "Chego às 9");
    assert.ok(p.texto_editavel);
    assert.deepEqual(mensagemAtualParaMostrar(p)?.texto, "Chego às 8");
    const r = await clicar(c, previa, "Chego às 9h30");
    assert.equal(r.isError, undefined, textoDe(r));
    assert.deepEqual(envios(s)[0]!.args.slice(0, 2), [pn(ANA), { text: "Chego às 9h30", edit: { remoteJid: pn(ANA), id: "A2", fromMe: true } }]);
    const guardada = (await m!.ctx.nucleo()).banco.lerMensagens(pn(ANA)).find((x) => x.id === "A2")!;
    assert.equal(guardada.texto, "Chego às 9h30");
    assert.equal(guardada.editada, true);
  });

  it("confere os 15 minutos de novo na hora de executar", async () => {
    let agora = Date.now();
    const { s, c } = await cenario({ agora: () => agora, minhaTs: agora - 10 * 60_000 });
    const previa = await chamarCru(c, "wa_editar", { conversa: ANA, mensagem: "A2", texto: "Chego às 9" });
    assert.equal(previa.isError, undefined, textoDe(previa));
    agora += 6 * 60_000;
    const r = await clicar(c, previa, "Chego às 9");
    assert.equal(r.isError, true);
    assert.match(textoDe(r), /15 minutos/);
    assert.equal(envios(s).length, 0);
  });
});

describe("apagar (wa_apagar, para todos, com cartão)", () => {
  it("só mensagem do dono, de até 48 h; o cartão mostra o que vai sumir; o clique apaga no WhatsApp e no banco", async () => {
    const { s, c } = await cenario();
    assert.match(erroDe(await chamarCru(c, "wa_apagar", { conversa: ANA, mensagem: "A1" })), /só .*mensagem sua|sua própria/i);
    const previa = await chamarCru(c, "wa_apagar", { conversa: ANA, mensagem: "A2" });
    assert.equal(previa.isError, undefined, textoDe(previa));
    const p = previa._meta!.previa as Record<string, unknown>;
    assert.equal(p.tipo, "apagar");
    assert.equal(p.irreversivel, true);
    assert.equal(mensagemAtualParaMostrar(p)?.texto, "Chego às 8");
    assert.ok(mensagemAtualParaMostrar(p)?.data);
    const r = await clicar(c, previa);
    assert.equal(r.isError, undefined, textoDe(r));
    assert.deepEqual(envios(s)[0]!.args.slice(0, 2), [pn(ANA), { delete: { remoteJid: pn(ANA), id: "A2", fromMe: true } }]);
    assert.equal((await m!.ctx.nucleo()).banco.lerMensagens(pn(ANA)).some((x) => x.id === "A2"), false);
  });

  it("recusa mensagem com mais de 48 h", async () => {
    const { c } = await cenario({ minhaTs: Date.now() - 49 * 3_600_000 });
    const r = await chamarCru(c, "wa_apagar", { conversa: ANA, mensagem: "A2" });
    assert.equal(r.isError, true);
    assert.match(erroDe(r), /48 h/);
  });
});

describe("histórico antigo (wa_buscar_historico)", () => {
  const antiga = (id: string, jid: string, ts: number, extra: Partial<Parameters<typeof msg>[0]> = {}) => msg({ jid, id, texto: `antiga ${id}`, ts, ...extra });

  it("pede ao celular as anteriores à mais antiga guardada; guarda a resposta ON_DEMAND só da conversa pedida e passa pelos filtros", async () => {
    const { s, c } = await cenario({ ligar: false });
    const { banco } = await m!.ctx.nucleo();
    banco.bloquear(pn(BETO));
    const maisAntiga = banco.lerMensagens(pn(ANA))[0]!;
    s.aoPedirHistorico = () => {
      s.historicoSobDemanda([
        antiga("H1", pn(ANA), maisAntiga.ts - 3_000),
        antiga("H2", pn(ANA), maisAntiga.ts - 2_000),
        antiga("X1", pn("5511900001111"), maisAntiga.ts - 1_000), // outra conversa: não foi pedida
        antiga("X2", pn(BETO), maisAntiga.ts - 1_000), // lista "nunca ler"
        antiga("X3", OUTRO_GRUPO, maisAntiga.ts - 1_000, { participante: pn(BETO) }), // grupo não escolhido
      ]);
    };
    const r = await chamarCru(c, "wa_buscar_historico", { conversa: ANA, quantidade: 20 });
    assert.equal(r.isError, undefined, textoDe(r));
    const pedido = s.chamadas.find((x) => x.metodo === "fetchMessageHistory")!.args as [number, Record<string, unknown>, number];
    assert.equal(pedido[0], 20);
    assert.deepEqual(pedido[1], { remoteJid: pn(ANA), id: maisAntiga.id, fromMe: maisAntiga.de_mim });
    assert.equal(pedido[2], maisAntiga.ts);
    assert.equal(r.structuredContent!.novas, 2);
    assert.equal(r.structuredContent!.cortadas_pelo_teto, 0);
    assert.deepEqual(banco.lerMensagens(pn(ANA)).slice(0, 2).map((x) => x.id), ["H1", "H2"]);
    assert.equal(banco.lerMensagens(pn("5511900001111")).length, 0);
    assert.equal(banco.lerMensagens(OUTRO_GRUPO).length, 0);
    assert.ok(registro(m!).some((l) => l.evento === "historico_pedido"));
  });

  it("ON_DEMAND que ninguém pediu é ignorado; messages.upsert com requestId continua ignorado", async () => {
    const { s } = await cenario({ ligar: false });
    s.historicoSobDemanda([antiga("Z1", pn(ANA), Date.now() - 86_400_000)]);
    s.emitir("messages.upsert", { messages: [antiga("Z2", pn(ANA), Date.now() - 1000)], type: "notify", requestId: "R1" });
    await assentar(m!);
    const ids = (await m!.ctx.nucleo()).banco.lerMensagens(pn(ANA)).map((x) => x.id);
    assert.ok(!ids.includes("Z1") && !ids.includes("Z2"), ids.join(","));
  });

  it("sem resposta no tempo: diz que o celular pode estar sem internet", async () => {
    const { c } = await cenario({ ligar: false, esperaDoHistoricoMs: 50 });
    const r = await chamarCru(c, "wa_buscar_historico", { conversa: ANA, quantidade: 10 });
    assert.equal(r.isError, undefined, textoDe(r));
    assert.equal(r.structuredContent!.novas, 0);
    assert.match(String(r.structuredContent!.para_o_claude), /celular/);
  });

  it("o teto de mensagens por conversa corta e a resposta diz quantas", async () => {
    const { s, c } = await cenario({ ligar: false, maxMensagens: 3 });
    const { banco } = await m!.ctx.nucleo();
    const maisAntiga = banco.lerMensagens(pn(ANA))[0]!;
    s.aoPedirHistorico = () => s.historicoSobDemanda([1, 2, 3].map((i) => antiga(`H${i}`, pn(ANA), maisAntiga.ts - 10_000 + i)));
    const r = await chamarCru(c, "wa_buscar_historico", { conversa: ANA, quantidade: 3 });
    assert.equal(r.structuredContent!.novas, 1);
    assert.equal(r.structuredContent!.cortadas_pelo_teto, 2);
  });

  it("freio: um pedido por conversa a cada 30 s, até 30 por dia, quantidade até 50", async () => {
    const { c } = await cenario({ ligar: false, esperaDoHistoricoMs: 10 });
    assert.equal((await chamarCru(c, "wa_buscar_historico", { conversa: ANA, quantidade: 51 })).isError, true);
    assert.equal((await chamarCru(c, "wa_buscar_historico", { conversa: ANA, quantidade: 5 })).isError, undefined);
    const logo = await chamarCru(c, "wa_buscar_historico", { conversa: ANA, quantidade: 5 });
    assert.equal(logo.isError, true);
    assert.match(erroDe(logo), /30 s/);
    const { banco } = await m!.ctx.nucleo();
    for (let i = 0; i < 29; i++) banco.reservarContagens(Date.now(), [{ tipo: "historico", limite: 30, frase: "x" }]);
    const dia = await chamarCru(c, "wa_buscar_historico", { conversa: BETO, quantidade: 5 });
    assert.equal(dia.isError, true);
    assert.match(erroDe(dia), /30 pedidos de histórico por dia/);
  });
});

describe("preparar a parte 2 (mídia)", () => {
  it("a mídia recebida guarda url, chave, caminho e os hashes (cifrados no banco), e nada disso sai nas ferramentas de leitura", () => {
    const bruta = {
      key: { remoteJid: pn(ANA), id: "M1", fromMe: false },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: {
        imageMessage: {
          url: "https://mmg.whatsapp.net/v/t62/abc",
          directPath: "/v/t62/abc",
          mediaKey: Buffer.alloc(32, 7),
          fileSha256: Buffer.alloc(32, 1),
          fileEncSha256: Buffer.alloc(32, 2),
          mimetype: "image/jpeg",
          fileLength: 1234,
        },
      },
    } as unknown as WAMessage;
    const g = converterMensagem(bruta, { ts: Date.now(), grupo: false })!;
    assert.equal(g.midia!.url, "https://mmg.whatsapp.net/v/t62/abc");
    assert.equal(g.midia!.caminho, "/v/t62/abc");
    assert.equal(g.midia!.chave, Buffer.alloc(32, 7).toString("base64"));
    assert.equal(g.midia!.sha256, Buffer.alloc(32, 1).toString("base64"));
    assert.equal(g.midia!.sha256_cifrado, Buffer.alloc(32, 2).toString("base64"));
    const publica = JSON.stringify(mensagemPublica(g));
    for (const proibido of ["mmg.whatsapp.net", "/v/t62", Buffer.alloc(32, 7).toString("base64"), Buffer.alloc(32, 1).toString("base64")]) {
      assert.ok(!publica.includes(proibido), `${proibido} saiu na leitura`);
    }
  });
});

describe("instruções e escopo", () => {
  it("as instruções não dizem mais que enviar para grupo é proibido e falam das escritas novas", () => {
    assert.ok(!/enviar para grupo \(nunca\)/.test(INSTRUCOES));
    for (const nome of ["wa_iniciar_conversa", "wa_reagir", "wa_editar", "wa_apagar", "wa_buscar_historico"]) assert.match(INSTRUCOES, new RegExp(nome));
    assert.match(INSTRUCOES, /marcar como lida/);
  });
});
