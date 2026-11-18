// Pedidos pendentes de confirmação. Adaptado do MCP do Instagram (src/confirmacao.ts), já provado no Claude Desktop.
// Ficam só em memória: se o servidor reiniciar, eles se perdem e nada é enviado.
//
// Um pedido guarda o corpo EXATO do que vai acontecer, o hash dele e uma função `enviar`.
// O código de 128 bits só existe aqui e no `_meta` da prévia (o modelo não o vê). Confirmar confere
// código, validade, uso único e hash; depois executa o corpo guardado, sem montar de novo.
//
// 0.16.0 (revisão de segurança): DOIS códigos por pedido, para o `_meta` nunca levar algo que o wa_confirmar aceite (se
// um cliente repassasse o `_meta` ao modelo, ele confirmaria sozinho os pedidos sem texto):
// - o código DE TELA (o de 128 bits, no `_meta.codigo`): só pelo wa_confirmar_tela (`visibility: ["app"]`);
// - o código DE CONVERSA (codigoDeConversa): SHA-256("conversa\n" + código de tela), que o cartão calcula na hora do
//   clique e manda no chat (aba Code): só pelo wa_confirmar. Não vai em `content`, `structuredContent` nem `_meta`.
// Num pedido com texto, cada caminho prende o SEU código ao texto (codigoDoTextoEditado). Limite que fica: o código de
// conversa sai de uma conta pública sobre o de tela; um cliente que repasse o `_meta` E um modelo que rode código ainda
// poderiam refazê-la. Fechar de vez exigiria tirar o caminho do chat (sem ele, a aba Code não confirma nada).
//
// Diferenças do Instagram:
// - o registro de ações NUNCA leva o texto (nem o da resposta, nem o de terceiros): só o tamanho;
// - sem a janela nativa de reserva: sem cartão, a ferramenta diz "Bloqueado" e nada acontece;
// - desde a 0.5.0 o pareamento também se confirma pelo wa_confirmar (aba Code, cartão sem serverTools): o código só
//   existe no `_meta` e chega ao modelo na mensagem que o clique no cartão manda; o QR continua só no `_meta`;
// - pedido com texto editável (wa_responder): pelo wa_confirmar (o caminho do modelo), só vale `texto` com o código
//   preso a ele (codigoDoTextoEditado). O código cru sem texto é recusado e conta como tentativa errada: com o código
//   cru, o modelo calcularia o código de um texto que o dono nunca viu. O código cru só vale pelo wa_confirmar_tela,
//   que é do cartão (app-only). Pedido sem texto (envio, desconectar, listas) aceita o código solto (desde a 0.16.0, o
//   de conversa): o corpo é fixo desde a prévia e não há campo que o modelo possa trocar (um `texto` nesses pedidos é
//   recusado).

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { destinatario } from "../ui/edicao.js";
import type { RegistroAcoes } from "./registro-acoes.ts";

export const VALIDADE_MS = 10 * 60 * 1000;
export const MAX_ERROS_DE_CODIGO = 3;

/** Por onde veio o clique que autorizou (vai para o registro de ações). */
export type CaminhoDeConfirmacao = "wa_confirmar_tela" | "wa_confirmar";

/** Que cartão é: o cartão muda o desenho conforme o tipo. */
export type TipoDoPedido = "responder" | "envio" | "desconectar" | "parear" | "listas" | "iniciar" | "editar" | "apagar" | "arquivo" | "modelo" | "responder_lote";

