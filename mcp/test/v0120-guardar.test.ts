// 0.12.0: onde o aprendizado fica (jeito.enc) e como some: apagar conversa, bloquear, tirar grupo e desconectar levam o
// que se aprendeu dela; wa_esquecer com `aprendizado`; o mapeamento LID -> número leva junto; outra instância do banco na
// mesma pasta vê o que foi gravado; nada de texto, id, tipo ou número em log, registro ou caixa-preta; nenhum arquivo
// novo além de jeito.enc. Sem rede.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { Banco, type MensagemGuardada } from "../src/banco.ts";
import { CaixaPreta } from "../src/caixa-preta.ts";
import { trocarSaidaDoLog } from "../src/log.ts";
import { ANA, assentar, BETO, chamar, chamarCru, CHAVE_TESTE, clicar, conectar, conectarCliente, GRUPO, ligarEnvio, montar, pn, type Montagem } from "./ajuda.ts";
import { msg } from "./socket-falso.ts";

type Obj = Record<string, unknown>;

let m: Montagem | undefined;
let fecharCliente: (() => Promise<void>) | undefined;
const pastas: string[] = [];
afterEach(async () => {
  await fecharCliente?.();
  fecharCliente = undefined;
  await m?.fechar();
  m = undefined;
  for (const p of pastas.splice(0)) rmSync(p, { recursive: true, force: true });
});

const AGORA = new Date(2026, 10, 14, 12, 0).getTime();
const DIA = 86_400_000;
const LID = "77777000001@lid";
let seq = 0;
const eu = (texto: string, ts: number): MensagemGuardada => ({ id: `E${++seq}`, ts, de_mim: true, tipo: "texto", texto });

/** Tipo, regra da conversa e duas edições (dias diferentes) numa conversa; e uma regra geral aprendida delas. */
function ensinar(banco: Banco, jid: string): void {
  banco.gravarMensagens(jid, [eu("oi", AGORA - 3 * DIA)]);
  for (const dia of [2, 1]) banco.guardarEnvioDeRascunho({ conversa: jid, mensagem_id: `X${++seq}`, ferramenta: "wa_responder", rascunho: "Prezado, tudo certo.", enviado: "tudo certo", em: AGORA - dia * DIA });
  const ids = banco.edicoes().filter((e) => e.conversa === jid).map((e) => e.id);
  banco.aprender(
    { tipos: [{ conversa: jid, tipo: "cliente" }], regra_do_dono: { texto: `só desta ${jid.slice(0, 4)}`, escopo: "conversa", conversa: jid }, propor: [{ texto: `sem prezado ${jid.slice(0, 4)}`, escopo: "geral", edicoes: ids }] },
    AGORA,
  );
}

const temAlgo = (banco: Banco, jid: string) =>
  banco.tipoDaConversa(jid) !== undefined || banco.regras().some((r) => r.conversa === jid) || banco.edicoes().some((e) => e.conversa === jid) || banco.enviosDeRascunho().envios.some((e) => e.conversa === jid);

