// 0.11.0: o filtro por nome com emoji (wa_listar_conversas e wa_listar_grupos) e a paginação do wa_listar_grupos.
// O filtro compara o MESMO nome que a lista mostra (num grupo sem nome no índice, o do cache dos grupos) e tolera o
// emoji: no começo, no meio, nome só de emoji, emoji com ou sem seletor de variação, e letras "estilizadas".
// Sem rede, socket falso.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { nomeCasaComFiltro, type MensagemGuardada } from "../src/banco.ts";
import { LIMITE_CARACTERES } from "../src/respostas.ts";
import { assentar, chamar, chamarCru, conectar, conectarCliente, GRUPO, montar, OUTRO_GRUPO, type Montagem } from "./ajuda.ts";

type Obj = Record<string, unknown>;
let m: Montagem | undefined;
let fecharCliente: (() => Promise<void>) | undefined;
afterEach(async () => {
  await fecharCliente?.();
  fecharCliente = undefined;
  await m?.fechar();
  m = undefined;
});

const BASE = Math.floor((Date.now() - 3_600_000) / 1_000) * 1_000;
const msg = (id: string, i: number): MensagemGuardada => ({ id, ts: BASE + i * 1_000, de_mim: false, tipo: "texto", texto: "oi" });
const g = (n: number) => `1203630000000${String(n).padStart(5, "0")}@g.us`;

describe("0.11.0: filtro por nome com emoji (wa_listar_conversas)", () => {
  it("emoji no começo, no meio, nome só de emoji, variação do emoji e letras estilizadas", async () => {
    m = await montar();
    const { banco } = await m.ctx.nucleo();
    const nomes: Record<string, string> = {
      [GRUPO]: "🤖 IMPLEMENTAÇÃO GUIADA",
      [OUTRO_GRUPO]: "Família ❤️ Silva",
      [g(3)]: "🎉🎂",
      [g(4)]: "𝗣𝗥𝗢𝗝𝗘𝗧𝗢 𝗫",
    };
    let i = 0;
    for (const [jid, nome] of Object.entries(nomes)) {
      banco.permitirGrupo(jid);
      banco.definirNome(jid, nome, 3);
      banco.gravarMensagens(jid, [msg(`M${++i}`, i)]);
    }
    const { cliente, fechar } = await conectarCliente(m.ctx);
    fecharCliente = fechar;
    const achou = async (filtro: string) => ((await chamar(cliente, "wa_listar_conversas", { filtro })).conversas as Obj[]).map((c) => (c.conteudo_de_terceiros as { nome: string }).nome);
    assert.deepEqual(await achou("IMPLEMENTAÇÃO"), [nomes[GRUPO]]);
    assert.deepEqual(await achou("implementacao guiada"), [nomes[GRUPO]], "sem acento e sem o emoji");
    assert.deepEqual(await achou("🤖 IMPLEMENTAÇÃO GUIADA"), [nomes[GRUPO]], "o nome inteiro, com o emoji do começo");
    assert.deepEqual(await achou("🤖IMPLEMENTAÇÃO"), [nomes[GRUPO]], "emoji colado");
    assert.deepEqual(await achou("🤖"), [nomes[GRUPO]], "só o emoji");
    assert.deepEqual(await achou("família ❤ silva"), [nomes[OUTRO_GRUPO]], "emoji no meio, sem o seletor de variação");
    assert.deepEqual(await achou("familia silva"), [nomes[OUTRO_GRUPO]], "sem o emoji do meio");
    assert.deepEqual(await achou("🎉🎂"), [nomes[g(3)]], "nome só de emoji");
    assert.deepEqual(await achou("🎂"), [nomes[g(3)]]);
    assert.deepEqual(await achou("projeto x"), [nomes[g(4)]], "letras estilizadas (negrito matemático)");
    assert.deepEqual(await achou("nada disso"), []);
  });

  it("grupo com o nome só no cache dos grupos (a lista mostra esse nome) também é achado pelo filtro", async () => {
    m = await montar();
    const { banco } = await m.ctx.nucleo();
    banco.permitirGrupo(GRUPO);
    banco.gravarMensagens(GRUPO, [msg("G1", 1)]);
    banco.guardarCacheDeGrupos({ em: Date.now(), grupos: { [GRUPO]: { nome: "🤖 IMPLEMENTAÇÃO GUIADA", participantes: 9 } } });
    assert.equal(banco.entrada(GRUPO)!.nome, undefined, "sem nome no índice");
    const { cliente, fechar } = await conectarCliente(m.ctx);
    fecharCliente = fechar;
    const todas = (await chamar(cliente, "wa_listar_conversas", {})).conversas as Obj[];
    assert.equal((todas[0]!.conteudo_de_terceiros as { nome: string }).nome, "🤖 IMPLEMENTAÇÃO GUIADA", "a lista mostra o do cache");
    const filtradas = (await chamar(cliente, "wa_listar_conversas", { filtro: "implementação" })).conversas as Obj[];
    assert.equal(filtradas.length, 1);
  });

  it("nomeCasaComFiltro: casos de borda", () => {
    assert.equal(nomeCasaComFiltro("Ana Paula", "ana"), true);
    assert.equal(nomeCasaComFiltro("Ana Paula", "  ANA   paula "), true);
    assert.equal(nomeCasaComFiltro("Ana Paula", "beto"), false);
    assert.equal(nomeCasaComFiltro("", "🤖"), false);
    assert.equal(nomeCasaComFiltro("👨‍👩‍👧 Casa", "👨👩👧"), true, "família sem o juntador do emoji");
    assert.equal(nomeCasaComFiltro("Time ⚽", "⚽️"), true, "com o seletor de variação a mais");
  });
});

