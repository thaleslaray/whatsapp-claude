// 0.15.0: os nomes e telefones que vêm da agenda do WhatsApp não aparecem no log, no stderr, no registro de ações nem
// na caixa-preta. Passa pela agenda pedida de novo ao celular, pelo wa_estado e pelo wa_listar_conversas (desde a 0.15.1
// a caixa-preta anota `agenda_ressincronizada`).

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { CaixaPreta } from "../src/caixa-preta.ts";
import { trocarSaidaDoLog } from "../src/log.ts";
import { assentar, chamarCru, conectar, conectarCliente, montar, pn, textoDe, type Montagem } from "./ajuda.ts";
import { msg } from "./socket-falso.ts";

const ZULEICA = "5511975318642";
const XIMENA = "5521986427531";
const NOME_DA_AGENDA = "Zuleica Quintanilha";
const APELIDO_PUBLICO = "Ximbica Apelido";

/** O que não pode aparecer em lugar nenhum fora da resposta ao modelo. */
const PROIBIDOS = [
  NOME_DA_AGENDA,
  "Quintanilha",
  APELIDO_PUBLICO,
  "Ximbica",
  ZULEICA,
  XIMENA,
  "975318642",
  "986427531",
  "88888000009",
];

let m: Montagem | undefined;
let fechar: (() => Promise<void>) | undefined;
let linhas: string[] = [];
let stderr: string[] = [];
let caixa: string[] = [];
let restaurarLog: () => void = () => {};
let stderrOriginal: typeof process.stderr.write;

beforeEach(() => {
  linhas = [];
  stderr = [];
  caixa = [];
  restaurarLog = trocarSaidaDoLog((l) => linhas.push(l));
  stderrOriginal = process.stderr.write;
  process.stderr.write = ((t: string | Uint8Array) => {
    stderr.push(String(t));
    return true;
  }) as typeof process.stderr.write;
});
afterEach(async () => {
  process.stderr.write = stderrOriginal;
  restaurarLog();
  await fechar?.();
  fechar = undefined;
  await m?.fechar();
  m = undefined;
});

describe("0.15.0: vazamento dos nomes e telefones da agenda", () => {
  it("nada de nome ou telefone no log, no stderr, no registro nem na caixa-preta", async () => {
    m = await montar({ caixaPreta: new CaixaPreta({ saida: (l) => caixa.push(l) }) });
    const s = await conectar(m);
    s.mensagens([msg({ jid: pn(ZULEICA), id: "Z1", texto: "oi" }), msg({ jid: pn(XIMENA), id: "X1", texto: "oi" })]);
    await assentar(m);
    s.ligarRessincronizacao(async () => {
      setTimeout(() => s.emitir("contacts.upsert", [{ id: pn(ZULEICA), name: NOME_DA_AGENDA }, { id: "88888000009@lid", lid: "88888000009@lid", phoneNumber: pn(XIMENA), notify: APELIDO_PUBLICO }]), 10);
    });
    const cli = await conectarCliente(m.ctx);
    fechar = cli.fechar;
    const c = cli.cliente;

    const agenda = await chamarCru(c, "wa_atualizar_contatos");
    assert.equal(agenda.isError, undefined, textoDe(agenda));
    assert.equal(agenda.structuredContent!.contatos_recebidos, 2);

    assert.equal((await chamarCru(c, "wa_estado")).isError, undefined);
    assert.equal((await chamarCru(c, "wa_listar_conversas")).isError, undefined);
    await assentar(m);

    const registro = existsSync(m.caminhoRegistro) ? readFileSync(m.caminhoRegistro, "utf8") : "";
    assert.ok(registro.includes("wa_atualizar_contatos"), "o registro anotou o pedido (só contagens)");
    assert.ok(caixa.some((l) => l.includes("agenda_ressincronizada")), "a caixa-preta anotou o pedido (só contagens)");
    for (const [onde, textos] of [
      ["log", linhas],
      ["stderr", stderr],
      ["registro de ações", [registro]],
      ["caixa-preta", caixa],
    ] as const) {
      for (const t of textos) for (const p of PROIBIDOS) assert.ok(!t.includes(p), `${onde} trouxe ${JSON.stringify(p)}: ${t.slice(0, 200)}`);
    }
  });
});
