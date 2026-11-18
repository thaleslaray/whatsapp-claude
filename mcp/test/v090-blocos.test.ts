// 0.9.0: blocos de conversa na busca (blocos.ts e busca.ts), o `em_volta_de` que abre o bloco, o índice esquecido na
// hora quando este processo apaga, e a varredura que só roda quando pode achar algo. Rede bloqueada, socket falso.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { MensagemGuardada } from "../src/banco.ts";
import { dividirEmBlocos, MAXIMO_DE_CARACTERES_POR_BLOCO, SILENCIO_ENTRE_BLOCOS_MS } from "../src/blocos.ts";
import { carregarSqlite, varreduraNaoAchaMais, type CarregarSqlite } from "../src/busca.ts";
import { ANA, BETO, GRUPO, chamar, conectarCliente, montar, pn, type Montagem, type OpcoesMontagem } from "./ajuda.ts";

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

const BASE = new Date(2026, 9, 10, 12, 0, 0).getTime();
const MIN = 60_000;
const DIA = 86_400_000;
function mg(id: string, texto: string | undefined, ts: number, o: Partial<MensagemGuardada> = {}): MensagemGuardada {
  return { id, ts, de_mim: false, tipo: "texto", ...(texto !== undefined ? { texto } : {}), ...o };
}
const figurinha = (id: string, ts: number) => mg(id, undefined, ts, { tipo: "figurinha", midia: { baixavel: false, mimetype: "image/webp" } });

const NEGADO = () => {
  throw new Error("node:sqlite negado neste teste");
};

describe("0.9.0: dividirEmBlocos (função pura)", () => {
  const em = (minutos: number[]) => minutos.map((x, i) => mg(`M${i}`, `t${i}`, BASE + x * MIN));

  it("15 minutos exatos ficam no mesmo bloco; 1 ms a mais abre outro", () => {
    assert.deepEqual(dividirEmBlocos([mg("a", "x", BASE), mg("b", "y", BASE + SILENCIO_ENTRE_BLOCOS_MS)]), [{ inicio: 0, fim: 1 }]);
    assert.deepEqual(dividirEmBlocos([mg("a", "x", BASE), mg("b", "y", BASE + SILENCIO_ENTRE_BLOCOS_MS + 1)]), [{ inicio: 0, fim: 0 }, { inicio: 1, fim: 1 }]);
    assert.deepEqual(dividirEmBlocos(em([0, 10, 20, 50, 51])), [{ inicio: 0, fim: 2 }, { inicio: 3, fim: 4 }], "o silêncio conta entre uma e a próxima, não desde a primeira");
    assert.deepEqual(dividirEmBlocos([]), []);
  });

  it("mais de 20 mensagens: divide em sequência, sem sobreposição", () => {
    const blocos = dividirEmBlocos(em(Array.from({ length: 45 }, (_, i) => i)));
    assert.deepEqual(blocos, [{ inicio: 0, fim: 19 }, { inicio: 20, fim: 39 }, { inicio: 40, fim: 44 }]);
    assert.deepEqual(dividirEmBlocos(em(Array.from({ length: 45 }, (_, i) => i)), { porTamanho: false }), [{ inicio: 0, fim: 44 }], "só pelo silêncio (em_volta_de)");
  });

  it("mais de 2.000 caracteres: divide; mensagem sozinha maior que o limite fica num bloco só dela", () => {
    const grande = "x".repeat(900);
    const tres = [mg("a", grande, BASE), mg("b", grande, BASE + MIN), mg("c", grande, BASE + 2 * MIN)];
    assert.deepEqual(dividirEmBlocos(tres), [{ inicio: 0, fim: 1 }, { inicio: 2, fim: 2 }]);
    const enorme = [mg("a", "oi", BASE), mg("b", "y".repeat(MAXIMO_DE_CARACTERES_POR_BLOCO + 1), BASE + MIN), mg("c", "oi", BASE + 2 * MIN)];
    assert.deepEqual(dividirEmBlocos(enorme), [{ inicio: 0, fim: 0 }, { inicio: 1, fim: 1 }, { inicio: 2, fim: 2 }]);
    // Transcrição e nome de arquivo contam como texto.
    const comTranscricao = [mg("a", grande, BASE), mg("b", undefined, BASE + MIN, { tipo: "nota_de_voz", transcricao: { texto: "z".repeat(1200), idioma: "pt", em: BASE } })];
    assert.equal(dividirEmBlocos(comTranscricao).length, 2);
  });

  it("mensagem sem texto no meio entra no bloco e conta como mensagem (não como caractere)", () => {
    const lista = [mg("a", "oi", BASE), figurinha("f", BASE + MIN), mg("b", "tudo?", BASE + 2 * MIN)];
    assert.deepEqual(dividirEmBlocos(lista), [{ inicio: 0, fim: 2 }]);
    // 19 com texto + 1 figurinha = 20: a 21ª abre outro bloco.
    const vinte = [...Array.from({ length: 19 }, (_, i) => mg(`t${i}`, "x", BASE + i * MIN)), figurinha("f", BASE + 19 * MIN), mg("u", "y", BASE + 20 * MIN)];
    assert.deepEqual(dividirEmBlocos(vinte), [{ inicio: 0, fim: 19 }, { inicio: 20, fim: 20 }]);
  });
});

