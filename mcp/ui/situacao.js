// Ajuste do cartão que o Claude Desktop recriou (sem DOM, para dar para testar no Node).
// Adaptado do MCP do Instagram (ui/situacao.js). O iframe novo recebe o MESMO resultado da prévia e se desenharia
// do zero (botão ativo). Ao montar, o cartão pergunta ao servidor (`wa_estado_pedido_tela`) como está o pedido e se
// ajusta: um segundo clique nunca reenvia (o servidor também recusa: pedido "usado").

export const INTERVALO_ENVIANDO_MS = 2_000;
export const LIMITE_ENVIANDO_MS = 2 * 60_000;
export const MAX_FALHAS_SEGUIDAS_ENVIANDO = 3;

const ESTADOS = ["pendente", "enviando", "usado", "falhou", "cancelado", "expirado", "inexistente"];

/** O estado do pedido no resultado cru de `wa_estado_pedido_tela`, ou null se a consulta não deu uma resposta válida. */
export function estadoDoPedido(r) {
  const sc = r && !r.isError ? r.structuredContent : null;
  return sc && typeof sc.estado === "string" && ESTADOS.includes(sc.estado) ? sc.estado : null;
}

/** Frase de "já foi feito" para cada tipo de cartão. */
export function fraseDeFeito(tipo, resultado) {
  if (tipo === "envio") {
    const ligado = resultado && resultado.envio_ligado === true;
    return ligado ? "O envio já está ligado." : "O envio já está desligado.";
  }
  if (tipo === "desconectar") return "O WhatsApp já foi desconectado deste computador.";
  if (tipo === "listas") return "A mudança na lista já foi feita.";
  return "Esta resposta já foi enviada.";
}

/**
 * O que o cartão faz com a resposta da consulta. `acao`:
 *  - "nada": pedido pendente, o cartão fica como foi desenhado;
 *  - "travar": trava de vez e mostra `mensagem` (`tipo`: "" ou "erro");
 *  - "feito": trava e mostra que já foi feito;
 *  - "enviando": trava e espera o envio voltar (ver `aguardarEnvio`);
 *  - "parear": cartão de pareamento já confirmado: volta a acompanhar o QR.
 */
export function planoDaSituacao(r, tipoDoCartao) {
  const estado = estadoDoPedido(r);
  const sc = r && r.structuredContent ? r.structuredContent : {};
  const tipo = typeof sc.tipo === "string" ? sc.tipo : tipoDoCartao;
  if (estado === null || estado === "pendente") return { acao: "nada", mensagem: "", tipo: "" };
  if (estado === "usado") {
    if (tipo === "parear") return { acao: "parear", mensagem: "Pareamento em andamento…", tipo: "" };
    return { acao: "feito", mensagem: fraseDeFeito(tipo, sc.resultado), tipo: "ok" };
  }
  if (estado === "enviando") return { acao: "enviando", mensagem: "Enviando… (o pedido já foi confirmado)", tipo: "" };
  if (estado === "falhou") return { acao: "travar", mensagem: "Não deu certo. Nada mais será tentado por este cartão; peça de novo ao Claude.", tipo: "erro" };
  if (estado === "cancelado") return { acao: "travar", mensagem: "Pedido cancelado. Nada foi enviado.", tipo: "" };
  return { acao: "travar", mensagem: "Este pedido não vale mais (venceu ou o Claude Desktop reiniciou o servidor). Nada foi enviado. Peça de novo.", tipo: "erro" };
}

/**
 * Pedido em "enviando": consulta de 2 em 2 s, até 2 minutos, até virar outra coisa. Devolve o último resultado cru
 * (com estado diferente de "enviando"), ou null se a consulta falhou 3 vezes seguidas, o tempo acabou ou `cancelado()` mandou parar.
 */
export async function aguardarEnvio({ consultar, esperar, agora, cancelado = () => false }) {
  const inicio = agora();
  let falhas = 0;
  for (;;) {
    await esperar(INTERVALO_ENVIANDO_MS);
    if (cancelado()) return null;
    let r = null;
    try {
      r = await consultar();
    } catch {
      r = null;
    }
    if (cancelado()) return null;
    const estado = estadoDoPedido(r);
    if (estado === null) {
      falhas++;
      if (falhas >= MAX_FALHAS_SEGUIDAS_ENVIANDO) return null;
    } else {
      falhas = 0;
      if (estado !== "enviando") return r;
    }
    if (agora() - inicio >= LIMITE_ENVIANDO_MS) return null;
  }
}