describe("0.12.0: o aprendizado some com a conversa", () => {
  it("apagar conversa, bloquear e tirar grupo levam tipo, regras da conversa, edições, medidas e a proposta que ficou sem edições", async () => {
    m = await montar({ agora: () => AGORA, pareada: false });
    const { banco } = await m.ctx.nucleo();
    banco.permitirGrupo(GRUPO);
    for (const jid of [pn(ANA), pn(BETO), GRUPO]) ensinar(banco, jid);
    assert.equal(banco.regras().filter((r) => r.estado === "proposta").length, 3);
    banco.apagarConversa(pn(ANA));
    assert.equal(temAlgo(banco, pn(ANA)), false);
    assert.equal(banco.regras().filter((r) => r.estado === "proposta").length, 2, "a proposta da Ana saiu; a do Beto e a do grupo continuam");
    banco.bloquear(pn(BETO));
    assert.equal(temAlgo(banco, pn(BETO)), false);
    banco.removerGrupo(GRUPO);
    assert.equal(temAlgo(banco, GRUPO), false);
    assert.equal(banco.regras().filter((r) => r.estado === "proposta").length, 0, "as propostas ficaram sem as duas edições: saíram");
    assert.equal(existsSync(join(m.config.dirDados, "jeito.enc")), false, "aprendizado vazio não deixa arquivo");
  });

  it("regra ativa (o dono disse sim) fica mesmo quando as edições dela saem; desconectar apaga o jeito.enc", async () => {
    m = await montar({ agora: () => AGORA, pareada: false });
    const { banco } = await m.ctx.nucleo();
    ensinar(banco, pn(ANA));
    const proposta = banco.regras().find((r) => r.estado === "proposta")!;
    banco.aprender({ decidir: { id: proposta.id, decisao: "aceitar" } }, AGORA);
    banco.apagarConversa(pn(ANA));
    const ativa = banco.regras().find((r) => r.id === proposta.id)!;
    assert.equal(ativa.estado, "ativa");
    assert.deepEqual(ativa.edicoes, []);
    assert.equal(existsSync(join(m.config.dirDados, "jeito.enc")), true);
    banco.apagarTudo();
    assert.equal(existsSync(join(m.config.dirDados, "jeito.enc")), false);
    assert.equal(banco.regras().length, 0);
  });

  it("wa_desconectar (clique) leva o aprendizado; o modo volta ligado com o config", async () => {
    m = await montar({ agora: () => AGORA });
    await conectar(m);
    const { banco } = await m.ctx.nucleo();
    ensinar(banco, pn(ANA));
    banco.definirAprendizado(false);
    const { cliente, fechar } = await conectarCliente(m.ctx);
    fecharCliente = fechar;
    const r = await clicar(cliente, await chamarCru(cliente, "wa_desconectar"));
    assert.equal(r.isError, undefined);
    assert.equal(existsSync(join(m.config.dirDados, "jeito.enc")), false);
    assert.equal(banco.aprendizadoLigado(), true);
  });

  it("wa_esquecer com aprendizado: de uma conversa e tudo, sem tocar na memória nem nas mensagens", async () => {
    m = await montar({ agora: () => AGORA, pareada: false });
    const { banco } = await m.ctx.nucleo();
    ensinar(banco, pn(ANA));
    ensinar(banco, pn(BETO));
    banco.anotar(pn(ANA), { resumo: { texto: "resumo", ate: AGORA - 3 * DIA } }, AGORA);
    const { cliente, fechar } = await conectarCliente(m.ctx);
    fecharCliente = fechar;
    const uma = await chamar(cliente, "wa_esquecer", { conversa: pn(ANA), aprendizado: true });
    assert.deepEqual(uma.aprendizado, { tipos_apagados: 1, regras_apagadas: 1, edicoes_apagadas: 2 });
    assert.equal(temAlgo(banco, pn(ANA)), false);
    assert.equal(temAlgo(banco, pn(BETO)), true);
    assert.ok(banco.resumoDaConversa(pn(ANA)), "a memória continua");
    assert.equal(banco.lerMensagens(pn(ANA)).length, 1);
    const tudo = await chamar(cliente, "wa_esquecer", { aprendizado: true });
    assert.equal(tudo.tudo, true);
    assert.equal(existsSync(join(m.config.dirDados, "jeito.enc")), false);
    assert.ok(banco.resumoDaConversa(pn(ANA)));
    // O que já fazia continua.
    assert.equal((await chamarCru(cliente, "wa_esquecer", {})).isError, true);
    assert.equal((await chamar(cliente, "wa_esquecer", { tudo: true })).resumos_apagados, 1);
  });
});

describe("0.12.0: LID -> número e outra instância", () => {
  it("no mapeamento LID -> número o aprendizado vai para o número", async () => {
    m = await montar({ agora: () => AGORA, pareada: false });
    const { banco } = await m.ctx.nucleo();
    ensinar(banco, LID);
    assert.equal(banco.tipoDaConversa(LID), "cliente");
    banco.mapearLid(LID, pn(ANA));
    assert.equal(temAlgo(banco, LID), false);
    assert.equal(banco.tipoDaConversa(pn(ANA)), "cliente");
    assert.equal(banco.edicoes().filter((e) => e.conversa === pn(ANA)).length, 2);
    assert.equal(banco.regras().find((r) => r.escopo === "conversa")!.conversa, pn(ANA));
    // Só o tipo sob um LID sem conversa: o par já no mapa ainda leva (mapearLids).
    banco.aprender({ tipos: [{ conversa: "77777000002@lid", tipo: "aluno" }] }, AGORA);
    banco.mapearLids([{ lid: "77777000002@lid", pn: pn(BETO) }]);
    assert.equal(banco.tipoDaConversa(pn(BETO)), "aluno");
  });

  it("outra instância do banco na mesma pasta vê o que foi gravado, e o que ela apaga esta deixa de ver", async () => {
    m = await montar({ agora: () => AGORA, pareada: false });
    const { banco } = await m.ctx.nucleo();
    ensinar(banco, pn(ANA));
    const outro = new Banco({ dir: m.config.dirDados, chave: Buffer.from(CHAVE_TESTE, "hex") });
    assert.deepEqual(outro.regras(), banco.regras());
    assert.deepEqual(outro.edicoes(), banco.edicoes());
    assert.equal(outro.tipoDaConversa(pn(ANA)), "cliente");
    outro.esquecerAprendizado(pn(ANA));
    assert.equal(temAlgo(banco, pn(ANA)), false);
  });
});