/**
 * Ana: A9 (contrato e amanhã na mesma mensagem, 10 dias atrás); A1+A2 (contrato e amanhã em mensagens seguidas, mesmo
 * bloco); A3 e A4 (contrato e amanhã em blocos diferentes, 30 min); A5..A8 (pizza três vezes e uma figurinha, um bloco).
 * Beto: B1 e B2 (pizza, dias diferentes).
 */
async function cenario(opcoes: OpcoesMontagem = {}): Promise<Cliente> {
  m = await montar(opcoes);
  const { banco } = await m.ctx.nucleo();
  banco.gravarMensagens(pn(ANA), [
    mg("A9", "o contrato fica pra amanhã", BASE - 10 * DIA),
    mg("A1", "te mando o contrato", BASE - 5 * DIA),
    mg("A2", "amanhã cedo", BASE - 5 * DIA + 2 * MIN),
    mg("A3", "contrato assinado", BASE - 4 * DIA),
    mg("A4", "amanhã eu vejo", BASE - 4 * DIA + 30 * MIN),
    mg("A5", "pizza hoje", BASE - 2 * DIA),
    mg("A6", "pizza amanhã?", BASE - 2 * DIA + MIN, { de_mim: true }),
    mg("A7", "sem pizza", BASE - 2 * DIA + 2 * MIN),
    figurinha("A8", BASE - 2 * DIA + 3 * MIN),
  ]);
  banco.gravarMensagens(pn(BETO), [mg("B1", "pizza", BASE - 3 * DIA), mg("B2", "pizza de novo", BASE - DIA)]);
  const { cliente, fechar } = await conectarCliente(m.ctx);
  fecharCliente = fechar;
  return cliente;
}

const buscar = (c: Cliente, args: Obj) => chamar(c, "wa_buscar", args);
const res = (r: Obj) => r.resultados as Obj[];
const ids = (r: Obj) => res(r).map((x) => x.mensagem_id);

