// 0.16.0, item 5 da revisão de segurança: o código de confirmação não pode chegar ao modelo em nada que o wa_confirmar
// aceite. Antes, o `_meta.codigo` (para o cartão) era o MESMO código que o wa_confirmar aceitava cru nos pedidos sem
// texto (ligar envio, desconectar, listas, arquivo sem legenda): um cliente que repassasse o `_meta` ao modelo o deixaria
// confirmar sozinho. Agora há dois códigos:
// - o código DE TELA (`_meta.codigo`): só o wa_confirmar_tela (visível só ao cartão, `visibility: ["app"]`) aceita;
// - o código DE CONVERSA: SHA-256("conversa\n" + código de tela), 32 hex, calculado pelo CARTÃO só na hora do clique,
//   para a mensagem que ele manda no chat (aba Code). Só o wa_confirmar aceita; nunca vai em `content`,
//   `structuredContent` nem `_meta`.
// Num pedido com texto, cada caminho prende o SEU código ao texto (codigoDoTextoEditado).

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { codigoDeConversa, codigoDoTextoEditado, Pedidos } from "../src/confirmacao.ts";
import { RegistroAcoes } from "../src/registro-acoes.ts";
import { codigoDeConversa as codigoDeConversaDoCartao, codigoEditado, confirmacaoPeloChat } from "../ui/edicao.js";
import {
  ANA,
  assentar,
  chamarCru,
  clicar,
  confirmarPeloChat,
  conectar,
  conectarCliente,
  GRUPO,
  ligarEnvio,
  montar,
  pedidoDa,
  pn,
  textoDe,
  type Montagem,
  type Resultado,
} from "./ajuda.ts";
import { msg } from "./socket-falso.ts";

const C = "0123456789abcdef0123456789abcdef";
const BLOQUEADO = "5511955554444";

describe("0.16.0: dois códigos, o da tela e o da conversa", () => {
  it("o código de conversa do servidor é o mesmo que o cartão calcula, e é diferente do código de tela", () => {
    const k = codigoDeConversa(C);
    assert.match(k, /^[0-9a-f]{32}$/);
    assert.notEqual(k, C);
    assert.equal(codigoDeConversaDoCartao(C), k);
  });

  it("a mensagem que o cartão manda no chat leva só o código de conversa (cru ou preso ao texto), nunca o de tela", () => {
    const k = codigoDeConversa(C);
    const semTexto = confirmacaoPeloChat("ab12cd34", C, null);
    assert.equal(semTexto, `Confirmo o pedido ab12cd34, código ${k}.`);
    assert.ok(!semTexto.includes(C));
    const comTexto = confirmacaoPeloChat("ab12cd34", C, "Chego às 8");
    assert.equal(comTexto, `Confirmo o pedido ab12cd34, código ${codigoDoTextoEditado(k, "Chego às 8")}, com este texto:\nChego às 8`);
    assert.ok(!comTexto.includes(C) && !comTexto.includes(codigoEditado(C, "Chego às 8")));
  });

  function pedidos() {
    const p = new Pedidos(new RegistroAcoes(join("/nao/existe", "acoes.jsonl"), () => {}));
    const previa = { tipo: "envio" as const, titulo: "t", alvo: "a", botao: "b" };
    const semTexto = () => p.criar("wa_envio", { x: 1 }, previa, async () => ({ frase: "ok" }));
    const comTexto = () =>
      p.criar("wa_responder", { texto: "oi" }, { ...previa, tipo: "responder" as const, texto: "oi" }, async () => ({ frase: "ok" }), {
        limite: 100,
        unidade: "caracteres",
        comTexto: (t) => ({ texto: t }),
      });
    return { p, semTexto, comTexto };
  }

  it("sem texto: wa_confirmar recusa o código de tela e aceita o de conversa; wa_confirmar_tela, o contrário", async () => {
    const { p, semTexto } = pedidos();
    const a = semTexto();
    assert.equal((await p.confirmar(a.id, a.codigo, "wa_confirmar")).ok, false, "código de tela pelo wa_confirmar");
    assert.equal((await p.confirmar(a.id, codigoDeConversa(a.codigo), "wa_confirmar")).ok, true);
    const b = semTexto();
    assert.equal((await p.confirmar(b.id, codigoDeConversa(b.codigo), "wa_confirmar_tela")).ok, false, "código de conversa pelo wa_confirmar_tela");
    assert.equal((await p.confirmar(b.id, b.codigo, "wa_confirmar_tela")).ok, true);
  });

  it("com texto: cada caminho só aceita o seu código preso ao texto", async () => {
    const { p, comTexto } = pedidos();
    const a = comTexto();
    assert.equal((await p.confirmar(a.id, codigoDoTextoEditado(a.codigo, "oi"), "wa_confirmar", "oi")).ok, false, "o de tela preso ao texto, pelo wa_confirmar");
    assert.equal((await p.confirmar(a.id, codigoDoTextoEditado(codigoDeConversa(a.codigo), "oi"), "wa_confirmar", "oi")).ok, true);
    const b = comTexto();
    assert.equal((await p.confirmar(b.id, codigoDoTextoEditado(codigoDeConversa(b.codigo), "oi"), "wa_confirmar_tela", "oi")).ok, false);
    assert.equal((await p.confirmar(b.id, codigoDoTextoEditado(b.codigo, "oi"), "wa_confirmar_tela", "oi")).ok, true);
  });
});

