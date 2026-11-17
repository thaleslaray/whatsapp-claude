// Ajudantes comuns a todas as ferramentas (adaptado do MCP do Instagram, src/respostas.ts):
// - registrarLeitura / registrarEscritaDireta / registrarEscrita (com cartão) / registrarApoioDeConfirmacao,
//   que já põem as anotações, o prefixo wa_ e, nas de cartão, o endereço do cartão;
// - respostaJson: structuredContent + o mesmo JSON em texto;
// - todo erro vira resultado `isError` com texto limpo de segredos, e TAMBÉM em structuredContent:
//   na aba Code o modelo só lê o structuredContent (lição do Instagram).
//
// 0.6.0: todo registrar* também põe a ferramenta no registro do processo (`ctx.ferramentas`, nome -> {schema,
// manipulador}), que é o que o canal do dono pode executar, validado pelo MESMO schema zod. E o envoltório decide:
// num leitor, a chamada vai inteira ao dono pelo canal e o resultado dele volta como veio; se o canal não responde, a
// leitura é respondida localmente e o resto recusa com FRASE_DO_LEITOR, sem executar nada (nem criar pedido).
// O contexto do pedido MCP (`ServerContext`) só servia para saber se o cliente mostra cartões (`clienteTemTela`); os
// manipuladores agora recebem `Chamada` ({temTela, viaCanal}), igual para quem chamou direto e para quem veio pelo canal.
//
// 0.7.3: este é o ponto único por onde passa toda ferramenta: a caixa-preta anota o NOME de cada uma do começo ao fim
// (quem chamou direto, quem veio pelo canal e o leitor que espera o dono), sem tocar no resultado nem nos erros.

import {
  CLIENT_CAPABILITIES_META_KEY,
  type CallToolResult,
  type ClientCapabilities,
  type McpServer,
  type RegisteredTool,
  type ServerContext,
  type StandardSchemaV1,
  type StandardSchemaWithJSON,
  type ToolAnnotations,
  type ToolCallback,
} from "@modelcontextprotocol/server";
import { getUiCapability } from "@modelcontextprotocol/ext-apps/server";
import type { Pedidos } from "./confirmacao.ts";
import { leituraLocal } from "./config.ts";
import { FRASE_DO_LEITOR, type Chamada, type Contexto } from "./contexto.ts";
import { executarEscrita, URI_TELA, type Escrever } from "./escrita.ts";
import { limpar } from "./segredos.ts";

/** Teto de caracteres do texto de cada resposta. */
export const LIMITE_CARACTERES = 25_000;

export const ANOTACOES_LEITURA: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  // Só lê o banco local (e, em wa_listar_grupos, os metadados do WhatsApp).
  openWorldHint: false,
};

export interface TipoEscrita {
  destrutiva: boolean;
  idempotente: boolean;
}

export function anotacoesEscrita(tipo: TipoEscrita): ToolAnnotations {
  return { readOnlyHint: false, destructiveHint: tipo.destrutiva, idempotentHint: tipo.idempotente, openWorldHint: false };
}

export interface DefinicaoFerramenta<Entrada extends StandardSchemaWithJSON> {
  title: string;
  description: string;
  inputSchema: Entrada;
}

type Manipulador<Entrada extends StandardSchemaWithJSON> = (args: StandardSchemaWithJSON.InferOutput<Entrada>, chamada: Chamada) => Promise<CallToolResult>;

/** O Contexto de cada McpServer (um por sessão MCP), posto pela fabricaDeServidor. Sem ele (testes de unidade), não há registro nem repasse. */
const contextos = new WeakMap<McpServer, Contexto>();
export function vincularContexto(server: McpServer, ctx: Contexto): void {
  contextos.set(server, ctx);
}

export function textoDoErro(erro: unknown): string {
  const mensagem = erro instanceof Error ? erro.message : String(erro);
  return limpar(mensagem);
}

export function respostaErro(erro: unknown): CallToolResult {
  const texto = textoDoErro(erro);
  return { isError: true, content: [{ type: "text", text: texto }], structuredContent: { erro: texto } };
}

/** structuredContent + o mesmo JSON em texto (a spec do MCP pede os dois). */
export function respostaJson(dados: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(dados, null, 2) }], structuredContent: dados };
}

/** 0.14.0: o mesmo, com o texto em JSON compacto (a visão geral do wa_meu_jeito, medida assim contra o teto). */
export function respostaJsonCompacta(dados: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(dados) }], structuredContent: dados };
}

/** Visibilidade de uma ferramenta para o app do Claude (MCP Apps): `["app"]` esconde do modelo. */
export type Visibilidade = Array<"model" | "app">;

/** As duas chaves do endereço do cartão: `_meta.ui.resourceUri` e a antiga `ui/resourceUri` (clientes mais velhos). */
export function metaDaTela(visibilidade?: Visibilidade): Record<string, unknown> {
  return { ui: { resourceUri: URI_TELA, ...(visibilidade ? { visibility: visibilidade } : {}) }, "ui/resourceUri": URI_TELA };
}