describe("0.9.0: wa_buscar junta por bloco", () => {
  it("achado espalhado em duas mensagens do mesmo bloco aparece; em blocos diferentes, não", async () => {
    const c = await cenario();
    const r = await buscar(c, { texto: "contrato amanha" });
    assert.equal(r.caminho, "indice");
    assert.deepEqual(ids(r), ["A9", "A1"], "o achado numa mensagem só vem antes do espalhado");
    assert.equal(r.total, 2);
    const [direto, espalhado] = res(r) as [Obj, Obj];
    assert.equal(direto.espalhado, undefined);
    assert.equal(espalhado.espalhado, true);
    assert.deepEqual(espalhado.bloco, { inicio: new Date(BASE - 5 * DIA).toISOString(), fim: new Date(BASE - 5 * DIA + 2 * MIN).toISOString(), mensagens: 2, achados: 2 });
    assert.match(String(r.para_o_claude), /espalhado: true/);
    // A3 e A4 têm as duas palavras, mas em blocos diferentes (30 min): não entram.
    assert.ok(!ids(r).includes("A3") && !ids(r).includes("A4"));
    // Recentes: todos pela data da mensagem que representa.
    assert.deepEqual(ids(await buscar(c, { texto: "contrato amanha", ordem: "recentes" })), ["A1", "A9"]);
  });

  it("vários achados do mesmo bloco viram um resultado, com `achados` e `total` em blocos", async () => {
    const c = await cenario();
    const r = await buscar(c, { texto: "pizza", ordem: "recentes" });
    assert.deepEqual(ids(r), ["B2", "A7", "B1"], "o bloco da Ana é representado pela mais bem colocada (aqui, a mais nova)");
    assert.equal(r.total, 3);
    const daAna = res(r)[1]!;
    assert.equal((daAna.bloco as Obj).mensagens, 4, "a figurinha conta no bloco");
    assert.equal((daAna.bloco as Obj).achados, 3);
    assert.equal((res(r)[0]!.bloco as Obj).achados, 1);
    // Por relevância, o mesmo conjunto.
    const rel = await buscar(c, { texto: "pizza" });
    assert.deepEqual(new Set(ids(rel)).size, 3);
    assert.equal(rel.total, 3);
  });

  it("agrupar: \"mensagem\" é a lista plana da 0.8.0 (sem espalhados), com `bloco` preenchido", async () => {
    const c = await cenario();
    const r = await buscar(c, { texto: "pizza", ordem: "recentes", agrupar: "mensagem" });
    assert.deepEqual(ids(r), ["B2", "A7", "A6", "A5", "B1"]);
    assert.equal(r.total, 5);
    assert.deepEqual(res(r).map((x) => (x.bloco as Obj).achados), [1, 3, 3, 3, 1]);
    const espalhado = await buscar(c, { texto: "contrato amanha", agrupar: "mensagem" });
    assert.deepEqual(ids(espalhado), ["A9"]);
    assert.equal(espalhado.total, 1);
    const p = await buscar(c, { texto: "pizza", ordem: "recentes", agrupar: "mensagem", limite: 2, cursor: "2" });
    assert.deepEqual(ids(p), ["A6", "A5"]);
    assert.equal(p.proximo, "4");
  });

  it("por_conversa: na primeira página, sem filtro de conversa e com achados em 2+ conversas", async () => {
    const c = await cenario();
    const r = await buscar(c, { texto: "pizza", agrupar: "mensagem" });
    const pc = r.por_conversa as Obj[];
    assert.equal(pc.length, 2);
    assert.equal(pc[0]!.achados, 3, "a Ana tem três mensagens com pizza");
    assert.equal(pc[1]!.achados, 2);
    assert.match(String((pc[0]!.conversa as Obj).id), /^c_[0-9a-f]{12}$/);
    assert.equal((pc[0]!.conversa as Obj).numero, "+55 11 91234-5678");
    assert.ok(!JSON.stringify(pc).includes(ANA));
    const porBloco = (await buscar(c, { texto: "pizza" })).por_conversa as Obj[];
    assert.deepEqual(porBloco.map((x) => x.achados), [2, 1], "por bloco: o Beto tem dois blocos, a Ana um");
    assert.equal((await buscar(c, { texto: "pizza", cursor: "1" })).por_conversa, undefined, "só na primeira página");
    assert.equal((await buscar(c, { texto: "pizza", conversa: pn(ANA) })).por_conversa, undefined, "com conversa, não");
    assert.equal((await buscar(c, { texto: "contrato" })).por_conversa, undefined, "uma conversa só, não");
  });

  it("filtros com espalhado: de_mim desliga os espalhados; desde/ate exigem a mensagem que representa no intervalo", async () => {
    const c = await cenario();
    assert.deepEqual(ids(await buscar(c, { texto: "contrato amanha", de_mim: false })), ["A9"], "com de_mim, sem espalhado");
    // O intervalo começa em A2: o espalhado continua, representado por A2 (a primeira com alguma palavra no intervalo).
    const desde = await buscar(c, { texto: "contrato amanha", desde: new Date(BASE - 5 * DIA + MIN).toISOString(), ate: new Date(BASE - 5 * DIA + 10 * MIN).toISOString() });
    assert.deepEqual(ids(desde), ["A2"]);
    assert.equal(res(desde)[0]!.espalhado, true);
    assert.equal((res(desde)[0]!.bloco as Obj).achados, 2);
    // Termina antes do bloco: nada dele.
    const ate = await buscar(c, { texto: "contrato amanha", desde: new Date(BASE - 6 * DIA).toISOString(), ate: new Date(BASE - 5 * DIA - MIN).toISOString() });
    assert.deepEqual(ids(ate), []);
    // Conversa: o espalhado continua dentro dela.
    assert.deepEqual(ids(await buscar(c, { texto: "contrato amanha", conversa: pn(ANA), ordem: "recentes" })), ["A1", "A9"]);
    assert.deepEqual(ids(await buscar(c, { texto: "contrato amanha", conversa: pn(BETO) })), []);
  });

  it("bloco com achado numa mensagem fora do período não vira espalhado", async () => {
    m = await montar();
    const { banco } = await m.ctx.nucleo();
    banco.gravarMensagens(pn(ANA), [mg("X1", "contrato amanhã", BASE), mg("X2", "contrato", BASE + MIN)]);
    const { cliente, fechar } = await conectarCliente(m.ctx);
    fecharCliente = fechar;
    const r = await buscar(cliente, { texto: "contrato amanha", desde: new Date(BASE + MIN).toISOString() });
    assert.deepEqual(ids(r), []);
  });
});

