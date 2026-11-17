// Lógica do texto editável e do que o cartão mostra, sem tocar no DOM, para dar para testar no Node.
// Adaptado do MCP do Instagram (ui/edicao.js).
import { sha256Hex } from "./sha256.js";

/** Tamanho do texto na unidade do limite: bytes em UTF-8 ou caracteres (emoji conta 1). */
export function medir(texto, unidade) {
  return unidade === "bytes" ? new TextEncoder().encode(texto).length : Array.from(texto).length;
}

export function rotuloDoContador(texto, limite, unidade) {
  return medir(texto, unidade) + " de " + limite + " " + unidade;
}

/** Enviar só liga com texto não vazio (salvo onde o vazio vale: a legenda de um arquivo) e dentro do limite. */
export function podeEnviar(texto, limite, unidade, vazioPode = false) {
  return (vazioPode || texto.trim() !== "") && medir(texto, unidade) <= limite;
}

/** Código de um pedido com texto editado: SHA-256(codigo + "\n" + texto), 32 primeiros caracteres. O servidor faz a mesma conta. */
export function codigoEditado(codigo, texto) {
  return sha256Hex(codigo + "\n" + texto).slice(0, 32);
}

/**
 * 0.16.0: o código DE CONVERSA de um pedido: SHA-256("conversa\n" + código de tela), 32 primeiros caracteres. O código
 * que chega no `_meta` é o de tela (só o wa_confirmar_tela, do cartão, aceita); o wa_confirmar (o do modelo) só aceita
 * este, que o cartão calcula na hora do clique e manda no chat. Assim nada do resultado da ferramenta (`content`,
 * `structuredContent`, `_meta`) vale pelo wa_confirmar. O servidor faz a mesma conta (codigoDeConversa).
 */
export function codigoDeConversa(codigo) {
  return sha256Hex("conversa\n" + codigo).slice(0, 32);
}

/** Mensagem do caminho sem ferramenta da tela (aba Code). Com `texto`, o código já deve ser o editado. */
export function mensagemDeConfirmacao(id, codigo, texto) {
  if (texto === null) return "Confirmo o pedido " + id + ", código " + codigo + ".";
  return "Confirmo o pedido " + id + ", código " + codigo + ", com este texto:\n" + texto;
}

/**
 * A mensagem que o cartão manda no chat quando o app não deixa o cartão chamar o servidor (aba Code). `codigo` é o de
 * tela (do `_meta`); pelo chat vai SEMPRE o código de conversa (0.16.0), nunca o de tela.
 * Pedido com texto editável (`texto` não nulo): o código de conversa preso ao texto mostrado (codigoEditado) e o texto,
 * editado ou não: com o código solto, o modelo calcularia o código de outro texto.
 * Pedido sem texto editável (`texto` nulo: ligar envio, desconectar, listas, arquivo de voz, parear): o código de conversa.
 */
export function confirmacaoPeloChat(id, codigo, texto) {
  const daConversa = codigoDeConversa(codigo);
  if (texto === null) return mensagemDeConfirmacao(id, daConversa, null);
  return mensagemDeConfirmacao(id, codigoEditado(daConversa, texto), texto);
}

/** O que vai depois de "Para:". Com o nome que a pessoa usa (de terceiros), "Nome (alvo)". */
export function destinatario(sc) {
  const t = sc && sc.conteudo_de_terceiros;
  const nome = t && typeof t.nome === "string" && t.nome.trim() !== "" ? t.nome.trim() : "";
  const alvo = (sc && sc.alvo) || "?";
  return nome ? nome + " (" + alvo + ")" : alvo;
}

/** Últimas mensagens recebidas, para o bloco "De outra pessoa": [{ data, texto }]. */
export function ultimasParaMostrar(sc) {
  const t = sc && sc.conteudo_de_terceiros;
  const lista = t && Array.isArray(t.ultimas_recebidas) ? t.ultimas_recebidas : [];
  return lista.filter((m) => m && typeof m.texto === "string").map((m) => ({ data: typeof m.data === "string" ? m.data : "", texto: m.texto }));
}

