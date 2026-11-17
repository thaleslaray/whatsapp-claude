// Cartão de confirmação do WhatsApp (MCP App). Roda dentro do app do Claude, numa área isolada.
// Adaptado do cartão do MCP do Instagram (ui/confirmar.js), já provado no Claude Desktop.
//
// Recebe a prévia em `_meta.previa` e o código em `_meta.codigo` (o modelo não vê o `_meta`). O `structuredContent`
// tem `pedido`, `para_o_claude` e `se_o_cartao_nao_apareceu`; o cartão só lê `pedido`.
// Tipos (`previa.tipo`): "responder" (texto editável), "envio" (ligar/desligar), "desconectar", "listas", "parear" e,
// desde a 0.7.0, "iniciar" (conversa nova: número inteiro no destaque, texto editável), "editar" (texto de agora e o
// novo, editável) e "apagar" (a mensagem que vai sumir). `destaque` (grupo: quantos recebem; conversa nova: o número)
// fica logo abaixo do título, bem à vista. Pedido com texto editável só confirma pelo chat com o código preso ao texto.
// Clique no botão de ação:
//  - o app do Claude declara `serverTools` -> chama `wa_confirmar_tela` direto;
//  - senão (aba Code) -> manda a mensagem no chat (confirmacaoPeloChat). Na resposta (texto editável) ela SEMPRE leva o
//    código preso ao texto mostrado e o texto, editado ou não: o código cru nunca sai do cartão pelo chat (com ele o
//    modelo poderia calcular o código de outro texto). Nos pedidos sem texto (envio, desconectar, listas, parear), o
//    código solto. Desde a 0.16.0, pelo chat vai o código DE CONVERSA (codigoDeConversa, calculado aqui na hora do
//    clique); o `_meta.codigo` é o de tela, que só o wa_confirmar_tela aceita.
// Pareamento confirmado:
//  - com serverTools: o cartão consulta `wa_estado_pareamento_tela` de 2 em 2 s e desenha o QR, com a contagem de
//    60 s, até "Conectado como …";
//  - sem serverTools (aba Code): o modelo chama wa_confirmar e o RESULTADO dele desenha um cartão novo com o QR
//    (`_meta.pareamento` e `_meta.qr_matriz`). Esse cartão não consulta nada: mostra o QR com a contagem e os botões
//    "Mostrar novo QR" (o modelo chama wa_qr, que desenha outro cartão) e "Já escaneei" (o modelo confere com wa_estado).
// O QR vem como matriz e é desenhado aqui num <svg> (ui/qr.js), com fundo branco fixo mesmo no tema escuro.
// Cartão recriado pelo app: ao abrir, pergunta `wa_estado_pedido_tela` e se ajusta (um segundo clique nunca reenvia).
import { App, applyDocumentTheme, applyHostStyleVariables, applyHostFonts } from "@modelcontextprotocol/ext-apps/app-with-deps";
import { aguardarEnvio, planoDaSituacao } from "./situacao.js";
import { acompanharPareamento, fraseDaEtapa, lerEtapa, mensagemJaEscaneei, mensagemNovoQr, rotuloDaContagem, rotuloDaContagemSemServidor, segundosQueFaltam } from "./pareamento.js";
import { caminhoDoQr } from "./qr.js";
import {
  arquivoParaMostrar,
  codigoEditado,
  confirmacaoPeloChat,
  contarMarcados,
  dataCurta,
  destaqueParaMostrar,
  destinatario,
  itensDoLoteParaMostrar,
  itensParaMostrar,
  lerLote,
  resultadoDoLoteParaMostrar,
  rotuloDoBotaoDoLote,
  serializarLote,
  mensagemAtualParaMostrar,
  podeEnviar,
  rotuloDaMensagemAtual,
  rotuloDoContador,
  rotuloDoTextoEditavel,
  separarDetalhes,
  ultimasParaMostrar,
} from "./edicao.js";

const app = new App({ name: "whatsapp-confirmar", version: "1.0.0" }, {});
const $ = (id) => document.getElementById(id);

