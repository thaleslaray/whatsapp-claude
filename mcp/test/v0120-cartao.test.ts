// 0.12.0: o cartão ensina. Confirmado e enviado, o par (rascunho da IA, texto enviado) vai para o aprendizado e a
// mensagem guardada leva a marca `rascunho_da_ia`; sem edição, só a marca e a medida; cancelado ou vencido, só a
// contagem. Vale para wa_responder, wa_iniciar_conversa e a legenda do wa_enviar_arquivo. Socket falso, sem rede.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { Banco } from "../src/banco.ts";
import { ANA, assentar, chamar, chamarCru, clicar, conectar, conectarCliente, ligarEnvio, montar, pedidoDa, pn, textoDe, type Montagem } from "./ajuda.ts";
import { msg } from "./socket-falso.ts";

type Cliente = Awaited<ReturnType<typeof conectarCliente>>["cliente"];
type Obj = Record<string, unknown>;

let m: Montagem | undefined;
let fecharCliente: (() => Promise<void>) | undefined;
afterEach(async () => {
  await fecharCliente?.();
  fecharCliente = undefined;
  await m?.fechar();
  m = undefined;
});

const NOVO = "5531999990000";
let agora = Date.now();

async function cenario(): Promise<{ c: Cliente; banco: Banco }> {
  agora = Date.now();
  m = await montar({ agora: () => agora });
  const s = await conectar(m);
  s.mensagens([msg({ jid: pn(ANA), id: "A1", texto: "Oi, me manda o contrato?", nome: "Ana", ts: agora - 60_000 })]);
  await assentar(m);
  const { cliente, fechar } = await conectarCliente(m.ctx);
  fecharCliente = fechar;
  await ligarEnvio(cliente);
  return { c: cliente, banco: (await m.ctx.nucleo()).banco };
}

const ultimaMinha = (banco: Banco, jid = pn(ANA)) => banco.lerMensagens(jid).filter((x) => x.de_mim).at(-1)!;