/** O app do Claude declarou MCP Apps? (clientes de 2025: capacidades da conexão; de 2026: no pedido.) */
export function clienteTemTela(server: McpServer, mcp: ServerContext): boolean {
  try {
    return temTelaDe(server, mcp);
  } catch {
    return false;
  }
}

function temTelaDe(server: McpServer, mcp: ServerContext): boolean {
  const doPedido = (mcp.mcpReq.envelope as Record<string, unknown> | undefined)?.[CLIENT_CAPABILITIES_META_KEY];
  const capacidades = (doPedido as ClientCapabilities | undefined) ?? server.server.getClientCapabilities();
  const ui = getUiCapability(capacidades);
  return ui !== undefined && (ui.mimeTypes === undefined || ui.mimeTypes.includes("text/html;profile=mcp-app"));
}

/** Valida pelo schema da ferramenta (Standard Schema do zod). Usado no que chega pelo canal; o SDK já valida o resto. */
async function validar<Entrada extends StandardSchemaWithJSON>(schema: Entrada, argumentos: unknown): Promise<StandardSchemaWithJSON.InferOutput<Entrada>> {
  const r = (await schema["~standard"].validate(argumentos)) as StandardSchemaV1.Result<StandardSchemaWithJSON.InferOutput<Entrada>>;
  if (r.issues) {
    const onde = r.issues.map((i) => (i.path ?? []).map((p) => (typeof p === "object" ? String(p.key) : String(p))).join(".") || "(raiz)");
    throw new Error(`Argumentos inválidos: ${[...new Set(onde)].join(", ")}.`);
  }
  return r.value;
}

function registrar<Entrada extends StandardSchemaWithJSON>(
  server: McpServer,
  nome: string,
  definicao: DefinicaoFerramenta<Entrada>,
  annotations: ToolAnnotations,
  manipulador: Manipulador<Entrada>,
  meta?: Record<string, unknown>,
  leitura = false,
): RegisteredTool {
  if (!nome.startsWith("wa_")) throw new Error(`Ferramenta ${nome} sem o prefixo wa_.`);
  const executar = async (args: StandardSchemaWithJSON.InferOutput<Entrada>, chamada: Chamada): Promise<CallToolResult> => {
    try {
      return await manipulador(args, chamada);
    } catch (erro) {
      return respostaErro(erro);
    }
  };
  const ctx = contextos.get(server);
  // 0.11.0: ferramenta cujo resultado o cliente desenha como cartão (anuncia `_meta.ui` e o modelo a vê; as `["app"]`
  // são chamadas pelo próprio cartão). Cada resposta dela deixa um diagnóstico sem conteúdo na caixa-preta.
  const ui = meta?.ui as { visibility?: Visibilidade } | undefined;
  const deCartao = ui !== undefined && !(ui.visibility?.length === 1 && ui.visibility[0] === "app");
  // Registro do processo: cada sessão MCP registra de novo, com o mesmo comportamento (o manipulador não depende do server).
  if (ctx) ctx.ferramentas.set(nome, {
    leitura,
    executar: (argumentos, chamada) =>
      ctx.caixaPreta.acompanharFerramenta(nome, async () => {
        let args: StandardSchemaWithJSON.InferOutput<Entrada>;
        try {
          args = await validar(definicao.inputSchema, argumentos);
        } catch (erro) {
          return respostaErro(erro);
        }
        const r = await executar(args, chamada);
        if (deCartao) ctx.diagnosticoDoCartao({ ferramenta: nome, resultado: r, temTela: chamada.temTela, viaCanal: chamada.viaCanal, repassado: false, server: undefined });
        return r;
      }),
  });
  const direto = async (args: StandardSchemaWithJSON.InferOutput<Entrada>, mcp: ServerContext): Promise<CallToolResult> => {
    const temTela = clienteTemTela(server, mcp);
    await ctx?.papelDecidido();
    if (ctx?.ehLeitor) {
      // Leitor: nunca cria pedido nem escreve enquanto houver dono. O dono executa e o resultado volta como veio.
      // Com a chave de teste `leituraLocal` (config.ts), a leitura roda NESTA cópia, com o código dela, em vez de ir ao
      // dono: serve para testar um servidor recém-construído contra os dados reais sem reinstalar.
      const doDono = leitura && leituraLocal() ? undefined : await ctx.repassar(nome, args, temTela);
      if (doDono) {
        if (deCartao) ctx.diagnosticoDoCartao({ ferramenta: nome, resultado: doDono, temTela, viaCanal: false, repassado: true, server });
        return doDono;
      }
      if (!leitura) return respostaErro(FRASE_DO_LEITOR);
    }
    const r = await executar(args, { temTela, viaCanal: false });
    if (deCartao && ctx) ctx.diagnosticoDoCartao({ ferramenta: nome, resultado: r, temTela, viaCanal: false, repassado: false, server });
    return r;
  };
  const envolvido = (args: StandardSchemaWithJSON.InferOutput<Entrada>, mcp: ServerContext): Promise<CallToolResult> =>
    ctx ? ctx.caixaPreta.acompanharFerramenta(nome, () => direto(args, mcp)) : direto(args, mcp);
  return server.registerTool<StandardSchemaWithJSON, Entrada>(
    nome,
    { ...definicao, annotations: { title: definicao.title, ...annotations }, ...(meta ? { _meta: meta } : {}) },
    // O tipo condicional do SDK não se resolve com Entrada genérica; o formato é o mesmo.
    envolvido as ToolCallback<Entrada>,
  );
}