let pedido = null; // { id, codigo, tipo, original, edicao: { limite, unidade } | null }
let travado = false;
let encerrado = false; // pedido já usado ou cancelado: o cartão nunca mais destrava
let cliqueDado = false; // o dono clicou: a consulta de estado que voltar depois não mexe mais no cartão
let geracao = 0; // cada resultado de ferramenta recebido abre uma geração; consulta de geração velha é descartada
let relogioDoQr = null;
let lote = null; // 0.17.0 (wa_responder_lote): { marcas: [<input checkbox>], caixas: [[<textarea>]] }

function el(tag, classe, texto) {
  const e = document.createElement(tag);
  if (classe) e.className = classe;
  if (texto !== undefined) e.textContent = texto;
  return e;
}

function aplicarContexto(ctx) {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles && ctx.styles.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles && ctx.styles.css && ctx.styles.css.fonts) applyHostFonts(ctx.styles.css.fonts);
  const z = ctx.safeAreaInsets;
  if (z) {
    const r = document.documentElement.style;
    r.setProperty("--safe-top", z.top + "px");
    r.setProperty("--safe-right", z.right + "px");
    r.setProperty("--safe-bottom", z.bottom + "px");
    r.setProperty("--safe-left", z.left + "px");
  }
}

const temServerTools = () => Boolean(app.getHostCapabilities() && app.getHostCapabilities().serverTools);

function mostrarEstado(texto, tipo) {
  const e = $("estado");
  if (!e) return;
  e.textContent = texto;
  e.className = "estado" + (tipo ? " " + tipo : "");
}

function textoAtual() {
  if (lote) return serializarLote(lote.marcas.map((m) => m.checked), lote.caixas.map((cs) => cs.map((c) => c.value)));
  const campo = $("campo-texto");
  return campo ? campo.value : null;
}

/** Lote: quantos itens marcados e se todo item marcado tem texto válido (não vazio, até o limite). */
function situacaoDoLote() {
  const marcados = lote.marcas.filter((m) => m.checked).length;
  const valido = lote.marcas.every((m, i) => !m.checked || lote.caixas[i].every((c) => podeEnviar(c.value, 4096, "caracteres")));
  return { marcados, valido };
}

function atualizarBotoes() {
  const cancelar = $("cancelar");
  if (cancelar) cancelar.disabled = travado;
  const acao = $("acao");
  if (!acao) return;
  if (lote) {
    const { marcados, valido } = situacaoDoLote();
    acao.textContent = rotuloDoBotaoDoLote(marcados);
    acao.disabled = travado || marcados === 0 || !valido;
    return;
  }
  const texto = textoAtual();
  const invalido = pedido && pedido.edicao && texto !== null && !podeEnviar(texto, pedido.edicao.limite, pedido.edicao.unidade, pedido.edicao.vazio === true);
  acao.disabled = travado || Boolean(invalido);
}

function travar(valor) {
  travado = valor || encerrado;
  const campo = $("campo-texto");
  if (campo) campo.readOnly = travado;
  if (lote) {
    for (const m of lote.marcas) m.disabled = travado;
    for (const cs of lote.caixas) for (const c of cs) c.readOnly = travado;
  }
  atualizarBotoes();
}

function encerrar() {
  encerrado = true;
  travar(true);
}

function ajustarAltura(campo) {
  campo.style.height = "auto";
  campo.style.height = campo.scrollHeight + 2 + "px";
}

