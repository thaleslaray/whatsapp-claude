// 0.9.0: triagem sem IA no wa_listar_conversas (triagem.ts): tipo da última, `encerramento_provavel` (pista),
// `novas_desde_a_marca`, `resumida_ate`, `marca`, os três filtros novos e o cache por carimbo do arquivo.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { Banco, type MensagemGuardada } from "../src/banco.ts";
import { CofreEmMemoria } from "../src/cofre.ts";
import { ehMensagemDeFecho, resumirConversa } from "../src/triagem.ts";
import { ANA, BETO, CHAVE_TESTE, GRUPO, chamar, conectarCliente, montar, pn, type Montagem } from "./ajuda.ts";

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

const BASE = Date.now() - 3_600_000;
const MIN = 60_000;
function mg(id: string, texto: string | undefined, ts: number, o: Partial<MensagemGuardada> = {}): MensagemGuardada {
  return { id, ts, de_mim: false, tipo: "texto", ...(texto !== undefined ? { texto } : {}), ...o };
}
const txt = (texto: string): Pick<MensagemGuardada, "tipo" | "texto"> => ({ tipo: "texto", texto });

describe("0.9.0: mensagem de fecho (função pura)", () => {
  it("figurinha é fecho", () => {
    assert.equal(ehMensagemDeFecho({ tipo: "figurinha", midia: { baixavel: false } }), true);
  });

  it("só emoji (sem mídia) é fecho; com mídia, não", () => {
    for (const t of ["👍", "🙏🏽", "❤️", "👍👍 !", "😂😂😂", "🇧🇷"]) assert.equal(ehMensagemDeFecho(txt(t)), true, t);
    assert.equal(ehMensagemDeFecho({ tipo: "imagem", texto: "👍", midia: { baixavel: false } }), false, "imagem com legenda de emoji");
    assert.equal(ehMensagemDeFecho({ tipo: "texto", texto: "👍", midia: { baixavel: false } }), false, "texto com mídia");
  });

  it("texto curto só com palavras de fecho ou risada é fecho", () => {
    for (const t of ["ok", "Valeu!", "valeu, obrigado", "Obrigada 🙏", "blz", "Pode deixar", "de nada", "Até mais", "kkkkk", "hahaha", "rsrs", "Show, top!", "fechou", "Combinado.", "ótimo", "Amém", "abraço", "beijos", "tmj"]) {
      assert.equal(ehMensagemDeFecho(txt(t)), true, t);
    }
  });

  it("pergunta, sim/não, saudação, número, texto longo ou palavra fora do vocabulário não são fecho", () => {
    for (const t of ["ok?", "?", "valeu, mas e o contrato?", "sim", "não", "bom dia", "oi", "ok 10", "123", "beleza beleza beleza obrigado", "ok, amanhã te ligo", "vou ver", ""]) {
      assert.equal(ehMensagemDeFecho(txt(t)), false, JSON.stringify(t));
    }
    assert.equal(ehMensagemDeFecho(txt("valeu valeu valeu valeu valeu")), false, "mais de 25 caracteres");
  });

  it("0.9.1: letra repetida e as palavras novas (casos do acervo real); saudação continua fora", () => {
    for (const t of ["Valeuu, bom finde 😎", "ataa", "Obrigadoo!", "tá bom", "ah tá", "bom fds", "boa semana", "tamo junto", "kkkkk", "blzz", "isso", "flw"]) {
      assert.equal(ehMensagemDeFecho(txt(t)), true, t);
    }
    for (const t of ["bom dia", "boa noite", "boa tarde", "tá?", "ta bom, e o contrato", "bom 10", "olá", "oii"]) {
      assert.equal(ehMensagemDeFecho(txt(t)), false, t);
    }
  });

  it("áudio, nota de voz e documento não são fecho", () => {
    for (const tipo of ["audio", "nota_de_voz", "documento", "imagem", "video"] as const) assert.equal(ehMensagemDeFecho({ tipo, midia: { baixavel: false } }), false, tipo);
  });

  it("encerramento: todas as recebidas depois da última do dono são fecho, no máximo 5", () => {
    const meu = mg("m", "segue o contrato", BASE, { de_mim: true });
    assert.equal(resumirConversa([meu, mg("a", "valeu", BASE + 1), mg("b", undefined, BASE + 2, { tipo: "figurinha" })]).encerramento_provavel, true);
    assert.equal(resumirConversa([meu, mg("a", "valeu", BASE + 1), mg("b", "e o preço?", BASE + 2)]).encerramento_provavel, false);
    assert.equal(resumirConversa([meu, ...Array.from({ length: 5 }, (_, i) => mg(`k${i}`, "kkk", BASE + i + 1))]).encerramento_provavel, true, "5: ainda é fecho");
    assert.equal(resumirConversa([meu, ...Array.from({ length: 6 }, (_, i) => mg(`k${i}`, "kkk", BASE + i + 1))]).encerramento_provavel, false, "6: já não é");
    assert.equal(resumirConversa([mg("a", "valeu", BASE), meu]).encerramento_provavel, false, "a última é do dono");
    assert.equal(resumirConversa([mg("a", "preciso de ajuda", BASE - 5), meu, mg("b", "ok", BASE + 1)]).encerramento_provavel, true, "só conta o que veio depois do dono");
    assert.equal(resumirConversa([]).encerramento_provavel, false);
  });
});