describe("0.9.0: wa_ler_conversa com em_volta_de abre o bloco", () => {
  async function conversa(mensagens: MensagemGuardada[]): Promise<Cliente> {
    m = await montar();
    const { banco } = await m.ctx.nucleo();
    banco.gravarMensagens(pn(ANA), mensagens);
    const { cliente, fechar } = await conectarCliente(m.ctx);
    fecharCliente = fechar;
    return cliente;
  }
  const nome = (i: number) => `M${String(i).padStart(2, "0")}`;
  const janela = (r: Obj) => (r.mensagens as Array<{ id: string; pedida?: boolean }>).map((x) => x.id);

  it("bloco pequeno é completado com as vizinhas até 11", async () => {
    // M08, M09 e M10 a 1 min uma da outra; o resto a 1 dia.
    const ts = (i: number) => (i <= 8 ? BASE - (20 - i) * DIA : i <= 10 ? BASE - 12 * DIA + (i - 8) * MIN : BASE - (20 - i) * DIA);
    const c = await conversa(Array.from({ length: 20 }, (_, i) => mg(nome(i), `mensagem ${i}`, ts(i))));
    const r = await chamar(c, "wa_ler_conversa", { conversa: pn(ANA), em_volta_de: "M09" });
    assert.deepEqual(janela(r), Array.from({ length: 11 }, (_, i) => nome(i + 4)), "4 antes do bloco, o bloco (3) e 4 depois");
    assert.deepEqual((r.bloco as Obj).mensagens, 3);
    assert.equal((r.bloco as Obj).inicio, new Date(ts(8)).toISOString());
    assert.equal((r.bloco as Obj).fim, new Date(ts(10)).toISOString());
  });

  it("bloco entre 11 e 40 vem inteiro; maior que 40 é cortado em 40 em volta da mensagem", async () => {
    // M00..M14 longe; M15..M74 (60) a 1 min uma da outra; M75..M79 longe.
    const ts = (i: number) => (i < 15 ? BASE - (100 - i) * DIA : i < 75 ? BASE - 50 * DIA + (i - 15) * MIN : BASE - (100 - i) * DIA);
    const c = await conversa(Array.from({ length: 80 }, (_, i) => mg(nome(i), `mensagem ${i}`, ts(i))));
    const r = await chamar(c, "wa_ler_conversa", { conversa: pn(ANA), em_volta_de: "M45" });
    assert.equal(janela(r).length, 40);
    assert.deepEqual(janela(r), Array.from({ length: 40 }, (_, i) => nome(i + 26)), "19 antes, ela e 20 depois");
    assert.equal((r.bloco as Obj).mensagens, 60);
    assert.deepEqual((r.mensagens as Array<{ id: string; pedida?: boolean }>).filter((x) => x.pedida).map((x) => x.id), ["M45"]);
    // Perto da ponta do bloco, o corte fica dentro do bloco.
    const ponta = await chamar(c, "wa_ler_conversa", { conversa: pn(ANA), em_volta_de: "M16" });
    assert.deepEqual(janela(ponta), Array.from({ length: 40 }, (_, i) => nome(i + 15)));
  });

  it("bloco de tamanho médio vem inteiro; com `limite` a janela é fixa como antes", async () => {
    // M05..M19 (15) a 1 min; o resto longe.
    const ts = (i: number) => (i >= 5 && i < 20 ? BASE - 50 * DIA + i * MIN : BASE - (100 - i) * DIA);
    const c = await conversa(Array.from({ length: 30 }, (_, i) => mg(nome(i), `mensagem ${i}`, ts(i))));
    const r = await chamar(c, "wa_ler_conversa", { conversa: pn(ANA), em_volta_de: "M07" });
    assert.deepEqual(janela(r), Array.from({ length: 15 }, (_, i) => nome(i + 5)));
    const fixo = await chamar(c, "wa_ler_conversa", { conversa: pn(ANA), em_volta_de: "M07", limite: 3 });
    assert.deepEqual(janela(fixo), ["M06", "M07", "M08"]);
    assert.equal((fixo.bloco as Obj).mensagens, 15, "a resposta diz o bloco mesmo com limite");
  });
});