describe("0.12.0: nada vaza e nenhum arquivo novo além de jeito.enc", () => {
  it("rascunho, enviado, regra e tipo sigilosos: nada em log, registro ou caixa-preta; o arquivo é cifrado", async () => {
    const base = mkdtempSync(join(tmpdir(), "wa-jeito-"));
    pastas.push(base);
    const logs: string[] = [];
    const restaurar = trocarSaidaDoLog((l) => logs.push(l));
    try {
      const caixaPreta = new CaixaPreta({ dir: join(base, "logs"), saida: () => {} });
      m = await montar({ dir: base, caixaPreta });
      const s = await conectar(m);
      s.mensagens([msg({ jid: pn(ANA), id: "A1", texto: "oi", nome: "Ana", ts: Date.now() - 60_000 })]);
      await assentar(m);
      const { cliente, fechar } = await conectarCliente(m.ctx);
      fecharCliente = fechar;
      await ligarEnvio(cliente);
      const { banco } = await m.ctx.nucleo();
      const dados = m.config.dirDados;
      const antes = new Set(readdirSync(dados));
      const id = banco.idPublico(pn(ANA));
      // Dois envios editados (o segundo um dia "depois", direto no banco), regra do dono, tipo e proposta.
      await clicar(cliente, await chamarCru(cliente, "wa_responder", { conversa: ANA, texto: "RASCUNHO-SIGILOSO prezado" }), "ENVIADO-SIGILOSO");
      banco.guardarEnvioDeRascunho({ conversa: pn(ANA), mensagem_id: "MSG-SIGILOSA", ferramenta: "wa_responder", rascunho: "RASCUNHO-SIGILOSO dois prezado", enviado: "ENVIADO-SIGILOSO dois", em: Date.now() - DIA });
      const ids = banco.edicoes().map((e) => e.id);
      await chamar(cliente, "wa_aprender", { tipo_da_conversa: [{ conversa: ANA, tipo: "TIPO-SIGILOSO" }], regra_do_dono: { texto: "REGRA-SIGILOSA do dono", escopo: "conversa", conversa: ANA } });
      const p = await chamar(cliente, "wa_aprender", { propor: [{ texto: "REGRA-SIGILOSA aprendida", escopo: "geral", edicoes: ids }] });
      const rid = (p.propostas as Obj[])[0]!.id as string;
      await chamar(cliente, "wa_aprender", { decidir: { id: rid, decisao: "aceitar" }, marcar_vistas: ids });
      await chamar(cliente, "wa_meu_jeito");
      await chamar(cliente, "wa_meu_jeito", { conversa: ANA });
      await chamar(cliente, "wa_exemplos_do_meu_jeito", { conversa: ANA, respondendo_a: "RASCUNHO-SIGILOSO" });
      await chamar(cliente, "wa_edicoes_dos_rascunhos", { incluir_vistas: true });
      await chamar(cliente, "wa_estado");
      await chamar(cliente, "wa_aprender", { ligar: false });
      await chamar(cliente, "wa_aprender", { ligar: true });
      // Um arquivo com legenda editada.
      // 0.16.0: só das pastas permitidas (a casa dos testes é a pasta da montagem).
      mkdirSync(join(base, "Documents", "meus"), { recursive: true });
      writeFileSync(join(base, "Documents", "meus", "a.pdf"), "%PDF-1.4 x");
      await clicar(cliente, await chamarCru(cliente, "wa_enviar_arquivo", { conversa: ANA, arquivo: join(base, "Documents", "meus", "a.pdf"), legenda: "RASCUNHO-SIGILOSO legenda" }), "ENVIADO-SIGILOSO legenda");
      assert.ok(!readFileSync(join(dados, "jeito.enc"), "utf8").includes("SIGILOS"), "o jeito.enc é cifrado");
      await chamar(cliente, "wa_esquecer", { conversa: ANA, aprendizado: true });
      await chamar(cliente, "wa_esquecer", { aprendizado: true });
      await m.ctx.transporte?.esperar();
      const novos = readdirSync(dados).filter((f) => !antes.has(f));
      // envios.enc (a contagem do dia) já existia antes da 0.12.0 e nasce no primeiro envio; o único nome novo é jeito.enc.
      assert.ok(novos.every((f) => f === "jeito.enc" || f === "envios.enc"), `arquivos novos: ${novos.join(", ")}`);
      assert.ok(!novos.some((f) => f.endsWith(".tmp")));
      await fechar();
      fecharCliente = undefined;
      const arquivos = (q: string): string[] => (existsSync(q) ? readdirSync(q).flatMap((n) => (statSync(join(q, n)).isDirectory() ? arquivos(join(q, n)) : [join(q, n)])) : []);
      const textos = [...arquivos(m.config.dirLogs), ...arquivos(join(base, "logs"))].map((f) => readFileSync(f, "utf8"));
      assert.ok(textos.some((t) => t.includes("wa_aprender")), "o registro tem a ação");
      for (const t of [...textos, ...logs]) {
        for (const segredo of ["SIGILOS", "prezado", ANA, rid, ...ids, "MSG-SIGILOSA", pn(ANA)]) assert.ok(!t.includes(segredo), `vazou ${segredo}: ${t.slice(0, 200)}`);
      }
      const registro = readFileSync(m.caminhoRegistro, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Obj);
      for (const linha of registro.filter((l) => l.acao === "wa_aprender" || (l.acao === "wa_esquecer" && l.aprendizado))) {
        assert.ok(!JSON.stringify(linha).includes(id), "wa_aprender e o esquecer do aprendizado não levam nem o id da conversa");
        for (const [k, v] of Object.entries(linha)) if (!["acao", "quando"].includes(k)) assert.ok(typeof v === "number" || typeof v === "boolean", `${k} não é contagem`);
      }
    } finally {
      restaurar();
    }
  });
});