/**
 * Ana: pedi, ela agradeceu com "valeu" e figurinha (encerramento provável). Beto: pergunta sem resposta. Carla: a última
 * é minha. Grupo: mensagens de outros.
 */
const CARLA = "5531977776666";
async function cenario(): Promise<{ c: Cliente; banco: Banco }> {
  m = await montar();
  const { banco } = await m.ctx.nucleo();
  banco.gravarMensagens(pn(ANA), [mg("A1", "me manda o contrato", BASE), mg("A2", "segue", BASE + MIN, { de_mim: true }), mg("A3", "valeu!", BASE + 2 * MIN), mg("A4", undefined, BASE + 3 * MIN, { tipo: "figurinha", midia: { baixavel: false } })]);
  banco.gravarMensagens(pn(BETO), [mg("B1", "oi", BASE), mg("B2", "você vem amanhã?", BASE + 4 * MIN)]);
  banco.gravarMensagens(pn(CARLA), [mg("C1", "tudo certo?", BASE), mg("C2", "tudo!", BASE + 5 * MIN, { de_mim: true })]);
  banco.permitirGrupo(GRUPO);
  banco.gravarMensagens(GRUPO, [mg("G1", "bom dia", BASE + 6 * MIN, { remetente: { nome: "Ana", numero: ANA } })]);
  const { cliente, fechar } = await conectarCliente(m.ctx);
  fecharCliente = fechar;
  return { c: cliente, banco };
}

const listar = (c: Cliente, args: Obj = {}) => chamar(c, "wa_listar_conversas", args);
const conversas = (r: Obj) => r.conversas as Obj[];
const nomes = async (c: Cliente, banco: Banco, args: Obj = {}) => {
  const ids = new Map([pn(ANA), pn(BETO), pn(CARLA), GRUPO].map((j, i) => [banco.idPublico(j), ["ana", "beto", "carla", "grupo"][i]!]));
  return conversas(await listar(c, args)).map((x) => ids.get(String(x.id)));
};