describe("0.9.0: o índice esquece na hora o que este processo apaga", () => {
  async function comIndice(): Promise<{ c: Cliente; banco: Awaited<ReturnType<Montagem["ctx"]["nucleo"]>>["banco"] }> {
    const c = await cenario();
    const { banco } = await m!.ctx.nucleo();
    banco.permitirGrupo(GRUPO);
    banco.gravarMensagens(GRUPO, [mg("G1", "pizza no grupo", BASE, { remetente: { nome: "Beto", numero: BETO } })]);
    await buscar(c, { texto: "pizza" });
    await chamar(c, "wa_listar_conversas");
    assert.equal(m!.ctx.busca.estado().mensagens_indexadas, 11);
    assert.ok(m!.ctx.triagem.tamanho > 0);
    return { c, banco };
  }
  const vazio = () => {
    assert.equal(m!.ctx.busca.estado().mensagens_indexadas, null, "índice descartado");
    assert.equal(m!.ctx.triagem.tamanho, 0, "triagem esvaziada");
  };

  it("bloquear (pela ferramenta) e tirar grupo esvaziam na hora; a busca seguinte remonta sem o que saiu", async () => {
    const { c, banco } = await comIndice();
    await chamar(c, "wa_bloquear_conversas", { bloquear: [pn(BETO)] });
    vazio();
    assert.deepEqual(new Set(ids(await buscar(c, { texto: "pizza", agrupar: "mensagem" }))), new Set(["A5", "A6", "A7", "G1"]));
    await chamar(c, "wa_listar_conversas");
    assert.equal(banco.removerGrupo(GRUPO), 1);
    vazio();
    assert.deepEqual(new Set(ids(await buscar(c, { texto: "pizza", agrupar: "mensagem" }))), new Set(["A5", "A6", "A7"]));
  });

  it("desconectar (apagar tudo) esvazia na hora", async () => {
    const { c, banco } = await comIndice();
    banco.apagarTudo();
    vazio();
    assert.equal((await buscar(c, { texto: "pizza" })).total, 0);
  });
});

/** Um `node:sqlite` de verdade, com o `exec` ou o `prepare` recusando o SQL que casa com `proibido`. */
function sqliteQueRecusa(onde: "exec" | "prepare", proibido: RegExp): CarregarSqlite {
  return () => {
    const real = carregarSqlite()!;
    class Recusa extends real.DatabaseSync {
      override exec(sql: string): void {
        if (onde === "exec" && proibido.test(sql)) throw new Error("recusado neste teste");
        super.exec(sql);
      }
      override prepare(sql: string) {
        if (onde === "prepare" && proibido.test(sql)) throw new Error("recusado neste teste");
        return super.prepare(sql);
      }
    }
    return { ...real, DatabaseSync: Recusa } as typeof real;
  };
}