/** Bloco do texto: só leitura, ou <textarea> com contador ao vivo quando a ferramenta aceita edição. */
function blocoDoTexto(sc) {
  const bloco = el("div");
  const edicao = pedido && pedido.edicao;
  if (!edicao) {
    bloco.append(el("p", "rotulo", "Texto (" + Array.from(sc.texto).length + " caracteres)"), el("p", "texto", sc.texto));
    return bloco;
  }
  const rotulo = el("label", "rotulo", rotuloDoTextoEditavel(sc.tipo));
  rotulo.htmlFor = "campo-texto";
  rotulo.style.display = "block";
  const campo = document.createElement("textarea");
  campo.id = "campo-texto";
  campo.className = "texto campo";
  campo.rows = 1;
  campo.value = sc.texto;
  campo.spellcheck = true;
  const contador = el("p", "contador");
  contador.id = "contador";
  contador.setAttribute("aria-live", "polite");
  const atualizar = () => {
    const texto = campo.value;
    contador.textContent = rotuloDoContador(texto, edicao.limite, edicao.unidade);
    contador.className = "contador" + (podeEnviar(texto, edicao.limite, edicao.unidade, edicao.vazio === true) ? "" : " excedeu");
    ajustarAltura(campo);
    atualizarBotoes();
  };
  campo.addEventListener("input", atualizar);
  bloco.append(rotulo, campo, contador);
  queueMicrotask(atualizar);
  return bloco;
}

/** 0.17.0: o cartão do lote. Uma seção por item: quem é, a última recebida (só ler), as mensagens editáveis e "enviar este". */
function blocoDoLote(sc) {
  const itens = itensDoLoteParaMostrar(sc);
  let decisao;
  try {
    decisao = lerLote(sc.texto);
  } catch {
    return el("p", "estado erro", "Não consegui ler o lote. Peça de novo ao Claude.");
  }
  lote = { marcas: [], caixas: [] };
  const bloco = el("div", "lote");
  itens.forEach((it, i) => {
    const secao = el("section", "item-do-lote");
    const cabeca = el("label", "item-cabeca");
    const marca = document.createElement("input");
    marca.type = "checkbox";
    marca.checked = decisao.enviar[i] !== false;
    marca.addEventListener("change", () => {
      secao.classList.toggle("desmarcado", !marca.checked);
      atualizarBotoes();
    });
    const nome = it.nome ? it.nome + " (" + it.alvo + ")" : it.alvo;
    cabeca.append(marca, el("span", "item-nome", "Enviar este: " + nome));
    secao.append(cabeca);
    if (it.destaque) secao.append(el("p", "destaque", it.destaque));
    if (it.ultima) {
      const quando = dataCurta(it.ultima.data);
      secao.append(el("p", "rotulo", "Última mensagem que você recebeu (só para ler)" + (quando ? " · " + quando : "")), el("p", "texto atual", it.ultima.texto));
    }
    if (it.citada) secao.append(el("p", "rotulo", "Respondendo a"), el("p", "texto atual", it.citada));
    const caixas = [];
    const mensagens = decisao.mensagens[i] || [];
    mensagens.forEach((texto, k) => {
      const rotulo = el("label", "rotulo", mensagens.length > 1 ? "Mensagem " + (k + 1) + " de " + mensagens.length + " (você pode editar)" : "Sua resposta (você pode editar)");
      const campo = document.createElement("textarea");
      campo.className = "texto campo";
      campo.rows = 1;
      campo.value = texto;
      campo.spellcheck = true;
      campo.addEventListener("input", () => {
        ajustarAltura(campo);
        campo.classList.toggle("excedeu", !podeEnviar(campo.value, 4096, "caracteres"));
        atualizarBotoes();
      });
      rotulo.append(campo);
      secao.append(rotulo);
      caixas.push(campo);
      queueMicrotask(() => ajustarAltura(campo));
    });
    secao.classList.toggle("desmarcado", !marca.checked);
    lote.marcas.push(marca);
    lote.caixas.push(caixas);
    bloco.append(secao);
  });
  return bloco;
}

/** Depois do envio: uma linha por item (enviado, falhou e por quê, ou desmarcado). */
function mostrarResultadoDoLote(resultado) {
  const itens = resultadoDoLoteParaMostrar(resultado);
  const area = $("resultado-do-lote");
  if (!area || itens.length === 0) return;
  area.replaceChildren();
  for (const i of itens) {
    const li = el("li", i.estado === "enviado" ? "ok" : i.estado === "nao_enviado" ? "" : "erro", i.texto || i.conversa);
    area.append(li);
  }
  area.hidden = false;
}