/** O que o dono vê antes de clicar. Montada a partir do MESMO objeto que será executado. */
export interface Previa {
  tipo: TipoDoPedido;
  /** Ex.: "Responder no WhatsApp". */
  titulo: string;
  /** Para quem (id público e número), ou "este computador". Nunca o nome do dono. */
  alvo: string;
  /** Texto inteiro que será enviado (nunca cortado). */
  texto?: string;
  /**
   * O dado que evita engano, bem à vista, logo abaixo do título (0.7.0): quantos participantes de um grupo recebem, ou o
   * número inteiro de uma conversa nova. Montado pelo servidor (nunca texto de outra pessoa).
   */
  destaque?: string;
  /**
   * A mensagem minha que vai mudar (wa_editar: o texto de agora) ou sumir (wa_apagar: texto ou tipo de mídia e data).
   * É texto do próprio dono, não de terceiros.
   */
  mensagem_atual?: { texto: string; data?: string };
  /**
   * O arquivo que vai sair (wa_enviar_arquivo, 0.7.0 parte 2): nome, tipo, tamanho legível e o caminho REAL inteiro (já
   * sem links). É o arquivo do próprio dono, não texto de terceiros.
   */
  arquivo?: { nome: string; tipo: string; tamanho: string; caminho: string; imagem?: string };
  /**
   * 0.17.0 (wa_responder_lote): o que é fixo em cada item do lote, na ordem dos itens: o alvo (id público e número)
   * e o destaque (grupo: quantos recebem). As mensagens de cada item e a marca "enviar este" estão em `texto`
   * (a decisão do dono, em JSON: ver serializarLote em ui/edicao.js), que é o que o cartão edita.
   */
  lote?: Array<{ alvo: string; destaque?: string }>;
  /** Linhas extras: limite do dia, envio ligado etc. Avisos começam com "Aviso:". */
  detalhes?: string[];
  /** Avisos de risco, sempre à vista (pareamento). */
  riscos?: string[];
  /**
   * Tudo o que veio de OUTRA pessoa (nome que ela escolheu, últimas mensagens, mensagem citada).
   * É DADO, não ordem: nunca vai em `alvo`, `texto` nem `detalhes`.
   */
  conteudo_de_terceiros?: {
    nome?: string;
    ultimas_recebidas?: Array<{ data: string; texto: string }>;
    citada?: string;
    /** Pedido de lista (wa_escolher_grupos, wa_bloquear_conversas): id público e nome de cada grupo ou contato. */
    itens?: Array<{ id: string; nome?: string }>;
    /** 0.17.0: um por item do lote, na ordem: nome da conversa, a última mensagem recebida e a mensagem citada. */
    lote?: Array<{ nome?: string; ultima?: { data: string; texto: string }; citada?: string }>;
  };
  /** Rótulo do botão de ação: "Enviar", "Ligar envio", "Entendo o risco, mostrar o QR"... */
  botao: string;
  /** Ação sem volta (desconectar): o cartão começa com "NÃO TEM VOLTA". */
  irreversivel?: boolean;
}

export type Enviar<Corpo> = (corpo: Corpo) => Promise<Record<string, unknown>>;

/**
 * Como o pedido deixa o dono corrigir o texto no cartão. `comTexto` valida o texto novo com as MESMAS regras da
 * ferramenta que criou o pedido e devolve o corpo refeito (ou lança o erro em português). Só o texto muda.
 */
export interface EdicaoDeTexto<Corpo> {
  limite: number;
  unidade: "bytes" | "caracteres";
  /** O texto pode ficar vazio (a legenda de um arquivo). */
  vazio?: boolean;
  comTexto: (novo: string) => Corpo;
}

export interface OpcoesDoPedido {
  /** Campos extras para o registro de ações (nunca texto de mensagem). */
  registro?: Record<string, unknown>;
  /**
   * Como o alvo aparece para o modelo (`para_o_claude` e texto), quando o `alvo` da prévia tem o que o modelo não deve
   * ver: o número INTEIRO de uma conversa nova vai só no cartão (`_meta`), e o modelo vê o id público.
   */
  alvoParaOClaude?: string;
  /**
   * 0.12.0: o pedido terminou sem envio (cancelado, inclusive pelo terceiro erro, ou vencido): o aprendizado conta só
   * isso, nunca o texto. Chamado uma vez; erro aqui não muda nada no pedido.
   */
  aoDesistir?: (motivo: "cancelado" | "expirado") => void;
}

