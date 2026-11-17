// 0.14.0 (ajuste com dados reais): a visão geral do wa_meu_jeito passou do teto (26 mil caracteres) sem cortar. Agora o
// `geral` leva só as contagens de `por_tipo_de_mensagem` e não tem `ultimos_90_dias`; `individuais` não tem perfil de
// aviso (não existe aviso fora de grupo); e, se ainda passar do teto, sai `ultimos_90_dias`, depois o perfil de aviso,
// com o campo `aviso` dizendo o que saiu. Acervo grande sintético: 3 perfis, 2 tipos nos grupos.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Banco, MensagemGuardada } from "../src/banco.ts";
import { LIMITE_CARACTERES } from "../src/respostas.ts";
import { chamarCru, conectarCliente, montar, pn, type Montagem } from "./ajuda.ts";

type Obj = Record<string, unknown>;
const AGORA = new Date(2026, 10, 14, 12, 0).getTime();
const DIA = 86_400_000;
let seq = 0;
const eu = (texto: string, ts: number): MensagemGuardada => ({ id: `E${++seq}`, ts, de_mim: true, tipo: "texto", texto });
const ela = (texto: string, ts: number, participante?: string): MensagemGuardada => ({ id: `R${++seq}`, ts, de_mim: false, tipo: "texto", texto, ...(participante ? { participante } : {}) });

// Variedade de uma pessoa de verdade: poucas aberturas, fechos e emojis que se repetem (o acervo rico, abaixo, tem mais).
const ABERTURAS = ["oi", "opa", "bom dia", "boa tarde", "fala", "olha"];
const MEIOS = ["pode ser amanhã", "vou ver com o pessoal", "consigo sim", "tá tranquilo", "manda o orçamento", "chego cedo", "fechado então", "sem pressa", "deixa comigo", "já resolvo", "confere o contrato", "vejo a planilha", "falo com o financeiro", "agenda pra quinta", "revisa o projeto"];
const FECHOS = ["valeu", "abs", "obrigado", "tmj", "vlw", "abraço"];
const EMOJIS = ["😀", "👍", "🙏", "😂", "🔥", "✅", "", "", ""];
const RISADAS = ["kkk", "kkkkkk", "haha", ""];
const fala = (i: number): string => `${ABERTURAS[i % ABERTURAS.length]} ${MEIOS[i % MEIOS.length]} ${RISADAS[i % RISADAS.length]} ${FECHOS[i % FECHOS.length]} ${EMOJIS[i % EMOJIS.length]}`.replace(/\s+/g, " ").trim();
const aviso = (i: number): string => `pessoal, amanhã às ${8 + (i % 10)}h tem encontro novo do grupo, tragam as dúvidas e confiram o material completo no link https://exemplo.com/aula${i} antes de chegar ${FECHOS[i % FECHOS.length]}`;

function semear(banco: Banco): void {
  for (let c = 0; c < 30; c++) {
    const jid = pn(`55119${String(10_000_000 + c)}`);
    const msgs: MensagemGuardada[] = [];
    for (let i = 0; i < 40; i++) {
      const ts = AGORA - (i * 7 + c) * DIA;
      msgs.push(ela("pergunta qualquer?", ts), eu(fala(i + c), ts + 60_000));
    }
    banco.gravarMensagens(jid, msgs.sort((a, b) => a.ts - b.ts));
  }
  for (let g = 0; g < 6; g++) {
    const jid = `1203630000000000${10 + g}@g.us`;
    banco.permitirGrupo(jid);
    const msgs: MensagemGuardada[] = [];
    for (let i = 0; i < 60; i++) {
      const ts = AGORA - (i * 3 + g) * DIA;
      if (i % 3 === 0) msgs.push(eu(aviso(i + g), ts));
      else msgs.push(ela("como faço isso?", ts, `55219${String(20_000_000 + i)}@s.whatsapp.net`), eu(fala(i + g * 7), ts + 60_000));
    }
    banco.gravarMensagens(jid, msgs.sort((a, b) => a.ts - b.ts));
  }
}