/** O que veio de outra pessoa: últimas mensagens recebidas, a citada e os nomes (grupos e contatos). Só para ler. */
function blocoDeTerceiros(sc) {
  const ultimas = ultimasParaMostrar(sc);
  const citada = sc.conteudo_de_terceiros && typeof sc.conteudo_de_terceiros.citada === "string" ? sc.conteudo_de_terceiros.citada : "";
  const itens = itensParaMostrar(sc);
  if (ultimas.length === 0 && !citada && itens.length === 0) return null;
  const bloco = el("div");
  if (itens.length > 0) {
    bloco.append(el("p", "rotulo", "Nomes (escolhidos por outras pessoas)"));
    const lista = el("ul", "recebidas");
    for (const i of itens) {
      const li = el("li");
      li.append(el("span", "quando", i.id), document.createTextNode(i.nome));
      lista.append(li);
    }
    bloco.append(lista);
  }
  if (ultimas.length > 0) {
    bloco.append(el("p", "rotulo", "Últimas mensagens que você recebeu (só para ler)"));
    const lista = el("ul", "recebidas");
    for (const m of ultimas) {
      const li = el("li");
      const quando = dataCurta(m.data);
      if (quando) li.append(el("span", "quando", quando));
      li.append(document.createTextNode(m.texto));
      lista.append(li);
    }
    bloco.append(lista);
  }
  if (citada) {
    const rotulo = el("p", "rotulo", "Respondendo a");
    rotulo.style.marginTop = "8px";
    bloco.append(rotulo, el("p", "texto", citada));
  }
  return bloco;
}

function desenhar(sc) {
  const raiz = $("previa");
  raiz.replaceChildren();
  raiz.className = "cartao";
  raiz.append(el("p", "conta", "WhatsApp pessoal · pedido " + (sc.pedido || "?")));
  if (sc.irreversivel) raiz.append(el("p", "sem-volta", "NÃO TEM VOLTA"));
  raiz.append(el("h1", "", sc.titulo || "Confirmar"));
  const destaque = destaqueParaMostrar(sc);
  if (destaque) raiz.append(el("p", "destaque", destaque));

  if (sc.tipo !== "parear" && sc.tipo !== "responder_lote") {
    const para = el("p", "linha");
    para.append(el("b", "", "Para: "), document.createTextNode(destinatario(sc)));
    raiz.append(para);
  }

  if (Array.isArray(sc.riscos) && sc.riscos.length > 0) {
    const lista = el("ul", "riscos");
    for (const r of sc.riscos) if (typeof r === "string") lista.append(el("li", "", r));
    raiz.append(lista);
  }

  // 0.7.0, parte 2: o arquivo que vai sair, com o caminho REAL inteiro (o servidor já resolveu os links).
  const arquivo = arquivoParaMostrar(sc);
  if (arquivo) {
    const bloco = el("div", "arquivo");
    bloco.append(el("p", "rotulo", "Arquivo"));
    if (arquivo.imagem) {
      const foto = document.createElement("img");
      foto.className = "foto";
      foto.alt = "A foto que vai ser enviada";
      foto.src = arquivo.imagem;
      bloco.append(foto);
    }
    for (const [rotulo, valor] of [["Nome: ", arquivo.nome], ["Tipo: ", arquivo.tipo], ["Tamanho: ", arquivo.tamanho], ["Caminho: ", arquivo.caminho]]) {
      const linha = el("p", "linha");
      linha.append(el("b", "", rotulo), document.createTextNode(valor));
      bloco.append(linha);
    }
    raiz.append(bloco);
  }

  const terceiros = sc.tipo === "responder_lote" ? null : blocoDeTerceiros(sc);
  if (terceiros) raiz.append(terceiros);
  const atual = mensagemAtualParaMostrar(sc);
  if (atual) {
    const bloco = el("div");
    const quando = dataCurta(atual.data);
    bloco.append(el("p", "rotulo", rotuloDaMensagemAtual(sc.tipo) + (quando ? " · " + quando : "")), el("p", "texto atual", atual.texto));
    raiz.append(bloco);
  }
  if (sc.tipo === "responder_lote") {
    raiz.append(blocoDoLote(sc));
    const resultado = el("ul", "resultado-do-lote");
    resultado.id = "resultado-do-lote";
    resultado.hidden = true;
    raiz.append(resultado);
  } else if (typeof sc.texto === "string") raiz.append(blocoDoTexto(sc));

  const { aVista, recolhidas } = separarDetalhes(sc.detalhes);
  const listaDe = (linhas) => {
    const lista = el("ul", "detalhes");
    for (const d of linhas) lista.append(el("li", "", d));
    return lista;
  };
  if (aVista.length > 0) raiz.append(listaDe(aVista));
  if (recolhidas.length > 0) {
    const mais = el("details", "mais");
    mais.append(el("summary", "", "Ver detalhes (" + recolhidas.length + ")"), listaDe(recolhidas));
    raiz.append(mais);
  }

  const qr = el("div", "qr");
  qr.id = "qr";
  qr.hidden = true;
  raiz.append(qr);

  const botoes = el("div", "botoes");
  botoes.id = "botoes";
  const cancelar = el("button", "", "Cancelar");
  cancelar.id = "cancelar";
  cancelar.type = "button";
  const acao = el("button", "acao" + (sc.irreversivel ? " perigo" : ""), sc.botao || "Confirmar");
  acao.id = "acao";
  acao.type = "button";
  botoes.append(cancelar, acao);
  raiz.append(botoes, el("p", "estado"));
  raiz.lastChild.id = "estado";

  cancelar.addEventListener("click", () => decidir("cancelar"));
  acao.addEventListener("click", () => decidir("confirmar"));
  mostrarEstado("Clique uma vez e espere.");
  $("esqueleto").hidden = true;
  raiz.hidden = false;
  atualizarBotoes();
}