type Estado = "pendente" | "usado" | "cancelado" | "expirado";

interface Pedido {
  id: string;
  ferramenta: string;
  codigo: string;
  expiraEm: number;
  hash: string;
  corpo: unknown;
  previa: Previa;
  enviar: Enviar<never>;
  edicao: EdicaoDeTexto<unknown> | undefined;
  registroExtra: Record<string, unknown>;
  aoDesistir: OpcoesDoPedido["aoDesistir"];
  estado: Estado;
  erros: number;
  /** O texto enviado não é o da prévia (o dono editou no cartão). */
  editado: boolean;
  /** Uma confirmação em andamento: um segundo pedido ao mesmo tempo é recusado (duplo clique). */
  emAndamento: boolean;
  /** O que o envio devolveu, quando terminou bem. O cartão remontado pergunta por aqui (ver `situacao`). */
  resultadoDoEnvio: Record<string, unknown> | undefined;
  /** O envio foi tentado e falhou. */
  envioFalhou: boolean;
}

/** Como o pedido está, para o cartão que remonta e precisa se ajustar. Nunca leva o código do pedido. */
export type Situacao = {
  estado: "pendente" | "enviando" | "usado" | "falhou" | "cancelado" | "expirado" | "inexistente";
  tipo?: TipoDoPedido;
  /** Só em "usado": o resultado do envio (o mesmo de wa_confirmar_tela). */
  resultado?: Record<string, unknown>;
};

export type Decisao =
  | { ok: true; id: string; resultado: Record<string, unknown>; resumo: string }
  | { ok: false; motivo: string; falhaNoEnvio?: boolean };

const sha256 = (texto: string): string => createHash("sha256").update(texto).digest("hex");

function congelar<T>(valor: T): T {
  if (typeof valor === "object" && valor !== null && !Object.isFrozen(valor)) {
    Object.freeze(valor);
    for (const filho of Object.values(valor)) congelar(filho);
  }
  return valor;
}

/**
 * Código de um pedido com o texto editado no cartão: SHA-256(codigo + "\n" + texto), 32 primeiros caracteres em hexadecimal.
 * O cartão faz a mesma conta (ui/sha256.js). Quem não conhece `codigo` não consegue gerar um código para outro texto.
 */
export function codigoDoTextoEditado(codigo: string, texto: string): string {
  return sha256(`${codigo}\n${texto}`).slice(0, 32);
}

/**
 * 0.16.0: o código DE CONVERSA de um pedido: SHA-256("conversa\n" + código de tela), 32 primeiros caracteres em
 * hexadecimal. É o único que o wa_confirmar aceita; o cartão faz a mesma conta (ui/edicao.js, codigoDeConversa).
 */
export function codigoDeConversa(codigo: string): string {
  return sha256(`conversa\n${codigo}`).slice(0, 32);
}