describe("0.11.0: wa_listar_grupos paginado e com teto de tamanho", () => {
  async function comGrupos(n: number, nome: (i: number) => string, escolhidos = 0) {
    m = await montar();
    const { banco } = await m.ctx.nucleo();
    for (let i = 1; i <= escolhidos; i++) banco.permitirGrupo(g(i));
    const grupos = Object.fromEntries(Array.from({ length: n }, (_, k) => [g(k + 1), { id: g(k + 1), subject: nome(k + 1), size: 5, participants: [] }]));
    await conectar(m, { grupos });
    await assentar(m);
    const { cliente, fechar } = await conectarCliente(m.ctx);
    fecharCliente = fechar;
    return cliente;
  }

  it("sem filtro: 30 por página, total, proximo e cursor até o fim; os campos de antes continuam", async () => {
    const c = await comGrupos(75, (i) => `Grupo ${String(i).padStart(3, "0")}`, 2);
    const p1 = await chamar(c, "wa_listar_grupos", {});
    assert.equal((p1.grupos as Obj[]).length, 30);
    assert.equal(p1.total, 75);
    assert.equal(p1.proximo, "30");
    assert.equal(p1.escolhidos, 2);
    assert.equal(typeof p1.atualizada_em, "string");
    // Os escolhidos primeiro.
    assert.deepEqual((p1.grupos as Obj[]).slice(0, 3).map((x) => x.escolhido), [true, true, false]);
    const p2 = await chamar(c, "wa_listar_grupos", { cursor: "30" });
    const p3 = await chamar(c, "wa_listar_grupos", { cursor: String(p2.proximo) });
    assert.equal((p3.grupos as Obj[]).length, 15);
    assert.equal(p3.proximo, null);
    const ids = [p1, p2, p3].flatMap((p) => (p.grupos as Obj[]).map((x) => x.id));
    assert.equal(new Set(ids).size, 75, "nenhum repetido nem perdido entre as páginas");
    assert.match(String(p1.para_o_claude), /proximo/);
    const limitada = await chamar(c, "wa_listar_grupos", { limite: 5 });
    assert.equal((limitada.grupos as Obj[]).length, 5);
  });

  it("com filtro: quem chamava com filtro recebe os achados (até 100 por página), com total e proximo", async () => {
    const c = await comGrupos(150, (i) => (i % 3 === 0 ? `🏫 Escola ${i}` : `Outro ${i}`));
    const r = await chamar(c, "wa_listar_grupos", { filtro: "escola" });
    assert.equal(r.total, 50);
    assert.equal((r.grupos as Obj[]).length, 50);
    assert.equal(r.proximo, null);
    const comEmoji = await chamar(c, "wa_listar_grupos", { filtro: "🏫" });
    assert.equal(comEmoji.total, 50);
  });

  it("muitos grupos com nome longo: a página cabe no teto (25 mil caracteres) e diz que foi reduzida", async () => {
    const c = await comGrupos(100, (i) => `${"Nome muito comprido de grupo com bastante texto ".repeat(2).slice(0, 96)}${String(i).padStart(4, "0")}`);
    const r = await chamarCru(c, "wa_listar_grupos", { limite: 100 });
    assert.ok(r.content[0]!.text!.length <= LIMITE_CARACTERES, `tamanho ${r.content[0]!.text!.length}`);
    const sc = r.structuredContent!;
    assert.ok((sc.grupos as Obj[]).length < 100);
    assert.equal(typeof sc.aviso_de_tamanho, "string");
    assert.equal(sc.proximo, String((sc.grupos as Obj[]).length));
    assert.equal(sc.total, 100);
  });
});