function textoDoResultado(r) {
  const bloco = r && Array.isArray(r.content) ? r.content.find((c) => c.type === "text") : null;
  return bloco ? bloco.text : "";
}

/** O QR num <svg> montado aqui (sem imagem em data URL): fundo branco fixo e módulos pretos, com a margem clara. */
function svgDoQr(matriz) {
  const { lado, d } = caminhoDoQr(matriz);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 " + lado + " " + lado);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "QR para conectar o WhatsApp a este computador");
  svg.setAttribute("shape-rendering", "crispEdges");
  const fundo = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  fundo.setAttribute("width", String(lado));
  fundo.setAttribute("height", String(lado));
  fundo.setAttribute("fill", "#ffffff");
  const modulos = document.createElementNS("http://www.w3.org/2000/svg", "path");
  modulos.setAttribute("d", d);
  modulos.setAttribute("fill", "#000000");
  svg.append(fundo, modulos);
  return svg;
}

/**
 * Desenha uma etapa do pareamento: QR com contagem, ou a frase da etapa. `semServidor`: o cartão não se atualiza
 * sozinho (aba Code); quando a contagem acaba, o QR fica apagado e o texto manda clicar em "Mostrar novo QR".
 */
function mostrarEtapa(e, semServidor = false) {
  const area = $("qr");
  if (!area) return;
  if (relogioDoQr) {
    clearInterval(relogioDoQr);
    relogioDoQr = null;
  }
  area.replaceChildren();
  if (e.etapa === "qr" && e.matriz) {
    const svg = svgDoQr(e.matriz);
    const contagem = el("p", "contagem");
    const recebidoEm = Date.now();
    const tique = () => {
      const faltam = segundosQueFaltam(e.segundos, recebidoEm, Date.now());
      contagem.textContent = semServidor ? rotuloDaContagemSemServidor(faltam) : rotuloDaContagem(faltam);
      if (semServidor && faltam <= 0) {
        svg.classList.add("vencido");
        clearInterval(relogioDoQr);
        relogioDoQr = null;
      }
    };
    tique();
    if (e.segundos > 0) relogioDoQr = setInterval(tique, 1_000);
    area.append(svg, contagem);
    area.hidden = false;
    mostrarEstado(fraseDaEtapa(e));
    return;
  }
  area.hidden = true;
  mostrarEstado(fraseDaEtapa(e), e.etapa === "conectado" ? "ok" : e.etapa === "expirado" || e.etapa === "parado" || e.etapa === "inexistente" ? "erro" : "");
}

