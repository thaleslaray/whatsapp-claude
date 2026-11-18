// Confirmação pelo cartão no chat (adaptado do MCP do Instagram, src/ferramentas/confirmacao.ts):
// - o cartão (resource ui://), servido no endereço com versão e no apelido fixo;
// - wa_confirmar e wa_cancelar: visíveis ao modelo; wa_confirmar só funciona com o código que chegou numa mensagem do dono.
//   Numa resposta (texto editável), a mensagem do dono SEMPRE traz o texto e o código preso a ele, editado ou não;
//   o wa_confirmar recusa o código sem o texto. O código cru só vale pelo wa_confirmar_tela (do cartão);
// - wa_confirmar_tela, wa_cancelar_pedido, wa_estado_pedido_tela e wa_estado_pareamento_tela: `visibility: ["app"]`,
//   chamadas direto pelo cartão. A última entrega o QR ao cartão (só no `_meta`): o modelo nunca o vê.
//
// Pareamento pela aba Code (0.5.0). Lá o cartão não tem `serverTools`: não chama wa_confirmar_tela nem consulta o
// estado. Então:
// - o botão do aviso de risco manda no chat "Confirmo o pedido <id>, código <codigo>." (o código só existe no `_meta`);
// - o wa_confirmar de um pedido de pareamento começa o pareamento (a mesma ação do clique), espera o primeiro QR (uns
//   20 s) e devolve um resultado que desenha o CARTÃO (wa_confirmar anuncia o `resourceUri`), com a matriz do QR só no
//   `_meta`; no `structuredContent` e no texto vão só a etapa, os segundos e a instrução ao modelo;
// - o cartão mostra o QR com a contagem e os botões "Mostrar novo QR" (mensagem no chat -> o modelo chama wa_qr) e
//   "Já escaneei" (mensagem no chat -> o modelo confere com wa_estado);
// - wa_qr (visível ao modelo) só funciona com um pareamento já autorizado por clique, nunca começa um e nunca devolve
//   o QR ao modelo: devolve outro cartão com o QR atual no `_meta`.
// O QR vai ao cartão como MATRIZ (tamanho e linhas de 0/1, gerada aqui com a `qrcode`), e o cartão desenha um <svg> no
// próprio DOM (ui/qr.js), como o Nod faz com o QRCodeSVG. Nada de imagem em data URL.

import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import QRCode from "qrcode";
import * as z from "zod/v4";
import type { CaminhoDeConfirmacao } from "../confirmacao.ts";
import type { Contexto } from "../contexto.ts";
import { URI_TELA, URI_TELA_FIXA } from "../escrita.ts";
import { formatarNumero } from "../jid.ts";
import { ANOTACOES_LEITURA, registrarApoioDeConfirmacao, registrarComCartao, textoDoErro } from "../respostas.ts";
import { limpar, limparProfundo } from "../segredos.ts";
import { HTML_CONFIRMAR } from "../ui-gerada.ts";
import { mensagemJaEscaneei, mensagemNovoQr } from "../../ui/pareamento.js";

// Argumentos estritos: nada além de id, código e, numa resposta, o `texto` que o dono viu (editado ou não).
// O servidor só aceita um `texto` cujo código seja SHA-256(código do pedido + "\n" + texto): o modelo nunca vê o
// código cru do pedido (nem no chat: o cartão manda só o código preso ao texto), então não consegue aprovar um texto
// que o dono não viu.
const EntradaConfirmar = z.strictObject({
  id: z.string().min(1).max(64).describe("Id do pedido, o mesmo da prévia"),
  codigo: z.string().min(1).max(128).describe("Código que chegou numa mensagem do dono depois do clique dele. Nunca peça nem adivinhe."),
  texto: z
    .string()
    .max(400_000)
    .optional()
    .describe("O texto que veio na mensagem do dono (toda confirmação de resposta traz o texto); copie exatamente, sem mudar nada. Sem texto na mensagem, não passe"),
});
const EntradaId = z.strictObject({ id: z.string().min(1).max(64).describe("Id do pedido") });
const EntradaQr = z.strictObject({
  pedido: z.string().min(1).max(64).optional().describe("Id do pedido de pareamento (vem na mensagem do cartão). Sem ele, o último pareamento autorizado"),
});