/** Ferramenta de leitura: livre, sem confirmação. */
export function registrarLeitura<Entrada extends StandardSchemaWithJSON>(
  server: McpServer,
  nome: string,
  definicao: DefinicaoFerramenta<Entrada>,
  manipulador: Manipulador<Entrada>,
): RegisteredTool {
  return registrar(server, nome, definicao, ANOTACOES_LEITURA, manipulador, undefined, true);
}

/** Escrita local que age direto, sem cartão (as listas do dono). Quem a usa grava a ação no registro. */
export function registrarEscritaDireta<Entrada extends StandardSchemaWithJSON>(
  server: McpServer,
  nome: string,
  tipo: TipoEscrita,
  definicao: DefinicaoFerramenta<Entrada>,
  manipulador: Manipulador<Entrada>,
): RegisteredTool {
  return registrar(server, nome, definicao, anotacoesEscrita(tipo), manipulador);
}

/**
 * Ferramenta com cartão. O manipulador recebe `escrever(ferramenta, corpo, previa, enviar, edicao?, opcoes?)`: ele cria
 * o pedido e devolve a prévia; NADA acontece antes do clique. Aponta para o cartão (`_meta.ui.resourceUri`).
 */
export function registrarEscrita<Entrada extends StandardSchemaWithJSON>(
  server: McpServer,
  pedidos: Pedidos,
  nome: string,
  tipo: TipoEscrita,
  definicao: DefinicaoFerramenta<Entrada>,
  manipulador: (args: StandardSchemaWithJSON.InferOutput<Entrada>, chamada: Chamada, escrever: Escrever) => Promise<CallToolResult>,
): RegisteredTool {
  return registrar(
    server,
    nome,
    definicao,
    anotacoesEscrita(tipo),
    (args, chamada) => {
      // Pedido criado pelo canal: o registro de ações diz `via: "canal"` (nunca o texto).
      const escrever: Escrever = async (ferramenta, corpo, previa, enviar, edicao, opcoes) =>
        executarEscrita(
          pedidos,
          () => chamada.temTela,
          ferramenta,
          corpo,
          previa,
          enviar,
          edicao,
          chamada.viaCanal ? { ...opcoes, registro: { ...opcoes?.registro, via: "canal" } } : opcoes,
        );
      return manipulador(args, chamada, escrever);
    },
    metaDaTela(),
  );
}

/** Ferramenta que apoia a confirmação (confirmar, cancelar, estado): não abre prévia. Com visibilidade, aponta para o cartão. */
export function registrarApoioDeConfirmacao<Entrada extends StandardSchemaWithJSON>(
  server: McpServer,
  nome: string,
  anotacoes: ToolAnnotations,
  visibilidade: Visibilidade | undefined,
  definicao: DefinicaoFerramenta<Entrada>,
  manipulador: Manipulador<Entrada>,
): RegisteredTool {
  return registrar(server, nome, definicao, anotacoes, manipulador, visibilidade ? metaDaTela(visibilidade) : undefined);
}

/**
 * Ferramenta que o modelo vê e cujo resultado desenha o cartão (`_meta.ui.resourceUri`, sem restringir a visibilidade):
 * wa_confirmar (no pareamento, o cartão com o QR) e wa_qr. Não abre prévia.
 */
export function registrarComCartao<Entrada extends StandardSchemaWithJSON>(
  server: McpServer,
  nome: string,
  anotacoes: ToolAnnotations,
  definicao: DefinicaoFerramenta<Entrada>,
  manipulador: Manipulador<Entrada>,
): RegisteredTool {
  return registrar(server, nome, definicao, anotacoes, manipulador, metaDaTela());
}

/**
 * Devolve o maior prefixo de `itens` cujo JSON cabe no teto, nunca cortando texto no meio.
 * `montar` recebe a fatia e devolve o objeto final.
 */
export function caberNoTeto<T>(itens: readonly T[], montar: (fatia: readonly T[], reduzida: boolean) => Record<string, unknown>, teto = LIMITE_CARACTERES): Record<string, unknown> {
  let n = itens.length;
  for (;;) {
    const dados = montar(itens.slice(0, n), n < itens.length);
    if (n <= 1 || JSON.stringify(dados, null, 2).length <= teto) return dados;
    n = Math.max(1, Math.floor(n / 2));
  }
}