/** Grupos ou contatos de um pedido de lista, para o bloco "Nomes": [{ id, nome }]. O nome foi escolhido por outra pessoa. */
export function itensParaMostrar(sc) {
  const t = sc && sc.conteudo_de_terceiros;
  const lista = t && Array.isArray(t.itens) ? t.itens : [];
  return lista
    .filter((i) => i && typeof i.id === "string")
    .map((i) => ({ id: i.id, nome: typeof i.nome === "string" && i.nome.trim() !== "" ? i.nome : "(sem nome)" }));
}

/** Data ISO em "dd/mm hh:mm" no fuso de quem vê. Vazio se não for data. */
export function dataCurta(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return p(d.getDate()) + "/" + p(d.getMonth() + 1) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

/** Linhas que ficam sempre à vista: avisos e consequência sem volta. */
const LINHA_A_VISTA = /^(Aviso:|Ação sem volta)/;

/**
 * Separa as linhas do cartão: avisos e "ação sem volta" ficam à vista; o resto vai para "Ver detalhes".
 * Uma linha só não vale um botão: fica à vista. A ordem original é mantida dentro de cada grupo.
 */
export function separarDetalhes(linhas) {
  const validas = Array.isArray(linhas) ? linhas.filter((l) => typeof l === "string") : [];
  const aVista = validas.filter((l) => LINHA_A_VISTA.test(l));
  const recolhidas = validas.filter((l) => !LINHA_A_VISTA.test(l));
  if (recolhidas.length <= 1) return { aVista: [...validas], recolhidas: [] };
  return { aVista, recolhidas };
}

/**
 * O dado que evita engano (0.7.0), bem à vista logo abaixo do título: quantos participantes de um grupo recebem, ou o
 * número inteiro de uma conversa nova. Vazio se a prévia não tem.
 */
export function destaqueParaMostrar(sc) {
  return sc && typeof sc.destaque === "string" ? sc.destaque.trim() : "";
}

/** A mensagem do dono que vai mudar (editar) ou sumir (apagar): { texto, data } ou null. */
export function mensagemAtualParaMostrar(sc) {
  const m = sc && sc.mensagem_atual;
  if (!m || typeof m.texto !== "string") return null;
  return { texto: m.texto, data: typeof m.data === "string" ? m.data : "" };
}

/** O rótulo do texto editável conforme o tipo do pedido. */
export function rotuloDoTextoEditavel(tipo) {
  if (tipo === "editar") return "Texto novo (você pode editar)";
  if (tipo === "iniciar") return "Primeira mensagem (você pode editar)";
  if (tipo === "arquivo") return "Legenda (você pode editar; pode ficar vazia)";
  return "Sua resposta (você pode editar)";
}

/** O rótulo da mensagem atual conforme o tipo do pedido. */
export function rotuloDaMensagemAtual(tipo) {
  return tipo === "apagar" ? "Mensagem que vai sumir para todos" : "Texto de agora (vai ser trocado)";
}

/**
 * O arquivo de um pedido de envio (0.7.0, parte 2): { nome, tipo, tamanho, caminho } ou null. Montado pelo servidor a
 * partir do arquivo do próprio dono (o caminho real, já sem links).
 */
export function arquivoParaMostrar(sc) {
  const a = sc && sc.arquivo;
  if (!a || typeof a.caminho !== "string" || typeof a.nome !== "string") return null;
  // A foto (data URL montada pelo servidor a partir do arquivo do dono): só os tipos de imagem, nada de outro esquema.
  const imagem = typeof a.imagem === "string" && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(a.imagem) ? a.imagem : undefined;
  return { nome: a.nome, tipo: typeof a.tipo === "string" ? a.tipo : "", tamanho: typeof a.tamanho === "string" ? a.tamanho : "", caminho: a.caminho, ...(imagem ? { imagem } : {}) };
}