// ---- as ferramentas de cartão, de ponta a ponta ----

let m: Montagem | undefined;
let fecharCliente: (() => Promise<void>) | undefined;
afterEach(async () => {
  await fecharCliente?.();
  fecharCliente = undefined;
  await m?.fechar();
  m = undefined;
});

async function cenario(pareada = true) {
  m = await montar({ pareada });
  if (!pareada) {
    await m.ctx.partida();
    const { cliente, fechar } = await conectarCliente(m.ctx);
    fecharCliente = fechar;
    return { c: cliente, m, s: undefined };
  }
  const s = await conectar(m, { grupos: { [GRUPO]: { id: GRUPO, subject: "Família", size: 5, participants: [] } } });
  await assentar(m);
  s.mensagens([msg({ jid: pn(ANA), id: "T1", texto: "oi", nome: "Ana" })]);
  await assentar(m);
  const { cliente, fechar } = await conectarCliente(m.ctx);
  fecharCliente = fechar;
  return { c: cliente, m, s };
}

/** Confere que o resultado inteiro não leva nada que o wa_confirmar aceite e que o código de tela é recusado por ele. */
async function conferirResultado(c: Awaited<ReturnType<typeof cenario>>["c"], nome: string, r: Resultado): Promise<void> {
  assert.equal(r.isError, undefined, `${nome}: ${textoDe(r)}`);
  const { id, codigo } = pedidoDa(r);
  const serial = JSON.stringify(r);
  const k = codigoDeConversa(codigo);
  const texto = (r._meta!.previa as { texto?: string }).texto;
  assert.ok(!serial.includes(k), `${nome}: o código de conversa não pode estar no resultado`);
  if (texto !== undefined) assert.ok(!serial.includes(codigoDoTextoEditado(k, texto)), `${nome}: nem preso ao texto`);
  // O único código no resultado (o de tela) não vale pelo wa_confirmar: nem cru, nem preso ao texto.
  const cru = await chamarCru(c, "wa_confirmar", { id, codigo });
  assert.equal(cru.isError, true, `${nome}: código de tela cru pelo wa_confirmar`);
  if (texto !== undefined) {
    const preso = await chamarCru(c, "wa_confirmar", { id, codigo: codigoDoTextoEditado(codigo, texto), texto });
    assert.equal(preso.isError, true, `${nome}: código de tela preso ao texto pelo wa_confirmar`);
  }
}