describe("0.9.0: varredura só quando pode achar algo", () => {
  async function contandoLeituras(c: Cliente): Promise<{ leituras: () => number }> {
    const { banco } = await m!.ctx.nucleo();
    await buscar(c, { texto: "pizza" }); // monta o índice
    let n = 0;
    const original = banco.lerMensagens.bind(banco);
    banco.lerMensagens = (jid: string) => {
      n++;
      return original(jid);
    };
    return { leituras: () => n };
  }

  it("fts5 + trigram sem acento e termos de 3+ caracteres: zero achados responde pelo pedaço, sem decifrar nada", async () => {
    const c = await cenario();
    const { leituras } = await contandoLeituras(c);
    const r = await buscar(c, { texto: "inexistente palavra" });
    assert.equal(r.total, 0);
    assert.equal(r.caminho, "pedaco");
    assert.equal(leituras(), 0, "nenhuma conversa decifrada de novo");
  });

  it("termo curto: a varredura roda", async () => {
    const c = await cenario();
    const { leituras } = await contandoLeituras(c);
    const r = await buscar(c, { texto: "xy inexistente" });
    assert.equal(r.caminho, "varredura");
    assert.ok(leituras() > 0);
  });

  it("trigram ausente: a varredura roda", async () => {
    const c = await cenario({ carregarSqlite: sqliteQueRecusa("exec", /trigram/) });
    assert.equal(m!.ctx.busca.trigram, false);
    const r = await buscar(c, { texto: "inexistente palavra" });
    assert.equal(r.caminho, "varredura");
    assert.equal(r.total, 0);
  });

  it("trigram sem remove_diacritics: a varredura roda", async () => {
    // O teste da partida só aceita o trigram que acha "DOMI" em "condomínio", ou seja, com remove_diacritics: sem ele,
    // o motor fica sem trigram (o caso acima). A regra em si, com um tokenizador sem acento e outro sem:
    assert.equal(varreduraNaoAchaMais({ trigram: true, tokenizadorDoPedaco: "trigram remove_diacritics 1" }, ["inexistente", "palavra"]), true);
    assert.equal(varreduraNaoAchaMais({ trigram: true, tokenizadorDoPedaco: "trigram" }, ["inexistente", "palavra"]), false);
    assert.equal(varreduraNaoAchaMais({ trigram: true, tokenizadorDoPedaco: "trigram remove_diacritics 1" }, ["xy", "palavra"]), false, "termo curto");
    assert.equal(varreduraNaoAchaMais({ trigram: true, tokenizadorDoPedaco: "trigram remove_diacritics 1" }, ["!!!"]), false, "sem termo que o pedaço procure");
    assert.equal(varreduraNaoAchaMais({ trigram: false }, ["inexistente"]), false);
    const c = await cenario({ carregarSqlite: sqliteQueRecusa("exec", /trigram remove_diacritics/) });
    assert.equal(m!.ctx.busca.trigram, false);
    assert.equal((await buscar(c, { texto: "inexistente palavra" })).caminho, "varredura");
  });

  it("erro do SQLite na consulta: a varredura responde, com os espalhados", async () => {
    const c = await cenario({ carregarSqlite: sqliteQueRecusa("prepare", /FROM palavras JOIN/) });
    const r = await buscar(c, { texto: "contrato amanha" });
    assert.equal(r.caminho, "varredura");
    assert.deepEqual(ids(r), ["A9", "A1"]);
    assert.equal(res(r)[1]!.espalhado, true);
  });

  it("motor varredura: zero achados também passa pela varredura", async () => {
    const c = await cenario({ carregarSqlite: NEGADO });
    const r = await buscar(c, { texto: "inexistente palavra" });
    assert.equal(r.caminho, "varredura");
    assert.equal(r.total, 0);
  });
});

describe("0.9.0: plano B (varredura) com os campos novos", () => {
  it("blocos calculados na hora: espalhado, junção com `achados`, `total` em blocos, `agrupar: \"mensagem\"` e por_conversa", async () => {
    const c = await cenario({ carregarSqlite: NEGADO });
    assert.equal(m!.ctx.busca.motor, "varredura");
    const esp = await buscar(c, { texto: "contrato amanha" });
    assert.equal(esp.caminho, "varredura");
    assert.deepEqual(ids(esp), ["A9", "A1"]);
    assert.equal(res(esp)[1]!.espalhado, true);
    assert.deepEqual((res(esp)[1]!.bloco as Obj).mensagens, 2);
    assert.deepEqual(ids(await buscar(c, { texto: "contrato amanha", de_mim: false })), ["A9"]);
    const pizza = await buscar(c, { texto: "pizza" });
    assert.deepEqual(ids(pizza), ["B2", "A7", "B1"]);
    assert.equal(pizza.total, 3);
    assert.deepEqual(res(pizza).map((x) => (x.bloco as Obj).achados), [1, 3, 1]);
    assert.deepEqual((pizza.por_conversa as Obj[]).map((x) => x.achados), [2, 1]);
    const plana = await buscar(c, { texto: "pizza", agrupar: "mensagem" });
    assert.deepEqual(ids(plana), ["B2", "A7", "A6", "A5", "B1"]);
    assert.equal(plana.total, 5);
  });
});
