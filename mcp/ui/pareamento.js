// Acompanhamento do pareamento no cartão (sem DOM, para dar para testar no Node).
// Com serverTools: depois do clique em "Entendo o risco, mostrar o QR", o cartão consulta `wa_estado_pareamento_tela`
// de 2 em 2 s: cada resposta traz a etapa e, na etapa "qr", a matriz do QR (só no `_meta`) e quantos segundos ele ainda
// vale. O QR muda sozinho (o WhatsApp manda um novo a cada 60 s); o pareamento inteiro tem 5 minutos.
// Sem serverTools (aba Code): o cartão do QR vem do resultado do wa_confirmar ou do wa_qr e não consulta nada; os botões
// mandam as mensagens abaixo no chat, e o modelo chama wa_qr (QR novo) ou wa_estado (conferir).
import { validarMatriz } from "./qr.js";

export const INTERVALO_PAREAMENTO_MS = 2_000;
/** Teto do acompanhamento: os 5 minutos do pareamento mais uma folga. */
export const LIMITE_PAREAMENTO_MS = 6 * 60_000;
export const MAX_FALHAS_SEGUIDAS_PAREAMENTO = 5;

export const INSTRUCAO_DO_CELULAR = "No celular: WhatsApp > Configurações > Aparelhos conectados > Conectar aparelho. Depois aponte a câmera para o QR.";

const ETAPAS = ["aguardando_clique", "gerando_qr", "qr", "conectando", "conectado", "expirado", "parado", "inexistente"];
const FINAIS = new Set(["conectado", "expirado", "parado", "inexistente", "aguardando_clique"]);

/** A leitura de uma resposta de `wa_estado_pareamento_tela`, ou null se não veio uma resposta válida. */
export function lerEtapa(r) {
  const sc = r && !r.isError ? r.structuredContent : null;
  if (!sc || typeof sc.etapa !== "string" || !ETAPAS.includes(sc.etapa)) return null;
  const meta = (r && r._meta) || {};
  return {
    etapa: sc.etapa,
    matriz: validarMatriz(meta.qr_matriz),
    segundos: typeof sc.segundos_restantes === "number" ? Math.max(0, Math.floor(sc.segundos_restantes)) : 0,
    conectadoComo: typeof sc.conectado_como === "string" ? sc.conectado_como : "",
    mensagem: typeof sc.mensagem === "string" ? sc.mensagem : "",
  };
}

export function etapaFinal(etapa) {
  return FINAIS.has(etapa);
}

/** Segundos que o QR ainda vale agora, a partir do que o servidor disse quando respondeu. */
export function segundosQueFaltam(segundosNaResposta, recebidoEm, agora) {
  return Math.max(0, segundosNaResposta - Math.floor((agora - recebidoEm) / 1000));
}

export function rotuloDaContagem(segundos) {
  return segundos > 0 ? "Este QR vale mais " + segundos + " s; depois aparece outro sozinho." : "Esperando o próximo QR…";
}

/** A contagem do cartão que não se atualiza sozinho (aba Code): o QR novo vem pelo botão. */
export function rotuloDaContagemSemServidor(segundos) {
  return segundos > 0 ? "Este QR vale mais " + segundos + " s." : "Este QR venceu. Clique em Mostrar novo QR.";
}

/** Mensagem do botão "Mostrar novo QR" (o modelo chama wa_qr). */
export function mensagemNovoQr(id) {
  return "Mostre um novo QR do pareamento (pedido " + id + ").";
}

/** Mensagem do botão "Já escaneei" (o modelo confere com wa_estado). */
export function mensagemJaEscaneei(id) {
  return "Já escaneei o QR do pareamento (pedido " + id + "). Confira se conectou.";
}

/** A frase de cada etapa (a do "qr" é a instrução do celular). */
export function fraseDaEtapa(e) {
  switch (e.etapa) {
    case "gerando_qr":
      return "Gerando o QR…";
    case "qr":
      return INSTRUCAO_DO_CELULAR;
    case "conectando":
      return "QR lido. Conectando…";
    case "conectado":
      return "Conectado como " + (e.conectadoComo || "o seu número") + ".";
    case "expirado":
      return e.mensagem || "O pareamento não terminou em 5 minutos; nada ficou salvo. Peça ao Claude para parear de novo.";
    case "aguardando_clique":
      return "O pareamento ainda não foi autorizado neste cartão.";
    default:
      return e.mensagem || "O pareamento parou. Nada ficou salvo. Peça ao Claude para parear de novo.";
  }
}

/**
 * Consulta de 2 em 2 s até uma etapa final, `cancelado()`, 5 falhas seguidas ou o teto de tempo.
 * Chama `mostrar(etapa)` a cada resposta válida. Devolve a última etapa lida (ou null).
 */
export async function acompanharPareamento({ consultar, mostrar, esperar, agora, cancelado = () => false }) {
  const inicio = agora();
  let falhas = 0;
  let ultima = null;
  for (;;) {
    if (cancelado()) return ultima;
    let r = null;
    try {
      r = await consultar();
    } catch {
      r = null;
    }
    if (cancelado()) return ultima;
    const e = lerEtapa(r);
    if (e === null) {
      falhas++;
      if (falhas >= MAX_FALHAS_SEGUIDAS_PAREAMENTO) return ultima;
    } else {
      falhas = 0;
      ultima = e;
      mostrar(e);
      if (etapaFinal(e.etapa)) return e;
    }
    if (agora() - inicio >= LIMITE_PAREAMENTO_MS) return ultima;
    await esperar(INTERVALO_PAREAMENTO_MS);
  }
}
