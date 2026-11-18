// O cartão: endereços (com versão e o apelido fixo), as duas chaves do resourceUri, a visibilidade das ferramentas da
// tela, o HTML (rodapé com a versão, "Ver detalhes", texto editável), e a lógica da tela sem DOM: texto editável,
// cartão recriado que se ajusta e acompanhamento do QR.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { codigoDoTextoEditado } from "../src/confirmacao.ts";
import { URI_TELA, URI_TELA_FIXA } from "../src/escrita.ts";
import { HTML_CONFIRMAR } from "../src/ui-gerada.ts";
import { VERSAO_SERVIDOR } from "../src/versao.ts";
import { codigoEditado, dataCurta, destinatario, mensagemDeConfirmacao, podeEnviar, rotuloDoContador, separarDetalhes, ultimasParaMostrar } from "../ui/edicao.js";
import { acompanharPareamento, etapaFinal, fraseDaEtapa, INSTRUCAO_DO_CELULAR, lerEtapa, rotuloDaContagem, segundosQueFaltam } from "../ui/pareamento.js";
import { aguardarEnvio, planoDaSituacao } from "../ui/situacao.js";
import { ANA, assentar, chamarCru, clicar, conectar, conectarCliente, ligarEnvio, montar, pedidoDa, pn, type Montagem } from "./ajuda.ts";
import { msg } from "./socket-falso.ts";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
let m: Montagem | undefined;
let fecharCliente: (() => Promise<void>) | undefined;
afterEach(async () => {
  await fecharCliente?.();
  fecharCliente = undefined;
  await m?.fechar();
  m = undefined;
});

async function cliente() {
  m = await montar();
  const s = await conectar(m);
  s.mensagens([msg({ jid: pn(ANA), id: "A1", texto: "oi", nome: "Ana" })]);
  await assentar(m);
  const { cliente: c, fechar } = await conectarCliente(m.ctx);
  fecharCliente = fechar;
  return c;
}

describe("endereço e registro do cartão", () => {
  it("versão no endereço (sem pontos no caminho) e o apelido fixo para sempre", () => {
    assert.equal(URI_TELA, `ui://whatsapp/confirmar-v${VERSAO_SERVIDOR.replaceAll(".", "-")}.html`);
    assert.match(URI_TELA.slice("ui://whatsapp/".length), /^confirmar-v[0-9-]+\.html$/);
    assert.equal(URI_TELA_FIXA, "ui://whatsapp/confirmar.html");
  });

  it("a versão do servidor é a do package.json (a do rodapé do cartão)", () => {
    const pacote = JSON.parse(readFileSync(join(RAIZ, "package.json"), "utf8")) as { version: string };
    assert.equal(VERSAO_SERVIDOR, pacote.version);
    assert.ok(HTML_CONFIRMAR.includes(`v${VERSAO_SERVIDOR}</p>`), "rodapé com a versão");
  });

  it("toda ferramenta com cartão manda as duas chaves (_meta.ui.resourceUri e ui/resourceUri); as da tela ficam escondidas do modelo", async () => {
    const c = await cliente();
    const ferramentas = (await c.listTools()).tools as Array<{ name: string; _meta?: Record<string, unknown> }>;
    const comCartao = ["wa_parear", "wa_envio", "wa_responder", "wa_desconectar"];
    const daTela = ["wa_confirmar_tela", "wa_cancelar_pedido", "wa_estado_pedido_tela", "wa_estado_pareamento_tela"];
    for (const nome of [...comCartao, ...daTela]) {
      const f = ferramentas.find((x) => x.name === nome)!;
      assert.equal((f._meta?.ui as { resourceUri?: string }).resourceUri, URI_TELA, `${nome}: _meta.ui.resourceUri`);
      assert.equal(f._meta?.["ui/resourceUri"], URI_TELA, `${nome}: chave antiga`);
    }
    const visiveis = ferramentas.filter((f) => ((f._meta?.ui as { visibility?: string[] } | undefined)?.visibility ?? ["model", "app"]).includes("model")).map((f) => f.name);
    for (const nome of daTela) {
      assert.ok(!visiveis.includes(nome), `${nome} não pode ser visível ao modelo`);
      assert.deepEqual((ferramentas.find((x) => x.name === nome)!._meta?.ui as { visibility: string[] }).visibility, ["app"]);
    }
    for (const nome of [...comCartao, "wa_confirmar", "wa_cancelar", "wa_estado"]) assert.ok(visiveis.includes(nome), `${nome} deveria estar visível`);
  });

  it("o cartão é servido nos dois endereços, igual, como MCP App", async () => {
    const c = await cliente();
    const uris = (await c.listResources()).resources.map((r) => r.uri);
    assert.ok(uris.includes(URI_TELA) && uris.includes(URI_TELA_FIXA));
    const novo = (await c.readResource({ uri: URI_TELA })).contents as Array<{ mimeType?: string; text?: string; _meta?: unknown }>;
    const fixo = (await c.readResource({ uri: URI_TELA_FIXA })).contents as Array<{ mimeType?: string; text?: string; _meta?: unknown }>;
    assert.equal(novo[0]?.mimeType, RESOURCE_MIME_TYPE);
    assert.equal(fixo[0]?.text, novo[0]?.text);
    assert.deepEqual(fixo[0]?._meta, novo[0]?._meta);
    const html = novo[0]?.text ?? "";
    for (const trecho of [
      "wa_confirmar_tela", "wa_cancelar_pedido", "wa_estado_pedido_tela", "wa_estado_pareamento_tela", "serverTools",
      "Confirmo o pedido ", "Cancelo o pedido ", "NÃO TEM VOLTA", "Ver detalhes", "você pode editar", "Clique uma vez e espere",
      "Aparelhos conectados > Conectar aparelho", "prefers-color-scheme: dark", "--color-background-primary",
    ]) {
      assert.ok(html.includes(trecho), `o cartão não contém "${trecho}"`);
    }
  });
});