describe("0.9.0: wa_listar_conversas com a triagem", () => {
  it("tipo da última, encerramento_provavel só onde cabe, marca e novas_desde_a_marca; a pista vai no para_o_claude", async () => {
    const { c, banco } = await cenario();
    const r = await listar(c);
    const por = (jid: string) => conversas(r).find((x) => x.id === banco.idPublico(jid))!;
    assert.equal((por(pn(ANA)).ultima as Obj).tipo, "figurinha");
    assert.equal((por(pn(BETO)).ultima as Obj).tipo, "texto");
    assert.equal(por(pn(ANA)).encerramento_provavel, true);
    assert.equal(por(pn(BETO)).encerramento_provavel, undefined);
    assert.equal(por(pn(CARLA)).encerramento_provavel, undefined, "a última é minha");
    assert.equal(por(GRUPO).encerramento_provavel, undefined, "grupo não entra");
    assert.equal(por(pn(ANA)).marca, String(BASE + 3 * MIN));
    assert.equal(por(pn(ANA)).novas_desde_a_marca, 3, "nunca marcada: todas as recebidas");
    assert.equal(por(pn(ANA)).resumida_ate, undefined);
    assert.match(String(r.para_o_claude), /só uma pista/);
    // Os campos de sempre continuam.
    for (const campo of ["id", "ultima", "nao_lidas", "guardadas"]) assert.ok(campo in por(pn(ANA)), campo);
    assert.ok("esperando_resposta_desde" in por(pn(ANA)));
  });

  it("novas_desde_a_marca antes e depois de marcar (individual), com a marca da própria lista", async () => {
    const { c, banco } = await cenario();
    const antes = conversas(await listar(c)).find((x) => x.id === banco.idPublico(pn(BETO)))!;
    assert.equal(antes.novas_desde_a_marca, 2);
    await chamar(c, "wa_marcar_resumo", { conversas: [{ conversa: String(antes.id), marca: String(antes.marca) }] });
    const depois = conversas(await listar(c)).find((x) => x.id === banco.idPublico(pn(BETO)))!;
    assert.equal(depois.novas_desde_a_marca, 0);
    assert.equal(depois.resumida_ate, new Date(BASE + 4 * MIN).toISOString());
    banco.gravarMensagens(pn(BETO), [mg("B3", "e aí?", BASE + 10 * MIN)]);
    const nova = conversas(await listar(c)).find((x) => x.id === banco.idPublico(pn(BETO)))!;
    assert.equal(nova.novas_desde_a_marca, 1);
    // A marca da lista é a mesma do wa_ler_conversa com desde_o_ultimo_resumo.
    const lida = await chamar(c, "wa_ler_conversa", { conversa: pn(BETO), desde_o_ultimo_resumo: true });
    assert.equal(lida.marca, nova.marca);
  });

  it("os três filtros, sozinhos e combinados; total conta depois dos filtros", async () => {
    const { c, banco } = await cenario();
    assert.deepEqual(await nomes(c, banco, { esperando_resposta: true }), ["beto", "ana"]);
    assert.deepEqual(await nomes(c, banco, { sem_encerramento: true }), ["grupo", "carla", "beto"]);
    assert.deepEqual(await nomes(c, banco, { esperando_resposta: true, sem_encerramento: true }), ["beto"]);
    const r = await listar(c, { esperando_resposta: true, sem_encerramento: true });
    assert.equal(r.total, 1);
    // Marca a Ana e o grupo: com_novidades tira os dois.
    await chamar(c, "wa_marcar_resumo", { conversas: [{ conversa: banco.idPublico(pn(ANA)), marca: String(BASE + 3 * MIN) }, { conversa: banco.idPublico(GRUPO), marca: String(BASE + 6 * MIN) }] });
    assert.deepEqual(await nomes(c, banco, { com_novidades: true }), ["carla", "beto"]);
    assert.deepEqual(await nomes(c, banco, { com_novidades: true, esperando_resposta: true }), ["beto"]);
    assert.deepEqual(await nomes(c, banco, { com_novidades: true, filtro: "nada-assim" }), []);
    // Com filtro e desde_horas.
    assert.deepEqual(await nomes(c, banco, { esperando_resposta: true, desde_horas: 24 }), ["beto", "ana"]);
    const vazio = await listar(c, { esperando_resposta: true, sem_encerramento: true, com_novidades: true, filtro: "x" });
    assert.equal(vazio.total, 0);
    assert.match(String(vazio.para_o_claude), /Nenhuma conversa/);
  });

  it("cache invalidado por mensagem nova e por mudança de OUTRA instância do banco na mesma pasta", async () => {
    const { c, banco } = await cenario();
    const ana = async () => conversas(await listar(c)).find((x) => x.id === banco.idPublico(pn(ANA)))!;
    assert.equal((await ana()).encerramento_provavel, true);
    banco.gravarMensagens(pn(ANA), [mg("A5", "e o boleto?", BASE + 7 * MIN)]);
    assert.equal((await ana()).encerramento_provavel, undefined, "mensagem nova pelo mesmo banco");
    assert.equal(((await ana()).ultima as Obj).tipo, "texto");
    const outro = new Banco({ dir: m!.config.dirDados, chave: await new CofreEmMemoria(CHAVE_TESTE).obterChave() });
    outro.gravarMensagens(pn(ANA), [mg("A6", "boleto pago", BASE + 8 * MIN, { de_mim: true }), mg("A7", "obrigado", BASE + 9 * MIN)]);
    const depois = await ana();
    assert.equal(depois.encerramento_provavel, true, "o que a outra instância gravou aparece");
    assert.equal(depois.novas_desde_a_marca, 5);
  });

  it("a triagem não guarda texto no cache", async () => {
    const { c } = await cenario();
    await listar(c);
    // O resumo exposto pela triagem tem só datas, tipo e o veredito.
    const { banco } = await m!.ctx.nucleo();
    const r = m!.ctx.triagem.daConversa(banco, pn(ANA));
    assert.deepEqual(Object.keys(r).sort(), ["encerramento_provavel", "recebidas", "ultima_ts", "ultimo_tipo"]);
    assert.ok(!JSON.stringify(r).includes("valeu"));
  });
});