/** Pareamento confirmado: esconde os botões e acompanha o QR até conectar, vencer ou parar. */
async function acompanharQr(minhaGeracao) {
  const botoes = $("botoes");
  if (botoes) botoes.hidden = true;
  mostrarEstado("Gerando o QR…");
  const id = pedido.id;
  await acompanharPareamento({
    consultar: () => app.callServerTool({ name: "wa_estado_pareamento_tela", arguments: { id } }),
    mostrar: mostrarEtapa,
    esperar: (ms) => new Promise((pronto) => setTimeout(pronto, ms)),
    agora: () => Date.now(),
    cancelado: () => minhaGeracao !== geracao,
  });
  if (relogioDoQr) {
    clearInterval(relogioDoQr);
    relogioDoQr = null;
  }
}

async function decidir(decisao) {
  if (travado || !pedido) return;
  cliqueDado = true;
  const atual = decisao === "confirmar" ? textoAtual() : null;
  const editado = atual !== null && atual !== pedido.original ? atual : null;
  const codigo = editado !== null ? codigoEditado(pedido.codigo, editado) : pedido.codigo;
  travar(true);
  mostrarEstado(pedido.tipo === "responder" || pedido.tipo === "responder_lote" ? "Enviando… clique uma vez e espere." : "Um momento… clique uma vez e espere.");
  const comServerTools = temServerTools();
  const minhaGeracao = geracao;
  try {
    if (comServerTools) {
      const r = await app.callServerTool(
        decisao === "confirmar"
          ? { name: "wa_confirmar_tela", arguments: { id: pedido.id, codigo, ...(editado !== null ? { texto: editado } : {}) } }
          : { name: "wa_cancelar_pedido", arguments: { id: pedido.id } },
      );
      mostrarEstado(textoDoResultado(r) || (r.isError ? "Não deu certo." : "Pronto."), r.isError ? "erro" : "ok");
      if (lote && !r.isError && r.structuredContent && r.structuredContent.resultado) mostrarResultadoDoLote(r.structuredContent.resultado);
      if (r.isError && decisao === "confirmar" && editado !== null && !/cancelado|venceu|já foi usado|não existe/.test(textoDoResultado(r))) {
        // Texto recusado pelo servidor (vazio, grande demais): o pedido segue pendente, o dono pode corrigir.
        travar(false);
        return;
      }
      encerrar();
      if (!r.isError && pedido.tipo !== "parear") await avisarOClaude(decisao, r);
      if (!r.isError && decisao === "confirmar" && pedido.tipo === "parear") await acompanharQr(minhaGeracao);
      return;
    }
    // Com texto editável, vai o código preso ao texto mostrado (editado ou não) e o texto; nunca o código cru.
    const texto = decisao === "confirmar" ? confirmacaoPeloChat(pedido.id, pedido.codigo, pedido.edicao ? (atual ?? pedido.original ?? "") : null) : "Cancelo o pedido " + pedido.id + ".";
    const r = await app.sendMessage({ role: "user", content: [{ type: "text", text: texto }] });
    if (r && r.isError) throw new Error("o app do Claude recusou a mensagem");
    encerrar();
    const enviada = pedido.tipo === "parear" ? "Mensagem enviada ao Claude. O QR aparece num cartão novo, logo abaixo." : "Mensagem enviada ao Claude. Espere ele concluir.";
    mostrarEstado(decisao === "confirmar" ? enviada : "Cancelamento enviado ao Claude. Nada foi enviado ao WhatsApp.", "ok");
  } catch (erro) {
    if (comServerTools) {
      mostrarEstado("Não consegui falar com o servidor: " + (erro && erro.message ? erro.message : "erro"), "erro");
      return;
    }
    mostrarEstado("O app do Claude não aceitou a mensagem. Clique de novo, uma vez, e espere.", "erro");
    travar(false);
  }
}