describe("texto editável no cartão", () => {
  it("contador, limite em caracteres (emoji conta 1) e Enviar desligado com texto vazio ou grande", () => {
    assert.equal(rotuloDoContador("abc 😀", 4096, "caracteres"), "5 de 4096 caracteres");
    assert.equal(podeEnviar("", 4096, "caracteres"), false);
    assert.equal(podeEnviar("  \n", 4096, "caracteres"), false);
    assert.equal(podeEnviar("😀".repeat(4096), 4096, "caracteres"), true);
    assert.equal(podeEnviar("😀".repeat(4097), 4096, "caracteres"), false);
  });

  it("o código editado do cartão é o mesmo que o servidor espera", () => {
    const codigo = "0123456789abcdef0123456789abcdef";
    const texto = "Olá 😀\nsegunda linha";
    const independente = createHash("sha256").update(`${codigo}\n${texto}`, "utf8").digest("hex").slice(0, 32);
    assert.equal(codigoEditado(codigo, texto), independente);
    assert.equal(codigoDoTextoEditado(codigo, texto), independente);
  });

  it("mensagem da aba Code (sem serverTools), com e sem texto editado", () => {
    assert.equal(mensagemDeConfirmacao("ab12", "c0d1", null), "Confirmo o pedido ab12, código c0d1.");
    assert.equal(mensagemDeConfirmacao("ab12", "c0d1", "novo"), "Confirmo o pedido ab12, código c0d1, com este texto:\nnovo");
  });

  it("para quem, últimas recebidas, data curta e \"Ver detalhes\"", () => {
    assert.equal(destinatario({ alvo: "+55 11 91234-5678 · c_1", conteudo_de_terceiros: { nome: "Ana" } }), "Ana (+55 11 91234-5678 · c_1)");
    assert.equal(destinatario({ alvo: "este Mac" }), "este Mac");
    assert.deepEqual(ultimasParaMostrar({ conteudo_de_terceiros: { ultimas_recebidas: [{ data: "x", texto: "a" }, { texto: 3 }] } }), [{ data: "x", texto: "a" }]);
    assert.match(dataCurta("2026-11-12T10:05:00.000Z"), /^\d{2}\/11 \d{2}:05$/);
    assert.equal(dataCurta("lixo"), "");
    assert.deepEqual(separarDetalhes(["Aviso: cuidado", "a", "b"]), { aVista: ["Aviso: cuidado"], recolhidas: ["a", "b"] });
    assert.deepEqual(separarDetalhes(["só uma"]), { aVista: ["só uma"], recolhidas: [] });
  });
});

