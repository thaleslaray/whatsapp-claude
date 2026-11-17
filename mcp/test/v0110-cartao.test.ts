// 0.11.0: o cartão que apareceu como texto cru (JSON) no uso real (wa_responder duas vezes, wa_escolher_grupos uma).
// Procurado no código o que poderia fazer o cliente não desenhar a tela, comparando campo a campo a mesma ferramenta de
// cartão chamada direto no dono, vinda pelo canal do leitor e logo depois da partida: o anúncio da ferramenta
// (`_meta.ui.resourceUri` no tools/list), o HTML do cartão (resources/read nos dois endereços) e a resposta
// (`content`, `structuredContent`, `_meta`). Tudo igual: a causa não está nesses caminhos. Fica o diagnóstico barato na
// caixa-preta (evento `cartao_respondido`, sem conteúdo) e a frase no `para_o_claude` (chamar de novo se não aparecer).
// Sem rede, socket falso, dois Contexto na mesma pasta.

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { CaixaPreta } from "../src/caixa-preta.ts";
import { URI_TELA, URI_TELA_FIXA } from "../src/escrita.ts";
import { ANA, assentar, chamarCru, conectar, conectarCliente, GRUPO, ligarEnvio, montar, OUTRO_GRUPO, pn, type Montagem, type Resultado } from "./ajuda.ts";
import { msg } from "./socket-falso.ts";

type Cliente = Awaited<ReturnType<typeof conectarCliente>>["cliente"];
type Obj = Record<string, unknown>;

const montagens: Montagem[] = [];
const fechamentos: Array<() => Promise<void>> = [];
const pastas: string[] = [];
afterEach(async () => {
  for (const f of fechamentos.splice(0).reverse()) await f();
  for (const mm of montagens.splice(0).reverse()) await mm.ctx.encerrar();
  for (const p of pastas.splice(0)) rmSync(p, { recursive: true, force: true });
});

async function cliente(mm: Montagem): Promise<Cliente> {
  const { cliente: c, fechar } = await conectarCliente(mm.ctx);
  fechamentos.push(fechar);
  return c;
}

/** Linhas da caixa-preta (só na memória: a saída de cada evento). */
function caixa(): { cp: CaixaPreta; eventos: (nome: string) => Obj[]; linhas: string[] } {
  const linhas: string[] = [];
  const cp = new CaixaPreta({ saida: (l) => linhas.push(l) });
  return {
    cp,
    linhas,
    eventos: (nome) => linhas.map((l) => JSON.parse(l.slice(l.indexOf("{"))) as Obj).filter((l) => l.evento === nome),
  };
}

const GRUPOS = { [GRUPO]: { id: GRUPO, subject: "Família", size: 5, participants: [] }, [OUTRO_GRUPO]: { id: OUTRO_GRUPO, subject: "Condomínio", size: 30, participants: [] } };

async function donoELeitor() {
  const cxDono = caixa();
  const cxLeitor = caixa();
  const dono = await montar({ caixaPreta: cxDono.cp });
  montagens.push(dono);
  pastas.push(dono.dir);
  const s = await conectar(dono, { grupos: GRUPOS });
  s.mensagens([msg({ jid: pn(ANA), id: "A1", texto: "Que horas você chega?", nome: "Ana" })]);
  await assentar(dono);
  const leitor = await montar({ dir: dono.dir, pareada: false, caixaPreta: cxLeitor.cp });
  montagens.push(leitor);
  await leitor.ctx.partida();
  assert.equal(leitor.ctx.papel, "leitor");
  const cDono = await cliente(dono);
  const cLeitor = await cliente(leitor);
  await ligarEnvio(cDono);
  return { dono, leitor, s, cDono, cLeitor, cxDono, cxLeitor };
}

/** A resposta de cartão sem o que muda a cada pedido (id, código, validade): o resto tem de ser idêntico. */
function forma(r: Resultado): Obj {
  const id = String(r.structuredContent?.pedido ?? "");
  const tirarId = (v: unknown): unknown => JSON.parse(JSON.stringify(v).split(id).join("<id>"));
  const meta = { ...(r._meta ?? {}) } as Obj;
  const previa = { ...((meta.previa as Obj | undefined) ?? {}) };
  delete previa.valido_ate;
  return {
    chaves_do_resultado: Object.keys(r).sort(),
    isError: r.isError ?? false,
    content: tirarId(r.content),
    structuredContent: tirarId(r.structuredContent),
    chaves_do_meta: Object.keys(meta).sort(),
    codigo_e_texto: typeof meta.codigo === "string" && (meta.codigo as string).length > 0,
    previa,
  };
}

async function anuncio(c: Cliente, nome: string): Promise<unknown> {
  const { tools } = await c.listTools();
  return tools.find((t) => t.name === nome)?._meta;
}