describe("0.14.0: a visão geral do wa_meu_jeito cabe no teto", () => {
  let m: Montagem | undefined;
  let fechar: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await fechar?.();
    fechar = undefined;
    await m?.fechar();
    m = undefined;
  });

  async function visao(regras = 0): Promise<{ texto: string; dados: Obj }> {
    m = await montar({ agora: () => AGORA, pareada: false });
    await m.ctx.partida();
    const { banco } = await m.ctx.nucleo();
    semear(banco);
    const c = await conectarCliente(m.ctx);
    fechar = c.fechar;
    const grupos = banco.listarConversas().filter((e) => e.grupo);
    const tipo = await chamarCru(c.cliente, "wa_aprender", { tipo_da_conversa: grupos.map((e, i) => ({ conversa: banco.idPublico(e.jid), tipo: i % 2 ? "alunos" : "clientes" })) });
    assert.equal(tipo.isError, undefined);
    for (let i = 0; i < regras; i++) {
      const texto = `regra longa número ${"x".repeat(i % 10)} ${i}: ${"responder sempre com calma e sem pressa nenhuma, conferindo antes o histórico inteiro da conversa ".repeat(2)}`.slice(0, 200);
      const r = await chamarCru(c.cliente, "wa_aprender", { regra_do_dono: { texto, escopo: "geral" } });
      assert.equal(r.isError, undefined, JSON.stringify(r));
    }
    const r = await chamarCru(c.cliente, "wa_meu_jeito");
    const texto = r.content.map((b) => b.text ?? "").join("");
    return { texto, dados: JSON.parse(texto) as Obj };
  }

  it("acervo como o real: abaixo de 15 mil caracteres (compacto), geral só com contagens, individuais sem aviso", async () => {
    const { texto, dados } = await visao();
    const compacto = JSON.stringify(dados).length;
    assert.ok(compacto < 15_000, `compacto: ${compacto}`);
    assert.ok(texto.length <= LIMITE_CARACTERES, `enviado: ${texto.length}`);
    const geral = dados.geral as Obj;
    assert.deepEqual(Object.keys(geral.por_tipo_de_mensagem as Obj).sort(), ["mensagens", "rajadas"]);
    assert.equal(geral.ultimos_90_dias, undefined);
    const ind = dados.individuais as Obj;
    assert.equal((ind.por_tipo_de_mensagem as Obj).aviso, undefined, "não existe aviso em individual");
    assert.ok((ind.por_tipo_de_mensagem as Obj).resposta);
    assert.ok(ind.ultimos_90_dias);
    const grp = dados.grupos as Obj;
    assert.ok(((grp.por_tipo_de_mensagem as Obj).rajadas as Obj).aviso as number > 0);
    assert.ok((grp.por_tipo_de_mensagem as Obj).aviso);
    assert.ok(grp.ultimos_90_dias);
    assert.equal((dados.por_tipo as Obj[]).length, 2);
    assert.equal(dados.aviso, undefined);
  });

  it("com 30 regras longas, ainda passaria: sai `ultimos_90_dias` (e o aviso, se preciso), o campo `aviso` diz, e fica abaixo do teto", async () => {
    const { texto, dados } = await visao(30);
    assert.ok(texto.length <= LIMITE_CARACTERES, `enviado: ${texto.length}`);
    assert.equal((dados.regras_ativas as Obj[]).length, 30);
    assert.equal((dados.grupos as Obj).ultimos_90_dias, undefined);
    assert.equal((dados.individuais as Obj).ultimos_90_dias, undefined);
    assert.match(String(dados.aviso), /saiu `ultimos_90_dias`/);
    const avisoFora = (dados.grupos as Obj & { por_tipo_de_mensagem: Obj }).por_tipo_de_mensagem.aviso === undefined;
    if (avisoFora) assert.match(String(dados.aviso), /tipo_de_mensagem: "aviso"/);
  });
});