/**
 * Depois do clique pelo servidor (serverTools), o Claude não fica sabendo: callServerTool não volta ao modelo.
 * Avisa por dois caminhos do MCP Apps: ui/update-model-context (contexto da próxima resposta) e ui/message
 * (mensagem na conversa, que acorda o Claude para seguir sozinho). Só informa o resultado; nunca leva código.
 * Falhar aqui não desfaz nada: o envio já aconteceu e o cartão já mostrou o resultado.
 */
async function avisarOClaude(decisao, r) {
  let texto;
  if (decisao !== "confirmar") {
    texto = `[cartão ${pedido.id}] Cancelei. Nada foi enviado.`;
  } else {
    const res = r && r.structuredContent && r.structuredContent.resultado;
    if (Array.isArray(res)) {
      const linhas = res.map((i) => i.frase || `${i.conversa}: ${i.estado}`).join("; ");
      texto = `[cartão ${pedido.id}] Cliquei em Enviar todas. Resultado: ${linhas}. Pode seguir.`;
    } else {
      texto = `[cartão ${pedido.id}] Cliquei em Enviar. ${textoDoResultado(r) || "Enviado."} Pode seguir.`;
    }
  }
  const content = [{ type: "text", text: texto.slice(0, 2000) }];
  // Só o contexto silencioso: no Claude Desktop o ui/message cai na caixa de digitação e obriga o dono a apertar
  // Enter (testado em 17/11/2026). Na aba Code, a skill vigia o acoes.jsonl e o Claude acorda sozinho.
  try { await app.updateModelContext({ content }); } catch { /* host sem suporte */ }
}

/** Cartão remontado: pergunta ao servidor como está o pedido e se ajusta. Se a consulta falhar, o cartão fica como está. */
async function ajustarPeloEstado(minhaGeracao) {
  if (!temServerTools()) return;
  const id = pedido.id;
  const consultar = () => app.callServerTool({ name: "wa_estado_pedido_tela", arguments: { id } });
  const superado = () => cliqueDado || encerrado || minhaGeracao !== geracao;
  try {
    let r = await consultar();
    if (superado()) return;
    let plano = planoDaSituacao(r, pedido.tipo);
    if (plano.acao === "nada") return;
    encerrar();
    mostrarEstado(plano.mensagem, plano.tipo);
    if (plano.acao === "enviando") {
      const fim = await aguardarEnvio({
        consultar,
        esperar: (ms) => new Promise((pronto) => setTimeout(pronto, ms)),
        agora: () => Date.now(),
        cancelado: () => minhaGeracao !== geracao,
      });
      if (fim === null) return;
      r = fim;
      plano = planoDaSituacao(r, pedido.tipo);
      if (plano.acao === "nada" || plano.acao === "enviando") return;
      mostrarEstado(plano.mensagem, plano.tipo);
    }
    if (plano.acao === "parear") await acompanharQr(minhaGeracao);
  } catch {
    // Consulta falhou: o cartão fica como está.
  }
}

/** Botão do cartão do QR sem serverTools: manda a mensagem no chat (precisa do clique de verdade). */
async function mandarDoCartaoDoQr(texto, botoes) {
  for (const b of botoes) b.disabled = true;
  try {
    const r = await app.sendMessage({ role: "user", content: [{ type: "text", text: texto }] });
    if (r && r.isError) throw new Error("recusada");
    mostrarEstado("Mensagem enviada ao Claude. Espere ele responder.", "ok");
  } catch {
    for (const b of botoes) b.disabled = false;
    mostrarEstado("O app do Claude não aceitou a mensagem. Clique de novo, uma vez, e espere.", "erro");
  }
}