function codigosIguais(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

export class Pedidos {
  readonly #pedidos = new Map<string, Pedido>();
  /** O último pedido de cada tipo confirmado com o código (o wa_qr acha por aqui o pareamento autorizado). */
  readonly #ultimoConfirmado = new Map<TipoDoPedido, string>();
  readonly #registro: RegistroAcoes;
  readonly #agora: () => number;

  constructor(registro: RegistroAcoes, agora: () => number = Date.now) {
    this.#registro = registro;
    this.#agora = agora;
  }

  criar<Corpo>(
    ferramenta: string,
    corpo: Corpo,
    previa: Previa,
    enviar: Enviar<Corpo>,
    edicao?: EdicaoDeTexto<Corpo>,
    opcoes: OpcoesDoPedido = {},
  ): { id: string; codigo: string; expiraEm: number } {
    const id = randomBytes(4).toString("hex");
    const codigo = randomBytes(16).toString("hex");
    const guardado = congelar(structuredClone(corpo));
    const expiraEm = this.#agora() + VALIDADE_MS;
    this.#pedidos.set(id, {
      id,
      ferramenta,
      codigo,
      expiraEm,
      hash: sha256(JSON.stringify(guardado)),
      corpo: guardado,
      previa,
      enviar: enviar as Enviar<never>,
      edicao: edicao as EdicaoDeTexto<unknown> | undefined,
      registroExtra: opcoes.registro ?? {},
      aoDesistir: opcoes.aoDesistir,
      estado: "pendente",
      erros: 0,
      editado: false,
      emAndamento: false,
      resultadoDoEnvio: undefined,
      envioFalhou: false,
    });
    return { id, codigo, expiraEm };
  }

  estado(id: string): Estado | "inexistente" {
    return this.#pedidos.get(id)?.estado ?? "inexistente";
  }

  /** O último pedido deste tipo que foi confirmado (clique), ou undefined. */
  ultimoConfirmado(tipo: TipoDoPedido): string | undefined {
    return this.#ultimoConfirmado.get(tipo);
  }

  /** O tipo do pedido (para wa_estado_pareamento_tela conferir que é um pareamento). */
  tipo(id: string): TipoDoPedido | undefined {
    return this.#pedidos.get(id)?.previa.tipo;
  }

  /**
   * Situação do pedido para o cartão que o Claude Desktop recriou (o iframe novo recebe o mesmo resultado da prévia e
   * se desenharia do zero). Só leitura: não grava nada no registro de ações, nem quando o pedido venceu.
   */
  situacao(id: string): Situacao {
    const pedido = this.#pedidos.get(id);
    if (!pedido) return { estado: "inexistente" };
    const tipo = pedido.previa.tipo;
    if (pedido.estado === "usado") {
      if (pedido.resultadoDoEnvio !== undefined) return { estado: "usado", tipo, resultado: pedido.resultadoDoEnvio };
      return { estado: pedido.envioFalhou ? "falhou" : "enviando", tipo };
    }
    if (pedido.estado === "pendente" && this.#agora() > pedido.expiraEm) return { estado: "expirado", tipo };
    return { estado: pedido.estado, tipo };
  }

  /**
   * Confirma com o código (wa_confirmar e wa_confirmar_tela). Com `texto`, o dono editou o texto no cartão:
   * o código tem que ser o editado (ver codigoDoTextoEditado) e o texto passa pelas validações da ferramenta.
   */
  async confirmar(id: string, codigo: string, caminho: CaminhoDeConfirmacao, texto?: string): Promise<Decisao> {
    const pedido = this.#pedidos.get(id);
    if (pedido?.emAndamento) return { ok: false, motivo: `Pedido ${id} já está sendo confirmado. Espere, sem clicar de novo.` };
    if (pedido) pedido.emAndamento = true; // antes de qualquer espera
    try {
      return await this.#confirmarComCodigo(id, codigo, caminho, texto);
    } finally {
      if (pedido) pedido.emAndamento = false;
    }
  }

  async #confirmarComCodigo(id: string, codigo: string, caminho: CaminhoDeConfirmacao, texto: string | undefined): Promise<Decisao> {
    const pedido = this.#conferir(id, caminho);
    if ("ok" in pedido) return pedido;
    if (pedido.edicao && texto === undefined && caminho === "wa_confirmar") {
      return this.#recusarTentativa(
        pedido,
        caminho,
        codigo,
        "código sem o texto pelo wa_confirmar",
        `O pedido ${id} tem texto: pelo wa_confirmar, só vale o código que chega junto com o texto na mensagem do dono ("Confirmo o pedido ${id}, código <codigo>, com este texto:" e o texto). Nada foi enviado.`,
      );
    }
    // 0.16.0: o wa_confirmar (do modelo) só aceita o código de conversa; o wa_confirmar_tela (do cartão), o de tela.
    const base = caminho === "wa_confirmar" ? codigoDeConversa(pedido.codigo) : pedido.codigo;
    const esperado = texto === undefined ? base : codigoDoTextoEditado(base, texto);
    if (texto !== undefined && !pedido.edicao) return this.#recusarTentativa(pedido, caminho, codigo, "este pedido não aceita texto novo", `O pedido ${id} não aceita texto novo (só o texto da resposta é editável).`);
    if (!codigosIguais(codigo, esperado)) return this.#recusarTentativa(pedido, caminho, codigo, "código errado");
    if (texto === undefined) return this.#enviar(pedido, caminho, pedido.codigo.slice(0, 4));

    // Texto editado e código conferido: o texto passa pelas mesmas validações da ferramenta antes de qualquer envio.
    let corpoNovo: unknown;
    try {
      corpoNovo = pedido.edicao!.comTexto(texto);
    } catch (erro) {
      const motivo = erro instanceof Error ? erro.message : String(erro);
      return this.#recusarTentativa(pedido, caminho, codigo, "texto editado recusado", motivo);
    }
    const guardado = congelar(structuredClone(corpoNovo));
    pedido.corpo = guardado;
    pedido.hash = sha256(JSON.stringify(guardado));
    const textoAntes = pedido.previa.texto;
    pedido.previa = { ...pedido.previa, texto };
    pedido.editado = texto !== textoAntes;
    return this.#enviar(pedido, caminho, pedido.codigo.slice(0, 4));
  }

  /** Erro de código ou de texto: conta tentativa; na terceira, cancela o pedido. */
  async #recusarTentativa(pedido: Pedido, caminho: CaminhoDeConfirmacao, codigo: string, motivoNoRegistro: string, frase?: string): Promise<Decisao> {
    pedido.erros++;
    if (pedido.erros >= MAX_ERROS_DE_CODIGO) {
      pedido.estado = "cancelado";
      Pedidos.#desistiu(pedido, "cancelado");
      this.#registrar(pedido, "recusado", caminho, { motivo: `${motivoNoRegistro}; três erros: pedido cancelado`, codigo4: codigo.slice(0, 4) });
      const final = `o pedido ${pedido.id} foi cancelado. Nada foi enviado.`;
      return { ok: false, motivo: frase ? `${frase} Foi a ${MAX_ERROS_DE_CODIGO}ª recusa: ${final}` : `Código errado pela ${MAX_ERROS_DE_CODIGO}ª vez: ${final}` };
    }
    this.#registrar(pedido, "recusado", caminho, { motivo: motivoNoRegistro, codigo4: codigo.slice(0, 4) });
    return { ok: false, motivo: frase ? `${frase} Tentativa ${pedido.erros} de ${MAX_ERROS_DE_CODIGO}.` : `Código errado (${pedido.erros} de ${MAX_ERROS_DE_CODIGO}). Nada foi enviado.` };
  }

  async cancelar(id: string, origem: string): Promise<{ ok: boolean; mensagem: string }> {
    const pedido = this.#pedidos.get(id);
    if (!pedido) return { ok: false, mensagem: `Pedido ${id} não existe (pode ter expirado ou o servidor reiniciou). Nada foi enviado.` };
    if (pedido.estado === "pendente") {
      pedido.estado = "cancelado";
      Pedidos.#desistiu(pedido, "cancelado");
      this.#registrar(pedido, "cancelado", null, { origem });
      return { ok: true, mensagem: `Pedido ${id} cancelado. Nada foi enviado.` };
    }
    if (pedido.estado === "cancelado") return { ok: true, mensagem: `Pedido ${id} já estava cancelado. Nada foi enviado.` };
    if (pedido.estado === "usado") return { ok: false, mensagem: `Pedido ${id} já foi confirmado: não dá mais para cancelar.` };
    return { ok: false, mensagem: `Pedido ${id} venceu. Nada foi enviado.` };
  }

  static #desistiu(pedido: Pedido, motivo: "cancelado" | "expirado"): void {
    try {
      pedido.aoDesistir?.(motivo);
    } catch {
      // a contagem do aprendizado nunca muda o pedido
    }
  }

  /** Existência, uso único e validade. Devolve o pedido pendente ou a recusa. */
  #conferir(id: string, caminho: CaminhoDeConfirmacao): Pedido | Decisao {
    const pedido = this.#pedidos.get(id);
    if (!pedido) return { ok: false, motivo: `Pedido ${id} não existe (pode ter expirado ou o servidor reiniciou). Nada foi enviado.` };
    if (pedido.estado === "usado") return { ok: false, motivo: `Pedido ${id} já foi usado. Nada foi enviado de novo.` };
    if (pedido.estado === "cancelado") return { ok: false, motivo: `Pedido ${id} foi cancelado. Nada foi enviado.` };
    if (pedido.estado === "expirado" || this.#agora() > pedido.expiraEm) {
      if (pedido.estado !== "expirado") {
        pedido.estado = "expirado";
        Pedidos.#desistiu(pedido, "expirado");
        this.#registrar(pedido, "recusado", caminho, { motivo: "pedido vencido" });
      }
      return { ok: false, motivo: `Pedido ${id} venceu (10 minutos). Peça a prévia de novo. Nada foi enviado.` };
    }
    return pedido;
  }

  async #enviar(pedido: Pedido, caminho: CaminhoDeConfirmacao, codigo4: string): Promise<Decisao> {
    // O corpo guardado é um clone CONGELADO: este hash sempre bate. É conferência de sanidade.
    if (sha256(JSON.stringify(pedido.corpo)) !== pedido.hash) {
      pedido.estado = "cancelado";
      this.#registrar(pedido, "recusado", caminho, { motivo: "o corpo mudou depois da prévia" });
      return { ok: false, motivo: `O conteúdo do pedido ${pedido.id} mudou depois da prévia: cancelado. Nada foi enviado.` };
    }
    // Marca como usado ANTES de enviar: um segundo clique ou chamada em paralelo nunca envia duas vezes,
    // e uma falha no meio do caminho não deixa o código valer para uma segunda tentativa às cegas.
    pedido.estado = "usado";
    this.#ultimoConfirmado.set(pedido.previa.tipo, pedido.id);
    const inicio = this.#agora();
    try {
      const resultado = await (pedido.enviar as Enviar<unknown>)(pedido.corpo);
      pedido.resultadoDoEnvio = resultado;
      this.#registrar(pedido, "enviado", caminho, { resultado, duracao_ms: this.#agora() - inicio, codigo4 });
      return { ok: true, id: pedido.id, resultado, resumo: `${pedido.previa.titulo} → ${destinatario(pedido.previa)}` };
    } catch (erro) {
      pedido.envioFalhou = true;
      const mensagem = erro instanceof Error ? erro.message : String(erro);
      this.#registrar(pedido, "erro", caminho, { resultado: { erro: mensagem }, duracao_ms: this.#agora() - inicio, codigo4 });
      throw erro;
    }
  }

  /**
   * Registro sem texto de mensagem nenhuma: só o tamanho da resposta e se foi editada. O `alvo` da prévia pode ter o
   * número: quem cria o pedido o troca pelo id público em `opcoes.registro.alvo` (o registro sobrevive ao
   * wa_desconectar).
   */
  #registrar(pedido: Pedido, evento: string, caminho: CaminhoDeConfirmacao | null, extra: Record<string, unknown>): void {
    this.#registro.gravar({
      evento,
      pedido: pedido.id,
      ferramenta: pedido.ferramenta,
      alvo: pedido.previa.alvo,
      ...(pedido.previa.texto !== undefined ? { caracteres: [...pedido.previa.texto].length } : {}),
      ...(pedido.editado ? { editado: true } : {}),
      ...(caminho ? { confirmacao: caminho } : {}),
      ...pedido.registroExtra,
      ...extra,
    });
  }
}