const ESCRITA_SEM_VOLTA = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;
const CANCELAR = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export type EtapaDoPareamento = "aguardando_clique" | "gerando_qr" | "qr" | "conectando" | "conectado" | "expirado" | "parado" | "inexistente";

/** O QR como matriz: `tamanho` módulos por lado e uma linha de "0"/"1" por fileira ("1" = escuro). */
export interface MatrizDoQr {
  tamanho: number;
  linhas: string[];
}

/**
 * A matriz do QR da Baileys (nível de correção L, como o QRCodeSVG do Nod), gerada aqui no servidor. Vai só no `_meta`
 * (o cartão desenha); o texto do QR não sai em lugar nenhum.
 */
let ultimaMatriz: { qr: string; matriz: MatrizDoQr } | undefined;
export function matrizDoQr(qr: string): MatrizDoQr {
  if (ultimaMatriz?.qr === qr) return ultimaMatriz.matriz;
  const { modules } = QRCode.create(qr, { errorCorrectionLevel: "L" });
  const linhas: string[] = [];
  for (let y = 0; y < modules.size; y++) {
    let linha = "";
    for (let x = 0; x < modules.size; x++) linha += modules.get(y, x) ? "1" : "0";
    linhas.push(linha);
  }
  const matriz = { tamanho: modules.size, linhas };
  ultimaMatriz = { qr, matriz };
  return matriz;
}

/** Como está o pareamento de um pedido: a etapa, uma frase curta, os campos do `structuredContent` e, na etapa "qr", a matriz. */
interface SituacaoDoPareamento {
  etapa: EtapaDoPareamento;
  frase: string;
  extra: Record<string, unknown>;
  matriz?: MatrizDoQr;
}

const PARE_DE_NOVO = "Este cartão não vale mais. Peça ao Claude para parear de novo.";

/** Aviso a quem usa o app, no resultado que desenha o cartão do QR (visto cru só quando o cartão não aparece). */
export const AVISO_DO_CARTAO_DO_QR =
  'Para quem usa o Claude Desktop: se este texto apareceu no lugar do cartão com o QR, o cartão não carregou e o QR não aparece por aqui (por segurança, ele nunca vai para o chat). Peça "mostre um novo QR do pareamento"; se continuar, feche o Claude Desktop e abra de novo.';

/** A instrução ao modelo em cada etapa do cartão do QR. Vai no `structuredContent` (na aba Code, só ele chega ao modelo). */
function instrucaoDoQr(id: string, s: SituacaoDoPareamento): string {
  const mensagens =
    `Se chegar a mensagem "${mensagemNovoQr(id)}", chame wa_qr com pedido "${id}". ` +
    `Se chegar "${mensagemJaEscaneei(id)}", chame wa_estado para conferir se conectou. Não chame wa_parear de novo.`;
  switch (s.etapa) {
    case "qr":
      return (
        `O QR do pareamento está no cartão; você não vê o QR, e não precisa. Diga ao dono, em uma frase, para ler o QR com o celular ` +
        `(WhatsApp > Configurações > Aparelhos conectados > Conectar um aparelho) antes de ele vencer (${String(s.extra.segundos_restantes ?? 0)} s). ${mensagens}`
      );
    case "gerando_qr":
      return `O pareamento começou, mas o QR ainda não chegou. Diga ao dono para clicar em "Mostrar novo QR" no cartão daqui a pouco. ${mensagens}`;
    case "conectando":
      return "O celular já leu o QR e a conexão está terminando. Chame wa_estado daqui a alguns segundos para conferir.";
    case "conectado":
      return `${s.frase} O pareamento terminou. O envio de respostas começa desligado.`;
    default:
      return `${s.frase} Nada ficou salvo. Se o dono quiser tentar de novo, chame wa_parear (novo aviso de risco e novo clique).`;
  }
}

