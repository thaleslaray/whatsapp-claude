// 0.16.0, item 6 da revisão de segurança (a conferir): os nomes da agenda do celular (0.15). Aqui se prova que:
// - o nome que chega da agenda (wa_atualizar_contatos; a automática chega pelo MESMO `contacts.upsert`) só fica no
//   indice.enc, cifrado: nenhum arquivo da pasta de dados, do registro ou da caixa-preta o tem em texto claro;
// - wa_desconectar e o loggedOut apagam o índice (os nomes) e o config.enc (a data `agenda_atualizada_em`);
// - o nome de uma conversa bloqueada (wa_bloquear_conversas) é apagado e não volta numa ressincronização seguinte,
//   nem pelo número nem pelo LID.
// Socket falso, sem rede, relógio dos pedidos fixo.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { CaixaPreta } from "../src/caixa-preta.ts";
import { abrir } from "../src/cripto.ts";
import { ANA, assentar, BETO, chamarCru, CHAVE_TESTE, clicar, conectar, conectarCliente, montar, pn, textoDe, type Montagem } from "./ajuda.ts";
import { msg } from "./socket-falso.ts";

const NOME_ANA = "Ana Agenda Sigilosa";
const NOME_BETO = "Beto Agenda Sigiloso";
const LID_DO_BETO = "998877665544@lid";
const MIN = 60_000;

let AGORA = 0;
let montagens: Montagem[] = [];
let fechamentos: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const f of fechamentos.reverse()) await f();
  fechamentos = [];
  for (const m of montagens.reverse()) await m.fechar();
  montagens = [];
});

const AGENDA = [
  { id: pn(ANA), name: NOME_ANA },
  { id: LID_DO_BETO, lid: LID_DO_BETO, phoneNumber: pn(BETO), name: NOME_BETO },
  { id: pn(BETO), name: NOME_BETO },
];

async function cenario() {
  AGORA = new Date(2026, 10, 15, 10, 0, 0).getTime();
  const caixa: string[] = [];
  const m = await montar({ agora: () => AGORA, esperaDosContatosMs: 400, caixaPreta: new CaixaPreta({ saida: (l) => caixa.push(l) }) });
  montagens.push(m);
  const s = await conectar(m);
  s.mensagens([msg({ jid: pn(ANA), id: "A1", texto: "oi", nome: "Ana" }), msg({ jid: pn(BETO), id: "B1", texto: "oi", nome: "Beto" })]);
  await assentar(m);
  s.ligarRessincronizacao(async () => {
    setTimeout(() => s.emitir("contacts.upsert", AGENDA), 30);
  });
  const { cliente, fechar } = await conectarCliente(m.ctx);
  fechamentos.push(fechar);
  const { banco } = await m.ctx.nucleo();
  return { m, s, c: cliente, banco, caixa };
}

function todosOsArquivos(pasta: string): string[] {
  if (!existsSync(pasta)) return [];
  return readdirSync(pasta).flatMap((n) => {
    const f = join(pasta, n);
    const st = statSync(f);
    return st.isDirectory() ? todosOsArquivos(f) : st.isFile() ? [f] : [];
  });
}

const indice = (m: Montagem) =>
  JSON.parse(abrir(Buffer.from(CHAVE_TESTE, "hex"), "indice", readFileSync(join(m.config.dirDados, "indice.enc"), "utf8").trim())) as {
    conversas: Record<string, { nome?: string }>;
    nomes: Record<string, { nome: string }>;
  };

async function atualizar(c: Awaited<ReturnType<typeof cenario>>["c"]) {
  const r = await chamarCru(c, "wa_atualizar_contatos");
  assert.equal(r.isError, undefined, textoDe(r));
  return r;
}

describe("0.16.0: nomes da agenda só no indice.enc, cifrado", () => {
  it("o nome da agenda fica no índice cifrado e em nenhum arquivo em texto claro (dados, registro, caixa-preta)", async () => {
    const { m, c, banco, caixa } = await cenario();
    await atualizar(c);
    assert.equal(banco.entrada(pn(ANA))!.nome, NOME_ANA);
    assert.equal(indice(m).conversas[pn(ANA)]!.nome, NOME_ANA, "no indice.enc, decifrado");
    for (const f of [...todosOsArquivos(m.config.dirDados), ...todosOsArquivos(m.config.dirLogs)]) {
      const bruto = readFileSync(f);
      assert.ok(!bruto.includes(NOME_ANA) && !bruto.includes("Agenda Sigilos"), `nome em claro em ${f}`);
    }
    for (const l of caixa) assert.ok(!l.includes("Sigilos"), "nada do nome na caixa-preta");
    assert.ok(banco.agendaAtualizadaEm() !== undefined, "a data da agenda ficou gravada");
  });
});

describe("0.16.0: desconectar e loggedOut apagam os nomes e a data da agenda", () => {
  it("wa_desconectar: indice.enc e config.enc somem; a data agenda_atualizada_em some", async () => {
    const { m, c, banco } = await cenario();
    await atualizar(c);
    assert.ok(existsSync(join(m.config.dirDados, "indice.enc")));
    const r = await clicar(c, await chamarCru(c, "wa_desconectar"));
    assert.equal(r.isError, undefined, textoDe(r));
    assert.equal(existsSync(join(m.config.dirDados, "indice.enc")), false);
    assert.equal(existsSync(join(m.config.dirDados, "config.enc")), false);
    assert.equal(banco.agendaAtualizadaEm(), undefined);
    assert.equal(banco.entrada(pn(ANA)), undefined);
  });

  it("loggedOut (o celular tirou o aparelho): o mesmo", async () => {
    const { m, s, c, banco } = await cenario();
    await atualizar(c);
    s.fechar(401);
    const fim = Date.now() + 3_000;
    while (existsSync(join(m.config.dirDados, "indice.enc")) && Date.now() < fim) await new Promise((p) => setTimeout(p, 10));
    assert.equal(existsSync(join(m.config.dirDados, "indice.enc")), false);
    assert.equal(existsSync(join(m.config.dirDados, "config.enc")), false);
    assert.equal(banco.agendaAtualizadaEm(), undefined);
  });
});

describe("0.16.0: conversa bloqueada perde o nome e ele não volta", () => {
  it("wa_bloquear_conversas apaga o nome (número e LID); a ressincronização seguinte não grava de novo", async () => {
    const { m, c, banco } = await cenario();
    await atualizar(c);
    assert.equal(banco.entrada(pn(BETO))!.nome, NOME_BETO);
    const b = await chamarCru(c, "wa_bloquear_conversas", { bloquear: [pn(BETO)] });
    assert.equal(b.isError, undefined, textoDe(b));
    const depois = indice(m);
    assert.equal(depois.conversas[pn(BETO)], undefined);
    assert.equal(depois.nomes[pn(BETO)], undefined);
    assert.equal(depois.nomes[LID_DO_BETO], undefined);
    // A próxima ressincronização (depois do freio de 10 min) traz o Beto de novo, pelo número e pelo LID.
    AGORA += 11 * MIN;
    await atualizar(c);
    const outra = indice(m);
    assert.equal(outra.conversas[pn(BETO)], undefined);
    assert.equal(outra.nomes[pn(BETO)], undefined, "o nome não volta pelo número");
    assert.equal(outra.nomes[LID_DO_BETO], undefined, "nem pelo LID");
    assert.ok(!JSON.stringify(outra).includes(NOME_BETO));
    assert.equal(banco.entrada(pn(ANA))!.nome, NOME_ANA, "a Ana, não bloqueada, continua");
  });
});

