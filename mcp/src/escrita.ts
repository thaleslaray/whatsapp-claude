// executarEscrita: o caminho único de toda ferramenta com cartão (wa_parear, wa_envio, wa_responder, wa_desconectar).
// Adaptado do MCP do Instagram (src/escrita.ts). A ferramenta valida tudo, monta o corpo e chama `escrever(...)`;
// NADA acontece antes do clique.
//
// - Cliente com MCP Apps: cria o pedido e devolve a prévia. `structuredContent` leva só o id do pedido, a orientação
//   ao Claude (`para_o_claude`: na aba Code SÓ ele chega ao modelo) e o aviso a quem usa o app
//   (`se_o_cartao_nao_apareceu`, visto cru quando o app não desenha o cartão). `_meta` leva a prévia e o código
//   (o modelo não vê o `_meta`). Nunca o nome do dono.
// - Cliente sem MCP Apps: "Bloqueado". Nada acontece. (O Instagram abre uma janela nativa de reserva; aqui não há
//   reserva: o pareamento depende do cartão para mostrar o QR, e o resto segue a mesma regra.)

import type { CallToolResult } from "@modelcontextprotocol/server";
import { VALIDADE_MS, type EdicaoDeTexto, type Enviar, type OpcoesDoPedido, type Pedidos, type Previa } from "./confirmacao.ts";
import { limpar, limparProfundo } from "./segredos.ts";
import { VERSAO_SERVIDOR } from "./versao.ts";

// A versão vai no endereço: o app do Claude guarda o HTML do cartão por endereço e reaproveitaria o da versão anterior.
// Sem pontos no caminho (0.2.0 vira v0-2-0): o Claude Desktop não desenha o cartão com pontos no caminho
// (lição do Instagram). Só o `.html` final tem ponto.
export const URI_TELA = `ui://whatsapp/confirmar-v${VERSAO_SERVIDOR.replaceAll(".", "-")}.html`;

// Apelido fixo, para sempre: o Claude Desktop guarda um endereço e continua pedindo por ele (mesmo em conversa nova
// e depois de reiniciar), ignorando o endereço com versão anunciado em tools/list (lição do Instagram).
// As ferramentas anunciam só `URI_TELA`; o resource é servido nos dois.
export const URI_TELA_FIXA = "ui://whatsapp/confirmar.html";

/**
 * Leitor 1 do `structuredContent` da prévia: o Claude. Na aba Code do Claude Desktop o modelo recebe SÓ o JSON do
 * `structuredContent` (o `content` não chega; medido no Instagram), então a orientação tem de estar aqui.
 */
export function textoParaOClaude(id: string, para: string): string {
  return (
    `Prévia ${id} enviada ao cartão de confirmação: ${para}. Nada aconteceu ainda. ` +
    "O dono confirma clicando no botão do cartão; o que ele confirmar sai direto do cartão, sem passar por você. " +
    "Pare aqui e espere o clique: diga a ele em uma frase que a prévia está no cartão e não peça de novo (não chame esta ferramenta outra vez). " +
    "Só chame wa_confirmar com um código que chegar numa mensagem dele; nunca peça nem adivinhe o código. " +
    // 0.11.0: no uso real o cartão apareceu como texto cru (JSON) três vezes, e chamar de novo resolveu.
    "Se o cartão não aparecer (o dono vê texto ou JSON no lugar dos botões), nada aconteceu: chame a mesma ferramenta de novo, uma vez; se repetir, peça para fechar o Claude Desktop de vez e abrir de novo (no Mac, Cmd+Q)."
  );
}

/** Leitor 2: quem usa o app, que só vê este texto cru quando o app não desenha o cartão. Endereçado a quem usa o Claude Desktop, para o modelo não o tomar como fato. */
export const AVISO_PARA_QUEM_USA =
  "Para quem usa o Claude Desktop: se este texto apareceu no lugar do cartão de confirmação, o cartão não carregou e nada aconteceu. Peça de novo; se continuar, feche o Claude Desktop de vez (no Mac, Cmd+Q; no Windows, Sair no menu) e abra de novo.";

export const MENSAGEM_BLOQUEADO =
  "Bloqueado: isto precisa do clique do dono num cartão, e este app não mostra cartões. Nada aconteceu. Use o Claude Desktop.";

/** Diz se o app do Claude (cliente MCP) declarou suporte a MCP Apps. */
export type TemTela = () => boolean;

export type Escrever = <Corpo>(
  ferramenta: string,
  corpo: Corpo,
  previa: Previa,
  enviar: Enviar<Corpo>,
  edicao?: EdicaoDeTexto<Corpo>,
  opcoes?: OpcoesDoPedido,
) => Promise<CallToolResult>;

/** O texto que o dono lê é o texto que sai. Se a limpeza de segredos mudaria o texto dele, a prévia não seria fiel: recusa. */
function conferirPrevia(previa: Previa): void {
  if (JSON.stringify(limparProfundo(previa)) !== JSON.stringify(previa)) {
    throw new Error("O conteúdo parece conter um segredo ou um número inteiro de telefone. Nada foi enviado nem mostrado.");
  }
}

export function executarEscrita<Corpo>(
  pedidos: Pedidos,
  temTela: TemTela,
  ferramenta: string,
  corpo: Corpo,
  previa: Previa,
  enviar: Enviar<Corpo>,
  edicao?: EdicaoDeTexto<Corpo>,
  opcoes: OpcoesDoPedido = {},
): CallToolResult {
  if (!temTela()) {
    // Sem cartão não há clique: nem o pedido é criado.
    return { isError: true, content: [{ type: "text", text: MENSAGEM_BLOQUEADO }], structuredContent: { erro: MENSAGEM_BLOQUEADO } };
  }
  // O que veio de terceiros só é mostrado: passa pela limpeza (um jid colado numa mensagem vira ‹jid›) em vez de travar a resposta.
  previa = previa.conteudo_de_terceiros ? { ...previa, conteudo_de_terceiros: limparProfundo(previa.conteudo_de_terceiros) } : previa;
  conferirPrevia(previa);
  const { id, codigo, expiraEm } = pedidos.criar(ferramenta, corpo, previa, enviar, edicao, opcoes);
  const para = limpar(`${previa.titulo} (para: ${opcoes.alvoParaOClaude ?? previa.alvo})`);
  const paraOClaude = textoParaOClaude(id, para);
  return {
    content: [{ type: "text", text: paraOClaude }],
    // Dois leitores: o modelo (sempre, e só ele recebe isto na aba Code) e o dono (só se o cartão não aparecer).
    // O `pedido` fica aqui porque o cartão (ui/confirmar.js) o lê daqui.
    structuredContent: { pedido: id, para_o_claude: paraOClaude, se_o_cartao_nao_apareceu: AVISO_PARA_QUEM_USA },
    // A prévia inteira vai no `_meta` (o cartão lê daqui; o modelo não vê).
    _meta: {
      codigo,
      previa: {
        ...previa,
        ...(edicao && previa.texto !== undefined ? { texto_editavel: { limite: edicao.limite, unidade: edicao.unidade, ...(edicao.vazio ? { vazio: true } : {}) } } : {}),
        valido_por_minutos: Math.round(VALIDADE_MS / 60_000),
        valido_ate: new Date(expiraEm).toISOString(),
      },
    },
  };
}