describe("0.16.0: o resultado de toda ferramenta de cartão não leva nada que o wa_confirmar aceite", () => {
  it("wa_envio, wa_responder, wa_enviar_arquivo (sem legenda), wa_escolher_grupos, wa_bloquear_conversas, wa_desconectar, wa_iniciar_conversa", async () => {
    const { c, m } = await cenario();
    (await m.ctx.nucleo()).banco.bloquear(pn(BLOQUEADO)); // liberar abre cartão (amplia o que é lido)
    // wa_envio primeiro (os de envio precisam dele ligado): recusa o de tela e confirma pelo caminho do chat.
    const envio = await chamarCru(c, "wa_envio", { ligar: true });
    await conferirResultado(c, "wa_envio", envio);
    const ligou = await confirmarPeloChat(c, envio);
    assert.equal(ligou.isError, undefined, textoDe(ligou));
    mkdirSync(join(m.dir, "Documents"), { recursive: true });
    const arquivo = join(m.dir, "Documents", "a.pdf");
    writeFileSync(arquivo, "%PDF-1.4 x");
    const casos: Array<[string, Record<string, unknown>]> = [
      ["wa_responder", { conversa: ANA, texto: "Chego às 8" }],
      ["wa_enviar_arquivo", { conversa: ANA, arquivo }],
      ["wa_escolher_grupos", { adicionar: [GRUPO] }],
      ["wa_bloquear_conversas", { liberar: [pn(BLOQUEADO)] }],
      ["wa_iniciar_conversa", { numero: "5531999990000", texto: "oi" }],
      ["wa_desconectar", {}],
    ];
    for (const [nome, args] of casos) {
      const r = await chamarCru(c, nome, args);
      await conferirResultado(c, nome, r);
    }
  });

  it("wa_parear (sem sessão): o mesmo, e o caminho do chat continua funcionando", async () => {
    const { c } = await cenario(false);
    const r = await chamarCru(c, "wa_parear");
    await conferirResultado(c, "wa_parear", r);
  });

  it("o caminho do chat (o que o cartão manda na aba Code) confirma; o clique pelo cartão (wa_confirmar_tela) também", async () => {
    const { c, s } = await cenario();
    await ligarEnvio(c);
    const previa = await chamarCru(c, "wa_responder", { conversa: ANA, texto: "pelo chat" });
    const r = await confirmarPeloChat(c, previa);
    assert.equal(r.isError, undefined, textoDe(r));
    const outra = await chamarCru(c, "wa_responder", { conversa: ANA, texto: "pelo botão" });
    assert.equal((await clicar(c, outra)).isError, undefined);
    assert.equal(s!.chamadas.filter((x) => x.metodo === "sendMessage").length, 2);
  });

  it("wa_confirmar com o código de tela é recusado e conta como tentativa (na terceira, cancela)", async () => {
    const { c } = await cenario();
    const previa = await chamarCru(c, "wa_envio", { ligar: true });
    const { id, codigo } = pedidoDa(previa);
    for (let i = 1; i <= 3; i++) assert.equal((await chamarCru(c, "wa_confirmar", { id, codigo })).isError, true);
    const depois = await confirmarPeloChat(c, previa);
    assert.equal(depois.isError, true);
    assert.match(textoDe(depois), /cancelado/);
  });

  it("wa_confirmar_tela não aparece para o modelo (visibility [\"app\"]); wa_confirmar aparece", async () => {
    const { c } = await cenario();
    const ferramentas = (await c.listTools()).tools as Array<{ name: string; _meta?: Record<string, unknown> }>;
    const visivel = (nome: string) => {
      const f = ferramentas.find((x) => x.name === nome)!;
      return ((f._meta?.ui as { visibility?: string[] } | undefined)?.visibility ?? ["model", "app"]).includes("model");
    };
    assert.equal(visivel("wa_confirmar_tela"), false);
    assert.deepEqual((ferramentas.find((x) => x.name === "wa_confirmar_tela")!._meta?.ui as { visibility: string[] }).visibility, ["app"]);
    assert.equal(visivel("wa_confirmar"), true);
  });
});