/**
 * Cartão do QR: o resultado do wa_confirmar de um pareamento ou do wa_qr (`_meta.pareamento`). Com serverTools,
 * acompanha o pareamento como o cartão do clique; sem (aba Code), mostra o QR e os botões que falam com o Claude.
 */
function desenharPareamento(resultado) {
  const meta = resultado._meta || {};
  const id = meta.pareamento && typeof meta.pareamento.pedido === "string" ? meta.pareamento.pedido : "?";
  pedido = { id, codigo: null, tipo: "parear", original: null, edicao: null };
  cliqueDado = true;
  encerrado = true;
  travado = true;
  const raiz = $("previa");
  raiz.replaceChildren();
  raiz.className = "cartao";
  raiz.append(el("p", "conta", "WhatsApp pessoal · pedido " + id), el("h1", "", "Conectar o WhatsApp a este computador"));
  const qr = el("div", "qr");
  qr.id = "qr";
  qr.hidden = true;
  raiz.append(qr);
  const botoes = el("div", "botoes");
  const jaEscaneei = el("button", "", "Já escaneei");
  jaEscaneei.type = "button";
  const novo = el("button", "acao", "Mostrar novo QR");
  novo.type = "button";
  botoes.append(jaEscaneei, novo);
  const estado = el("p", "estado");
  estado.id = "estado";
  raiz.append(botoes, estado);
  $("esqueleto").hidden = true;
  raiz.hidden = false;

  const e = lerEtapa(resultado);
  if (!e) {
    botoes.hidden = true;
    mostrarEstado(textoDoResultado(resultado) || "Não deu para mostrar o QR. Peça ao Claude um QR novo.", "erro");
    return;
  }
  if (temServerTools()) {
    botoes.hidden = true;
    mostrarEtapa(e);
    if (e.etapa === "qr" || e.etapa === "gerando_qr" || e.etapa === "conectando") acompanharQr(geracao);
    return;
  }
  mostrarEtapa(e, true);
  if (e.etapa === "gerando_qr") mostrarEstado("O QR ainda não chegou. Clique em Mostrar novo QR daqui a pouco.");
  // Só há o que pedir enquanto o pareamento anda: QR na tela, QR a caminho ou QR já lido.
  botoes.hidden = !(e.etapa === "qr" || e.etapa === "gerando_qr" || e.etapa === "conectando");
  if (e.etapa === "conectando") novo.hidden = true;
  const todos = [jaEscaneei, novo];
  novo.addEventListener("click", () => mandarDoCartaoDoQr(mensagemNovoQr(id), todos));
  jaEscaneei.addEventListener("click", () => mandarDoCartaoDoQr(mensagemJaEscaneei(id), todos));
}

app.ontoolresult = (resultado) => {
  geracao++;
  const bruto = resultado.structuredContent || {};
  const meta = resultado._meta || {};
  if (!resultado.isError && meta.pareamento && typeof meta.pareamento === "object") {
    desenharPareamento(resultado);
    return;
  }
  const sc = meta.previa && typeof meta.previa === "object" ? { ...meta.previa, pedido: bruto.pedido } : bruto;
  if (!sc.pedido || !meta.codigo) {
    // Resultado sem prévia (recusa, erro): mostra o texto e mais nada.
    const bloco = $("previa");
    bloco.replaceChildren(el("p", "estado", textoDoResultado(resultado) || "Sem prévia para mostrar."));
    $("esqueleto").hidden = true;
    bloco.hidden = false;
    return;
  }
  const edicao = sc.texto_editavel && typeof sc.texto_editavel.limite === "number" && typeof sc.texto === "string" ? sc.texto_editavel : null;
  lote = null;
  pedido = { id: sc.pedido, codigo: meta.codigo, tipo: sc.tipo || "responder", original: typeof sc.texto === "string" ? sc.texto : null, edicao };
  cliqueDado = false;
  encerrado = false;
  travado = false;
  desenhar(sc);
  ajustarPeloEstado(geracao);
};
app.onhostcontextchanged = (ctx) => aplicarContexto(ctx);

await app.connect();
aplicarContexto(app.getHostContext());