export function registrarConfirmacao(server: McpServer, ctx: Contexto): void {
  // O mesmo cartão em dois endereços: o com versão (anunciado) e o apelido fixo (que o Claude Desktop guarda e pede).
  for (const [nome, uri] of [
    ["Confirmar no WhatsApp", URI_TELA],
    ["Confirmar no WhatsApp (endereço fixo)", URI_TELA_FIXA],
  ] as const) {
    registerAppResource(
      server,
      nome,
      uri,
      { description: "Cartão com a prévia (para quem, últimas mensagens recebidas, texto editável) e os botões Cancelar e de ação; no pareamento, o aviso de risco e o QR." },
      async () => {
        // 0.11.0: o diagnóstico do cartão quer saber se o cliente desta sessão já leu o HTML do cartão.
        ctx.telaLida(server, uri);
        return { contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: HTML_CONFIRMAR, _meta: { ui: { prefersBorder: true } } }] };
      },
    );
  }

  async function confirmar(id: string, codigo: string, caminho: CaminhoDeConfirmacao, texto?: string): Promise<CallToolResult> {
    let decisao;
    try {
      decisao = await ctx.pedidos.confirmar(id, codigo, caminho, texto);
    } catch (erro) {
      const motivo = `Não deu certo: ${textoDoErro(erro)}`;
      return { isError: true, content: [{ type: "text", text: motivo }], structuredContent: { pedido: id, estado: "falhou", erro: motivo } };
    }
    if (!decisao.ok) return { isError: true, content: [{ type: "text", text: decisao.motivo }], structuredContent: { pedido: id, erro: decisao.motivo } };
    if (caminho === "wa_confirmar" && ctx.pedidos.tipo(id) === "parear") {
      // Aba Code: o cartão não consegue consultar o servidor. Espera o primeiro QR e devolve o cartão já com ele.
      await ctx.esperarQr();
      return cartaoDoQr(id, await situacaoDoPareamento(id), { estado: "feito" });
    }
    const dados = limparProfundo({ pedido: id, estado: "feito", resultado: decisao.resultado });
    const frase = typeof decisao.resultado.frase === "string" ? decisao.resultado.frase : `Pronto (pedido ${id}): ${decisao.resumo}.`;
    return { content: [{ type: "text", text: limpar(frase) }], structuredContent: dados };
  }

  async function cancelar(id: string, origem: string): Promise<CallToolResult> {
    const r = await ctx.pedidos.cancelar(id, origem);
    return { ...(r.ok ? {} : { isError: true }), content: [{ type: "text", text: r.mensagem }], structuredContent: { pedido: id, mensagem: r.mensagem } };
  }

  // O resultado do wa_confirmar desenha o cartão: no pareamento, é o cartão com o QR (aba Code); nos outros pedidos, o
  // cartão só mostra a frase do resultado.
  registrarComCartao(
    server,
    "wa_confirmar",
    ESCRITA_SEM_VOLTA,
    {
      title: "Confirmar pedido do WhatsApp",
      description:
        "Executa de verdade um pedido que já mostrou a prévia num cartão. SÓ chame depois que o dono clicar no botão do cartão e uma mensagem dele trouxer o id e o código " +
        '("Confirmo o pedido <id>, código <codigo>."). Nunca peça o código a ele nem tente adivinhar. Executa exatamente o que estava na prévia. ' +
        'Numa resposta (wa_responder), a mensagem do dono sempre traz o texto ("Confirmo o pedido <id>, código <codigo>, com este texto:" e o texto numa linha nova), editado ou não: ' +
        "passe `texto` copiado exatamente, sem mudar nada; o código só vale junto com esse texto. O mesmo vale para wa_responder_lote (o texto é uma linha JSON com a decisão do dono: copie inteira). Nos outros pedidos a mensagem traz só o id e o código: não passe `texto`. " +
        "No pareamento (wa_parear), a confirmação começa o pareamento e desenha um cartão com o QR (você nunca vê o QR): depois siga o para_o_claude do resultado.",
      inputSchema: EntradaConfirmar,
    },
    async ({ id, codigo, texto }) => confirmar(id, codigo, "wa_confirmar", texto),
  );

  registrarApoioDeConfirmacao(
    server,
    "wa_confirmar_tela",
    ESCRITA_SEM_VOLTA,
    ["app"],
    {
      title: "Confirmar pedido (chamada do cartão)",
      description: "Chamada só pelo cartão de confirmação, quando o app do Claude deixa o cartão chamar ferramentas. Não é para o modelo.",
      inputSchema: EntradaConfirmar,
    },
    async ({ id, codigo, texto }) => confirmar(id, codigo, "wa_confirmar_tela", texto),
  );

  registrarApoioDeConfirmacao(
    server,
    "wa_cancelar_pedido",
    CANCELAR,
    ["app"],
    {
      title: "Cancelar pedido (chamada do cartão)",
      description: "Chamada só pelo cartão de confirmação, no botão Cancelar. Não é para o modelo.",
      inputSchema: EntradaId,
    },
    async ({ id }) => cancelar(id, "wa_cancelar_pedido (clique no cartão)"),
  );

  // Leitura: o cartão que o Claude Desktop recriou pergunta como está o pedido (já enviado? venceu?) e se ajusta.
  registrarApoioDeConfirmacao(
    server,
    "wa_estado_pedido_tela",
    ANOTACOES_LEITURA,
    ["app"],
    {
      title: "Estado do pedido (chamada do cartão)",
      description: "Chamada só pelo cartão de confirmação, ao abrir, para saber se o pedido já foi confirmado. Não é para o modelo.",
      inputSchema: EntradaId,
    },
    async ({ id }) => {
      const situacao = ctx.pedidos.situacao(id);
      const frases: Record<typeof situacao.estado, string> = {
        pendente: `Pedido ${id} aguardando o clique. Nada foi enviado.`,
        enviando: `Pedido ${id} confirmado; ainda não voltou.`,
        usado: `Pedido ${id} já foi confirmado.`,
        falhou: `O pedido ${id} foi confirmado, mas não deu certo.`,
        cancelado: `Pedido ${id} foi cancelado. Nada foi enviado.`,
        expirado: `Pedido ${id} venceu. Nada foi enviado.`,
        inexistente: `Pedido ${id} não existe (pode ter expirado ou o servidor reiniciou). Nada foi enviado.`,
      };
      const dados = limparProfundo({
        pedido: id,
        estado: situacao.estado,
        ...(situacao.tipo ? { tipo: situacao.tipo } : {}),
        ...(situacao.resultado ? { resultado: situacao.resultado } : {}),
      });
      return { content: [{ type: "text", text: frases[situacao.estado] }], structuredContent: dados };
    },
  );

  /** A situação do pareamento de um pedido, para o cartão (wa_estado_pareamento_tela) e para o cartão do QR (wa_confirmar, wa_qr). */
  async function situacaoDoPareamento(id: string): Promise<SituacaoDoPareamento> {
    const s = (etapa: EtapaDoPareamento, frase: string, extra: Record<string, unknown> = {}, matriz?: MatrizDoQr): SituacaoDoPareamento => ({
      etapa,
      frase,
      extra,
      ...(matriz ? { matriz } : {}),
    });
    if (ctx.pedidos.tipo(id) !== "parear") return s("inexistente", "Não há pareamento com esse pedido.", { mensagem: PARE_DE_NOVO });
    const sit = ctx.pedidos.situacao(id);
    if (sit.estado === "pendente") return s("aguardando_clique", "O pareamento ainda não foi autorizado no cartão.");
    if (sit.estado === "cancelado" || sit.estado === "expirado" || sit.estado === "inexistente") {
      return s("inexistente", "Este pedido de pareamento não vale mais.", { mensagem: PARE_DE_NOVO });
    }
    if (sit.estado === "falhou") return s("parado", "O pareamento não começou.", { mensagem: "O pareamento não começou. Peça ao Claude para parear de novo." });
    let t;
    try {
      t = ctx.exigirDono();
    } catch (erro) {
      const frase = textoDoErro(erro);
      return s("parado", frase, { mensagem: frase });
    }
    const e = t.estado();
    switch (e.situacao) {
      case "aguardando_qr": {
        const segundos = e.expira_em ? Math.max(0, Math.ceil((new Date(e.expira_em).getTime() - ctx.agora()) / 1000)) : 0;
        return s("qr", "QR pronto no cartão.", { segundos_restantes: segundos }, matrizDoQr(e.qr!));
      }
      case "conectando":
      case "reconectando":
      case "desligado":
        return e.qr_lido ? s("conectando", "QR lido; conectando.") : s("gerando_qr", "Gerando o QR.");
      case "conectado": {
        const como = `${e.numero ? formatarNumero(e.numero) : "número oculto"}${e.nome ? ` (${e.nome})` : ""}`;
        return s("conectado", `Conectado como ${como}.`, { conectado_como: como });
      }
      case "expirado":
        return s("expirado", "O pareamento venceu.", { mensagem: "O pareamento não terminou em 5 minutos; nada ficou salvo. Peça ao Claude para parear de novo." });
      default:
        return s("parado", "O pareamento parou.", { mensagem: `${e.motivo ?? "O pareamento parou."} Nada ficou salvo. Peça ao Claude para parear de novo.` });
    }
  }

  /**
   * O resultado que desenha o cartão do QR (wa_confirmar de um pareamento e wa_qr). A matriz vai SÓ no `_meta`; o
   * `structuredContent` e o texto levam a etapa, os segundos e a instrução ao modelo, nunca o QR.
   */
  function cartaoDoQr(id: string, s: SituacaoDoPareamento, extra: Record<string, unknown> = {}): CallToolResult {
    const paraOClaude = limpar(instrucaoDoQr(id, s));
    return {
      content: [{ type: "text", text: paraOClaude }],
      structuredContent: limparProfundo({ pedido: id, ...extra, etapa: s.etapa, ...s.extra, para_o_claude: paraOClaude, se_o_cartao_nao_apareceu: AVISO_DO_CARTAO_DO_QR }),
      _meta: { pareamento: { pedido: id }, ...(s.matriz ? { qr_matriz: s.matriz } : {}) },
    };
  }

  // O cartão de pareamento (com serverTools) consulta aqui de 2 em 2 s depois do clique. A matriz do QR vai SÓ no
  // `_meta`: nem o `structuredContent` nem o texto a levam (o modelo nunca recebe o QR).
  registrarApoioDeConfirmacao(
    server,
    "wa_estado_pareamento_tela",
    ANOTACOES_LEITURA,
    ["app"],
    {
      title: "Estado do pareamento (chamada do cartão)",
      description: "Chamada só pelo cartão de pareamento, depois do clique, para desenhar o QR atual. Não é para o modelo.",
      inputSchema: EntradaId,
    },
    async ({ id }) => {
      const s = await situacaoDoPareamento(id);
      return {
        content: [{ type: "text", text: s.frase }],
        structuredContent: { pedido: id, etapa: s.etapa, ...s.extra },
        ...(s.matriz ? { _meta: { qr_matriz: s.matriz } } : {}),
      };
    },
  );

  // Aba Code: o cartão do QR não consegue consultar o servidor; o botão "Mostrar novo QR" manda uma mensagem e o modelo
  // chama esta ferramenta, que devolve outro cartão com o QR atual. Só com um pareamento que o dono já autorizou por
  // clique (pedido de pareamento confirmado); nunca começa um pareamento e nunca devolve o QR ao modelo.
  registrarComCartao(
    server,
    "wa_qr",
    ANOTACOES_LEITURA,
    {
      title: "Mostrar o QR atual do pareamento (no cartão)",
      description:
        "Mostra num cartão novo o QR atual de um pareamento que o dono JÁ autorizou com o clique no cartão do wa_parear. " +
        `Use quando chegar a mensagem do cartão "${mensagemNovoQr("<id>")}" (passe o id em \`pedido\`). ` +
        "Você nunca vê o QR: o resultado traz só a etapa e o que fazer. Não começa pareamento: sem um autorizado, recusa (aí o caminho é wa_parear).",
      inputSchema: EntradaQr,
    },
    async ({ pedido }) => {
      const id = pedido ?? ctx.pedidos.ultimoConfirmado("parear");
      const autorizado = id !== undefined && ctx.pedidos.tipo(id) === "parear" && ["usado", "enviando", "falhou"].includes(ctx.pedidos.situacao(id).estado);
      if (!autorizado) {
        throw new Error(
          "Não há pareamento autorizado por clique com esse pedido. wa_qr só mostra o QR de um pareamento que o dono já autorizou no cartão; para começar um, chame wa_parear. Nada foi feito.",
        );
      }
      return cartaoDoQr(id, await situacaoDoPareamento(id));
    },
  );

  registrarApoioDeConfirmacao(
    server,
    "wa_cancelar",
    CANCELAR,
    undefined,
    {
      title: "Cancelar pedido do WhatsApp",
      description: 'Cancela um pedido pendente quando o dono disser "Cancelo o pedido <id>.". Nada é enviado.',
      inputSchema: EntradaId,
    },
    async ({ id }) => cancelar(id, "wa_cancelar (chamada pelo modelo)"),
  );
}