describe("0.11.0: a resposta de cartão é a mesma em todos os caminhos", () => {
  it("wa_responder e wa_escolher_grupos: direto no dono e pelo canal do leitor, campo a campo", async () => {
    const { cDono, cLeitor } = await donoELeitor();
    for (const [nome, args] of [
      ["wa_responder", { conversa: pn(ANA), texto: "chego às 8" }],
      ["wa_escolher_grupos", { adicionar: [OUTRO_GRUPO] }],
    ] as const) {
      const direto = await chamarCru(cDono, nome, args);
      const peloLeitor = await chamarCru(cLeitor, nome, args);
      assert.equal(direto.isError, undefined, JSON.stringify(direto));
      assert.deepEqual(forma(peloLeitor), forma(direto), nome);
      // O cartão desenha a partir do anúncio da ferramenta: o mesmo endereço nos dois processos.
      const a1 = await anuncio(cDono, nome);
      assert.deepEqual(await anuncio(cLeitor, nome), a1);
      assert.deepEqual(a1, { ui: { resourceUri: URI_TELA }, "ui/resourceUri": URI_TELA });
      // A frase nova do para_o_claude.
      assert.match(String(direto.structuredContent!.para_o_claude), /Se o cartão não aparecer .* chame a mesma ferramenta de novo/);
    }
  });

  it("o HTML do cartão é o mesmo nos dois processos e nos dois endereços", async () => {
    const { cDono, cLeitor } = await donoELeitor();
    const ler = async (c: Cliente, uri: string) => (await c.readResource({ uri })).contents[0] as Obj;
    const base = await ler(cDono, URI_TELA);
    assert.equal(typeof base.text, "string");
    for (const [c, uri] of [[cDono, URI_TELA_FIXA], [cLeitor, URI_TELA], [cLeitor, URI_TELA_FIXA]] as const) {
      const r = await ler(c, uri);
      assert.equal(r.text, base.text);
      assert.equal(r.mimeType, base.mimeType);
      assert.deepEqual(r._meta, base._meta);
    }
  });

  it("logo depois da partida: a chamada que chega antes de o papel ser decidido dá a mesma resposta, e o cartão já está registrado", async () => {
    const { dono, cDono } = await donoELeitor();
    const direto = await chamarCru(cDono, "wa_responder", { conversa: pn(ANA), texto: "chego às 8" });
    const novo = await montar({ dir: dono.dir, pareada: false });
    montagens.push(novo);
    const c = await cliente(novo);
    // Antes da partida acabar: o recurso de UI já existe (registrado na criação do servidor, antes de conectar).
    const recursos = (await c.listResources()).resources.map((r) => r.uri);
    assert.ok(recursos.includes(URI_TELA) && recursos.includes(URI_TELA_FIXA), recursos.join(","));
    const partida = novo.ctx.partida();
    const cedo = await chamarCru(c, "wa_responder", { conversa: pn(ANA), texto: "chego às 8" });
    await partida;
    assert.deepEqual(forma(cedo), forma(direto));
  });
});

describe("0.11.0: diagnóstico do cartão na caixa-preta (sem conteúdo)", () => {
  it("cada resposta de cartão vira `cartao_respondido`: direto, pelo canal e repassado; se o cliente já leu o HTML; nada de conteúdo", async () => {
    const { cDono, cLeitor, cxDono, cxLeitor } = await donoELeitor();
    await chamarCru(cDono, "wa_responder", { conversa: pn(ANA), texto: "segredo 5511912345678 chego às 8" });
    await cDono.readResource({ uri: URI_TELA_FIXA });
    await chamarCru(cDono, "wa_responder", { conversa: pn(ANA), texto: "de novo" });
    await chamarCru(cLeitor, "wa_responder", { conversa: pn(ANA), texto: "pelo leitor" });
    await chamarCru(cDono, "wa_estado");
    const doDono = cxDono.eventos("cartao_respondido");
    // wa_envio (ligar), as duas respostas diretas e a que veio pelo canal.
    const diretos = doDono.filter((e) => e.via === "direto");
    assert.deepEqual(diretos.map((e) => [e.ferramenta, e.tela_lida_nesta_sessao, e.endereco_lido]), [
      ["wa_envio", false, null],
      ["wa_responder", false, null],
      ["wa_responder", true, "fixo"],
    ]);
    const pelaCanal = doDono.filter((e) => e.via === "pelo_canal");
    assert.equal(pelaCanal.length, 1);
    assert.equal(pelaCanal[0]!.tela_lida_nesta_sessao, null);
    const doLeitor = cxLeitor.eventos("cartao_respondido");
    assert.equal(doLeitor.length, 1);
    assert.equal(doLeitor[0]!.via, "repassado_ao_dono");
    assert.equal(doLeitor[0]!.papel, "leitor");
    for (const e of [...doDono, ...doLeitor]) {
      assert.equal(e.com_tela, true);
      assert.equal(e.meta_na_resposta, true);
      assert.ok(e.forma === "previa" || e.forma === "cartao_sem_previa", String(e.forma));
      assert.equal(typeof e.tamanho, "number");
    }
    // Leitura não deixa evento de cartão; e nenhum conteúdo, número, id de pedido ou código.
    assert.ok(!doDono.some((e) => e.ferramenta === "wa_estado"));
    const tudo = [...cxDono.linhas, ...cxLeitor.linhas].join("\n");
    for (const proibido of ["segredo", "chego", "pelo leitor", "5511912345678", ANA, "Ana", "codigo", "pedido"]) assert.ok(!tudo.includes(proibido), `vazou: ${proibido}`);
  });

  it("sem tela no cliente (\"Bloqueado\") e erro antes da prévia também ficam registrados, com a forma", async () => {
    const { dono, cDono, cxDono } = await donoELeitor();
    const { cliente: semTela, fechar } = await conectarCliente(dono.ctx, { comTela: false });
    fechamentos.push(fechar);
    await chamarCru(semTela, "wa_responder", { conversa: pn(ANA), texto: "oi" });
    await chamarCru(cDono, "wa_responder", { conversa: "5511900000000", texto: "oi" });
    const formas = cxDono.eventos("cartao_respondido").slice(-2).map((e) => [e.forma, e.com_tela, e.meta_na_resposta]);
    assert.deepEqual(formas, [
      ["bloqueado", false, false],
      ["erro", true, false],
    ]);
  });
});