describe("0.12.0: o par guardado no cartão", () => {
  it("wa_responder editado no cartão: par guardado, mensagem marcada `editado`, wa_ler_conversa mostra; entra na medida", async () => {
    const { c, banco } = await cenario();
    const previa = await chamarCru(c, "wa_responder", { conversa: ANA, texto: "Olá Ana, segue o contrato em anexo 😊" });
    assert.equal((previa._meta!.previa as Obj).texto, "Olá Ana, segue o contrato em anexo 😊", "a prévia do cartão não muda");
    const r = await clicar(c, previa, "segue o contrato");
    assert.equal(r.isError, undefined, textoDe(r));
    const id = (r.structuredContent!.resultado as Obj).mensagem_id as string;
    const minha = ultimaMinha(banco);
    assert.equal(minha.id, id);
    assert.equal(minha.texto, "segue o contrato");
    assert.equal(minha.rascunho_da_ia, "editado");
    const [e] = banco.edicoes();
    assert.equal(e!.mensagem_id, id);
    assert.equal(e!.ferramenta, "wa_responder");
    assert.equal(e!.rascunho, "Olá Ana, segue o contrato em anexo 😊");
    assert.equal(e!.enviado, "segue o contrato");
    assert.equal(e!.resumo.saudacao, "tirou");
    assert.equal(e!.resumo.emoji.mudou, "tirou");
    const lida = await chamar(c, "wa_ler_conversa", { conversa: ANA });
    assert.equal((lida.mensagens as Obj[]).at(-1)!.rascunho_da_ia, "editado");
    const jeito = await chamar(c, "wa_meu_jeito", { conversa: ANA });
    assert.equal((jeito.perfil as Obj).mensagens_medidas, 1, "o texto final é do dono: entra");
  });

  it("sem edição: só a marca `sem_edicao` e a medida (sem texto guardado); fica fora da medida; cancelado e vencido só contam", async () => {
    const { c, banco } = await cenario();
    const r = await clicar(c, await chamarCru(c, "wa_responder", { conversa: ANA, texto: "Chego às 8, combinado" }));
    assert.equal(r.isError, undefined, textoDe(r));
    assert.equal(ultimaMinha(banco).rascunho_da_ia, "sem_edicao");
    assert.equal(banco.edicoes().length, 0);
    const { envios } = banco.enviosDeRascunho();
    assert.deepEqual(envios.map((x) => [x.marca, x.distancia]), [["sem_edicao", 0]]);
    assert.equal(((await chamar(c, "wa_meu_jeito", { conversa: ANA })).perfil as Obj).mensagens_medidas, 0, "a IA não aprende com ela mesma");
    // Edição mínima (só a pontuação final): marca própria, sem par.
    await clicar(c, await chamarCru(c, "wa_responder", { conversa: ANA, texto: "Até amanhã." }), "Até amanhã");
    assert.equal(ultimaMinha(banco).rascunho_da_ia, "edicao_minima");
    assert.equal(banco.edicoes().length, 0);
    // Cancelado: só a contagem.
    const cancelar = await chamarCru(c, "wa_responder", { conversa: ANA, texto: "TEXTO CANCELADO QUE NÃO PODE FICAR" });
    await chamarCru(c, "wa_cancelar_pedido", { id: pedidoDa(cancelar).id });
    // Vencido: 10 minutos depois, o clique encontra o pedido vencido.
    const vencer = await chamarCru(c, "wa_responder", { conversa: ANA, texto: "TEXTO VENCIDO QUE NÃO PODE FICAR" });
    agora += 11 * 60_000;
    assert.equal((await clicar(c, vencer)).isError, true);
    const depois = banco.enviosDeRascunho();
    assert.deepEqual(depois.desistencias, { cancelados: 1, expirados: 1 });
    assert.equal(depois.envios.length, 2);
    assert.ok(!JSON.stringify([banco.edicoes(), banco.regras(), depois]).includes("NÃO PODE FICAR"));
    const est = (await chamar(c, "wa_edicoes_dos_rascunhos")).estatisticas as Obj;
    assert.deepEqual(est, { rascunhos_enviados: 2, aceitos_sem_edicao: 1, com_edicao_minima: 1, editados: 0, cancelados: 1, vencidos: 1, edicao_mediana_ultimos_20: 0.25, edicao_mediana_20_anteriores: null }, "distâncias 0 e 0,5 (1 de 2 palavras)");
  });

  it("wa_iniciar_conversa e a legenda do wa_enviar_arquivo também ensinam; legenda escrita só pelo dono não é rascunho", async () => {
    const { c, banco } = await cenario();
    const nova = await chamarCru(c, "wa_iniciar_conversa", { numero: `+${NOVO}`, texto: "Prezado, tudo bem? Aqui é do escritório." });
    assert.equal((await clicar(c, nova, "oi! aqui é do escritório")).isError, undefined);
    assert.equal(ultimaMinha(banco, pn(NOVO)).rascunho_da_ia, "editado");
    assert.equal(banco.edicoes().at(-1)!.ferramenta, "wa_iniciar_conversa");

    const pasta = join(m!.dir, "Documents", "meus"); // 0.16.0: só das pastas permitidas
    mkdirSync(pasta, { recursive: true });
    const arquivo = join(pasta, "contrato.pdf");
    writeFileSync(arquivo, "%PDF-1.4 conteudo");
    const comLegenda = await chamarCru(c, "wa_enviar_arquivo", { conversa: ANA, arquivo, legenda: "Prezada Ana, segue o contrato para assinatura." });
    const r = await clicar(c, comLegenda, "segue pra assinar");
    assert.equal(r.isError, undefined, textoDe(r));
    const minha = ultimaMinha(banco);
    assert.equal(minha.tipo, "documento");
    assert.equal(minha.rascunho_da_ia, "editado");
    const e = banco.edicoes().at(-1)!;
    assert.equal(e.ferramenta, "wa_enviar_arquivo");
    assert.equal(e.enviado, "segue pra assinar");
    // A IA não propôs legenda; o dono escreveu uma no cartão: é dele, sem marca e sem par.
    const antes = banco.enviosDeRascunho().envios.length;
    const semLegenda = await chamarCru(c, "wa_enviar_arquivo", { conversa: ANA, arquivo });
    assert.equal((await clicar(c, semLegenda, "a legenda é minha")).isError, undefined);
    assert.equal(ultimaMinha(banco).rascunho_da_ia, undefined);
    assert.equal(banco.enviosDeRascunho().envios.length, antes);
  });

  it("mensagem do dono apagada para todos leva a edição ligada a ela", async () => {
    const { c, banco } = await cenario();
    const r = await clicar(c, await chamarCru(c, "wa_responder", { conversa: ANA, texto: "Olá Ana, segue o contrato" }), "segue o contrato");
    const id = (r.structuredContent!.resultado as Obj).mensagem_id as string;
    assert.equal(banco.edicoes().length, 1);
    assert.equal(banco.apagarMensagem(pn(ANA), id, { de_mim: true }), true);
    assert.equal(banco.edicoes().length, 0);
  });
});