describe("o cartão recriado pelo app se ajusta", () => {
  it("pergunta o estado do pedido e decide: pendente fica; enviado trava e diz que já foi; cancelado e vencido travam", async () => {
    const c = await cliente();
    await ligarEnvio(c);
    const previa = await chamarCru(c, "wa_responder", { conversa: ANA, texto: "oi" });
    const { id } = pedidoDa(previa);
    const consultar = () => chamarCru(c, "wa_estado_pedido_tela", { id });

    assert.equal(planoDaSituacao(await consultar(), "responder").acao, "nada", "pendente: o cartão fica como está");
    await clicar(c, previa);
    const depois = await consultar();
    assert.equal(depois.structuredContent!.estado, "usado");
    assert.equal(depois.structuredContent!.tipo, "responder");
    const plano = planoDaSituacao(depois, "responder");
    assert.deepEqual(plano, { acao: "feito", mensagem: "Esta resposta já foi enviada.", tipo: "ok" });
    assert.equal((await clicar(c, previa)).isError, true, "e o servidor recusa um segundo clique");

    const outra = await chamarCru(c, "wa_responder", { conversa: ANA, texto: "outra" });
    await chamarCru(c, "wa_cancelar_pedido", { id: pedidoDa(outra).id });
    assert.equal(planoDaSituacao(await chamarCru(c, "wa_estado_pedido_tela", { id: pedidoDa(outra).id })).acao, "travar");
    assert.equal(planoDaSituacao(await chamarCru(c, "wa_estado_pedido_tela", { id: "naoexiste" })).acao, "travar");

    const envio = await chamarCru(c, "wa_envio", { ligar: false });
    await clicar(c, envio);
    assert.equal(planoDaSituacao(await chamarCru(c, "wa_estado_pedido_tela", { id: pedidoDa(envio).id })).mensagem, "O envio já está desligado.");
  });

  it("pareamento já confirmado: o cartão recriado volta a acompanhar o QR", () => {
    const plano = planoDaSituacao({ structuredContent: { estado: "usado", tipo: "parear", resultado: {} } }, "parear");
    assert.equal(plano.acao, "parear");
    assert.equal(planoDaSituacao({ isError: true }).acao, "nada", "consulta que falhou: o cartão fica como está");
  });

  it("\"enviando\": espera de 2 em 2 s até voltar", async () => {
    let agora = 0;
    const respostas = [{ structuredContent: { estado: "enviando" } }, { structuredContent: { estado: "usado", tipo: "responder" } }];
    let i = 0;
    const fim = await aguardarEnvio({ consultar: async () => respostas[i++], esperar: async (ms) => void (agora += ms), agora: () => agora });
    assert.equal((fim as { structuredContent: { estado: string } }).structuredContent.estado, "usado");
    assert.equal(agora, 4000);
  });
});

describe("acompanhamento do QR no cartão", () => {
  it("lê a etapa, a matriz do QR (validada) e a contagem", () => {
    const matriz = { tamanho: 21, linhas: Array.from({ length: 21 }, (_, i) => (i % 2 ? "1" : "0").repeat(21)) };
    const e = lerEtapa({ structuredContent: { etapa: "qr", segundos_restantes: 42.7 }, _meta: { qr_matriz: matriz } })!;
    assert.deepEqual(e, { etapa: "qr", matriz, segundos: 42, conectadoComo: "", mensagem: "" });
    assert.equal(lerEtapa({ structuredContent: { etapa: "qr" }, _meta: { qr_imagem: "data:image/svg+xml;base64,PHN2Zy8+" } })!.matriz, null, "imagem não vale mais");
    assert.equal(lerEtapa({ structuredContent: { etapa: "qr" }, _meta: { qr_matriz: { tamanho: 21, linhas: ["x"] } } })!.matriz, null, "matriz inválida");
    assert.equal(lerEtapa({ structuredContent: { etapa: "outra" } }), null);
    assert.equal(segundosQueFaltam(60, 1_000, 21_500), 40);
    assert.equal(segundosQueFaltam(5, 0, 10_000), 0);
    assert.equal(rotuloDaContagem(40), "Este QR vale mais 40 s; depois aparece outro sozinho.");
    assert.equal(fraseDaEtapa(e), INSTRUCAO_DO_CELULAR);
    assert.match(INSTRUCAO_DO_CELULAR, /WhatsApp > Configurações > Aparelhos conectados > Conectar aparelho/);
    assert.equal(fraseDaEtapa({ etapa: "conectado", matriz: null, segundos: 0, conectadoComo: "+55 11 98888-7777 (Dono)", mensagem: "" }), "Conectado como +55 11 98888-7777 (Dono).");
    assert.ok(etapaFinal("conectado") && etapaFinal("expirado") && !etapaFinal("qr"));
  });

  it("consulta de 2 em 2 s até conectar, mostrando cada etapa", async () => {
    let agora = 0;
    const etapas = ["gerando_qr", "qr", "qr", "conectando", "conectado"];
    let i = 0;
    const vistas: string[] = [];
    const fim = await acompanharPareamento({
      consultar: async () => ({ structuredContent: { etapa: etapas[i++] }, _meta: {} }),
      mostrar: (e) => vistas.push(e.etapa),
      esperar: async (ms) => void (agora += ms),
      agora: () => agora,
    });
    assert.equal(fim!.etapa, "conectado");
    assert.deepEqual(vistas, etapas);
    assert.equal(agora, 8000);
  });

  it("para depois de 5 falhas seguidas ou quando o cartão é recriado", async () => {
    let n = 0;
    const fim = await acompanharPareamento({
      consultar: async () => {
        n++;
        throw new Error("sem servidor");
      },
      mostrar: () => {},
      esperar: async () => {},
      agora: () => 0,
    });
    assert.equal(fim, null);
    assert.equal(n, 5);
    let cancelado = false;
    let consultas = 0;
    await acompanharPareamento({
      consultar: async () => {
        consultas++;
        cancelado = true;
        return { structuredContent: { etapa: "qr" } };
      },
      mostrar: () => {},
      esperar: async () => {},
      agora: () => 0,
      cancelado: () => cancelado,
    });
    assert.equal(consultas, 1);
  });
});
