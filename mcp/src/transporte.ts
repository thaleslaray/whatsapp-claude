// Transporte Baileys: o WhatsApp como aparelho vinculado, dentro do próprio processo do MCP (sem ponte e sem porta).
// Adaptado do transporte vinculado do Nod (n8n), Apache-2.0:
//   /Applications/Nod.app/Contents/Resources/engine/src/providers/chat-sdk/whatsapp.ts
// Cada trava cita a linha do Nod de onde veio. Diferenças de propósito (ver FICHA.md):
//   - lê as conversas do dono (o Nod só fala na "Mensagem para mim"): histórico recente aceito, com as listas do dono;
//   - sem corte por `linkedAt` (Nod 270-276), porque aqui o passado recente é o que se quer ler;
//   - sem sessão pareada não conecta; o pareamento (QR) só acontece quando pedido (`parear: true`, wa_parear);
//   - responde (wa_responder) só depois do clique no cartão: "digitando" por 1 a 3 s, depois "pausado" (nunca
//     "disponível"), com id próprio guardado ANTES em `sentIds` (Nod whatsapp.ts:489-492) e conferido na volta.
//
// NUNCA marca como lida: não chama `readMessages`, não manda recibo de leitura e não fica "online"
// (`markOnlineOnConnect: false` faz a Baileys mandar presença `unavailable`; os recibos de entrega saem como `inactive`,
// lib/Socket/messages-recv.js:1413-1415). O `readMessages` do socket é trocado por uma função que recusa.

import makeWASocket, {
  Browsers,
  BufferJSON,
  DisconnectReason,
  generateMessageIDV2,
  initAuthCreds,
  proto,
  type AuthenticationState,
  type SignalDataTypeMap,
  type SocketConfig,
  type UserFacingSocketConfig,
  type WASocket,
  type WAMessage,
} from "@whiskeysockets/baileys";
import { PRIORIDADE, type Banco, type CacheDeGrupos, type ContatoParaAplicar, type MensagemGuardada, type ResultadoDoNome } from "./banco.ts";
import { criarLoggerDaBiblioteca, type AvisoDaBiblioteca, type NivelDoAviso } from "./avisos-da-biblioteca.ts";
import { alteracaoDaMensagem, autorDaMensagem, converterMensagem, dataDaMensagem } from "./conversao.ts";
import { ehGrupo, ehIndividual, ehLid, ehSempreIgnorado, mascararNumero, normalizar, numeroDe } from "./jid.ts";
import type { MarcaDoRascunho } from "./jeito.ts";
import { log } from "./log.ts";
import { baixarCifrado, decifrarMidia, enderecoParaBaixar, ErroDeMidia, ESPERA_DO_REENVIO_MS, FIGURINHA_LADO, MAXIMO_DE_MIDIA_BYTES, tipoDaBaileys, type TipoDeEnvio } from "./midia.ts";
import { declararProntoParaHistoricoSobDemanda } from "./registro-do-aparelho.ts";
import { aparelhoDesktop } from "./config.ts";
import { registrar as registrarSegredo } from "./segredos.ts";
import type { Sessao } from "./sessao.ts";

/** QR válido por 60 s (Nod whatsapp.ts:46 e 343). */
export const VIDA_DO_QR_MS = 60_000;
/** Pareamento não concluído em 5 min apaga a sessão (Nod whatsapp.ts:466-473). */
export const PRAZO_DO_PAREAMENTO_MS = 5 * 60_000;
/** IDs enviados guardados (Nod whatsapp.ts:76, 490-492). */
export const MAXIMO_DE_IDS_ENVIADOS = 2_000;
/** Teto da fila de mensagens ao vivo (Nod whatsapp.ts:359). */
const TETO_DA_FILA = 1_000;
/** "Digitando…" antes de enviar: de 1 a 3 s, sorteado a cada envio. */
export const DIGITANDO_MINIMO_MS = 1_000;
export const DIGITANDO_MAXIMO_MS = 3_000;
export const esperaDigitandoPadrao = (): number => DIGITANDO_MINIMO_MS + Math.floor(Math.random() * (DIGITANDO_MAXIMO_MS - DIGITANDO_MINIMO_MS + 1));
/** Espera da reconexão: 1, 2, 4... até 60 s (Nod whatsapp.ts:416-421). */
export const esperaDaReconexao = (tentativa: number): number => Math.min(60_000, 1000 * 2 ** Math.min(tentativa, 6));
/**
 * Pedidos de reenvio por mensagem que não decifrou (desvio do Nod, que usa 0, whatsapp.ts:337). Com 0 a Baileys nunca
 * manda o recibo `retry` (lib/Socket/messages-recv.js:408-412) e o remetente nunca reenvia: a mensagem de um grupo
 * escolhido DEPOIS do pareamento (cuja chave de grupo, a SKDM, foi recusada pelo shouldIgnoreJid) ou de um contato
 * liberado nunca seria decifrada. Com 2, a falha de decifrar gera o recibo `retry` e o celular do remetente manda a
 * mensagem de novo com a chave. O mesmo número limita quantas vezes NÓS reenviamos uma resposta a quem pediu
 * (`willSendMessageAgain`, messages-recv.js:1030-1034). A contagem fica no NodeCache interno da Baileys (1 h,
 * messages-recv.js:27-31): não precisa de `msgRetryCounterCache`.
 */
export const PEDIDOS_DE_REENVIO = 2;
/** badSession (500) é o padrão da Baileys para stream:error desconhecido (lib/Utils/generics.js:292): reconecta até 3 vezes em 10 min. */
export const QUEDAS_500_TOLERADAS = 3;
export const JANELA_DAS_QUEDAS_500_MS = 10 * 60_000;
/** Respostas nossas guardadas na memória para atender pedido de reenvio de quem recebeu (via getMessage). */
const MAXIMO_DE_RESPOSTAS_EM_MEMORIA = 200;
const VALIDADE_DAS_RESPOSTAS_EM_MEMORIA_MS = 30 * 60_000;

/**
 * O que o transporte usa do socket da Baileys (Nod whatsapp.ts:48-51, mais o que a leitura de grupos precisa).
 * 0.7.2: `ws` (só para ver o ack e o recibo do pedido de histórico) e `sendPeerDataOperationMessage` (a variação
 * `pn_com_conta`) são opcionais: socket sem eles continua servindo, sem esse diagnóstico e sem essa variação.
 */
export type SocketWa = Pick<
  WASocket,
  "ev" | "sendMessage" | "sendPresenceUpdate" | "logout" | "end" | "user" | "signalRepository" | "groupFetchAllParticipating" | "onWhatsApp" | "fetchMessageHistory" | "updateMediaMessage"
> &
  Partial<Pick<WASocket, "ws" | "sendPeerDataOperationMessage" | "resyncAppState" | "authState">> & { readMessages?: unknown };

export type CriarSocket = (config: UserFacingSocketConfig) => SocketWa;

/** Marca posta pelo test/setup.ts: com ela, abrir o WebSocket de verdade é erro. */
export const MARCA_SEM_REDE = Symbol.for("whatsapp-claude.sem-rede");

/** O socket de verdade. Recusa rodar nos testes, mesmo que alguém esqueça de injetar o falso. */
export const criarSocketReal: CriarSocket = (config) => {
  if ((globalThis as Record<symbol, unknown>)[MARCA_SEM_REDE]) {
    throw new Error("Teste tentou abrir o WebSocket do WhatsApp: injete um socket falso.");
  }
  // 0.7.5: antes de a Baileys montar o registro do aparelho (pareamento), o embrulho do DeviceProps
  // (registro-do-aparelho.ts). O stdio.ts já chamou na partida; aqui é a garantia para qualquer outra entrada.
  declararProntoParaHistoricoSobDemanda();
  return makeWASocket(config);
};

export type Situacao =
  | "desligado" // ainda não iniciou
  | "nao_pareado" // não há sessão: não conecta
  | "conectando"
  | "aguardando_qr"
  | "conectado"
  | "reconectando"
  | "parado" // código grave: não reconecta
  | "sessao_encerrada" // loggedOut: sessão apagada
  | "expirado" // pareamento passou de 5 min: sessão apagada
  | "fechado"; // o processo está saindo

export interface EstadoDaConexao {
  situacao: Situacao;
  /** Há um pareamento (QR) em andamento. */
  pareando?: boolean;
  /** No pareamento: o celular já leu o QR e a conexão está terminando. */
  qr_lido?: boolean;
  /** Dígitos do número do dono (mascarar antes de mostrar). */
  numero?: string;
  nome?: string;
  qr?: string;
  expira_em?: string;
  /** Por que parou (frase em português). */
  motivo?: string;
  /** Código de desconexão da última queda. */
  codigo?: number;
  proxima_tentativa_em?: string;
}

export interface Temporizador {
  setTimeout(f: () => void, ms: number): { unref?(): unknown };
  clearTimeout(t: unknown): void;
  agora(): number;
}

const TEMPORIZADOR_REAL: Temporizador = {
  setTimeout: (f, ms) => setTimeout(f, ms),
  clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  agora: () => Date.now(),
};

export interface OpcoesTransporte {
  banco: Banco;
  sessao: Sessao;
  criarSocket?: CriarSocket;
  temporizador?: Temporizador;
  /** Quanto tempo fica "digitando…" antes de enviar (padrão: sorteio de 1 a 3 s). Os testes encurtam. */
  esperaDigitandoMs?: () => number;
  /** 0.7.0, parte 2: o `fetch` do download de mídia (padrão: o do Node). Os testes injetam um servidor falso. */
  buscarMidia?: typeof fetch;
  /** 0.7.4: a caixa-preta do processo (conexão, histórico recebido e avisos da biblioteca, sem conteúdo). */
  caixaPreta?: { registrar(evento: string, campos?: Record<string, unknown>): void };
  /** 0.15.1: a conexão abriu; `aposPareamento` = a primeira abertura depois de parear (a agenda automática decide o resto). */
  aoAbrirConexao?: (aposPareamento: boolean) => void;
  /** 0.15.1: o histórico inicial terminou de chegar (`messaging-history.status` do RECENT, completo ou parado). */
  aoTerminarHistoricoInicial?: () => void;
}

/** Um arquivo para enviar (wa_enviar_arquivo), já lido e conferido por quem chama. */
export interface ArquivoParaEnviar {
  tipo: TipoDeEnvio;
  mimetype: string;
  conteudo: Buffer;
  nome: string;
  legenda?: string;
  /** Foto: a miniatura já gerada (miniatura.ts, depois do clique). Sem ela, a foto sai sem miniatura. */
  miniatura?: { jpegThumbnail: string; width: number; height: number };
  /** 0.12.0: a legenda veio de um rascunho da IA: a mensagem guardada leva a marca (ver MensagemGuardada.rascunho_da_ia). */
  rascunho?: MarcaDoRascunho;
  /** 0.18.0: figurinha animada (o contêiner WebP já foi conferido por quem chama: 512x512, VP8X com ANIM/ANMF). */
  animada?: boolean;
}

/** 0.12.0: o texto veio de um rascunho da IA (cartão): a mensagem guardada leva a marca. */
export interface OpcoesDaResposta {
  rascunho?: MarcaDoRascunho;
}

/** A mensagem citada numa resposta: id e texto guardados no banco. Em grupo, de outra pessoa: quem escreveu (jid). */
export interface Citacao {
  id: string;
  de_mim: boolean;
  texto?: string;
  participante?: string;
}

/** A chave de uma mensagem guardada (reagir, histórico). Em grupo, de outra pessoa, leva quem escreveu (jid). */
export interface ChaveDeMensagem {
  id: string;
  de_mim: boolean;
  participante?: string;
}

/**
 * 0.7.2: jeitos de montar o pedido de histórico (ver FICHA.md, "0.7.2: diagnóstico do histórico"). No WhatsApp real o
 * `padrao` não teve resposta nenhuma (6 de 6) e o `lid` foi atendido (2 de 2, 0.7.3): por isso o `auto` começa pelo
 * `lid` quando a conversa individual tem LID conhecido, e pelo `padrao` nos outros casos.
 * - `padrao`: chatJid com o número, horário em ms (`fetchMessageHistory`);
 * - `lid`: o LID da conversa no `remoteJid` da chave;
 * - `pn_com_conta`: chatJid com o número e `accountLid` com o LID (só pelo `sendPeerDataOperationMessage`);
 * - `segundos`: como o padrão, com o horário em segundos (o que o exemplo oficial da Baileys manda).
 */
export const VARIACOES_DO_HISTORICO = ["padrao", "lid", "pn_com_conta", "segundos"] as const;
export type VariacaoDoHistorico = (typeof VARIACOES_DO_HISTORICO)[number];
/** A seguinte na ordem do modo `auto` (volta ao começo depois da última). */
export const proximaVariacao = (v: VariacaoDoHistorico): VariacaoDoHistorico => VARIACOES_DO_HISTORICO[(VARIACOES_DO_HISTORICO.indexOf(v) + 1) % VARIACOES_DO_HISTORICO.length]!;
/** Depois do tempo da ferramenta, o pedido fica em observação: resposta atrasada ainda é guardada e anotada. */
export const OBSERVACAO_DO_HISTORICO_MS = 120_000;
const MAXIMO_DE_EVENTOS_NO_DIAGNOSTICO = 20;
const MAXIMO_DE_RESPOSTAS_PDO_NO_DIAGNOSTICO = 10;
/** 0.7.4: nós do WebSocket por pedido (e outros tantos depois do tempo) e avisos distintos da biblioteca. */
const MAXIMO_DE_NOS_NO_DIAGNOSTICO = 60;
const MAXIMO_DE_AVISOS_NO_DIAGNOSTICO = 20;
/** 0.7.4: o mesmo aviso da biblioteca vai para a caixa-preta no máximo uma vez a cada 60 s (os outros somam em `vezes`). */
const ENTRE_AVISOS_IGUAIS_MS = 60_000;
/** 0.7.4: `messaging-history.set` em rajada: um registro por tipo a cada 5 s, somado. */
export const JANELA_DO_HISTORICO_RECEBIDO_MS = 5_000;
/** 0.7.4: lote grande (histórico, fila ao vivo) devolve o controle ao laço de eventos a cada tantas mensagens. */
export const CEDER_A_CADA = 25;
/**
 * 0.15.2: contatos por gravação do índice (`Banco.aplicarContatos`); entre um lote e outro, o laço respira. A agenda do
 * celular chega com milhares de contatos num evento só (e um `lid-mapping.update` por contato, seguidos).
 */
export const LOTE_DE_CONTATOS = 250;
/** 0.15.2: pares LID -> número que movem conversa (uns 10 ms cada) por lote, antes de ceder ao laço. */
export const PARES_QUE_MOVEM_POR_LOTE = 5;
/**
 * 0.7.4: devolve o controle ao laço de eventos. O `await` de uma função que resolve na hora só passa por microtarefas: sem
 * isto, o histórico inicial de uma conta grande travou o laço por 31 s no WhatsApp real (temporizadores, o keepalive do
 * WebSocket e a entrada padrão parados).
 */
export const cederAoLaco = (): Promise<void> => new Promise((pronto) => setImmediate(pronto));
/** Ack e recibo que chegam antes de sabermos o id do pedido (corrida improvável, mas possível). */
const MAXIMO_DE_VISTOS_SEM_ID = 50;

/** Um `messaging-history.set` visto enquanto havia pedido: só tipos e contagens, nunca jid, id ou texto. */
export interface EventoDeHistoricoNoDiagnostico {
  tipo: number | null;
  tem_id_de_pedido: boolean;
  id_bate: boolean;
  chats: number;
  mensagens: number;
  da_conversa_pedida: number;
  segundos_apos_o_pedido: number;
}

/** A notificação de histórico (`historySyncNotification`) vista no `messages.upsert`, ANTES do download dela. */
export interface NotificacaoDeHistoricoNoDiagnostico {
  tipo: number | null;
  tem_id_de_pedido: boolean;
  id_bate: boolean;
  segundos_apos_o_pedido: number;
}

/** Uma resposta PDO (PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE): se responde a este pedido e os nomes dos campos. */
export interface RespostaPdoNoDiagnostico {
  id_bate: boolean;
  campos: string[];
}

/**
 * 0.7.4: um nó que chegou pelo WebSocket enquanto havia pedido: só nomes de tag e tipo do protocolo e booleanos. Nunca
 * `id`, `from`, `to`, `participant`, `recipient`, `notify` nem outro atributo.
 */
export interface NoRecebidoNoDiagnostico {
  tag: string;
  tipo: string | null;
  categoria: string | null;
  /** `from` ou `participant` é o próprio dono (pelo número ou pelo LID; só a parte do usuário, sem o aparelho). */
  do_proprio_numero: boolean;
  offline: boolean;
  /** O `type` dos filhos `enc` (ex.: ["pkmsg"]). */
  cifras: string[];
  segundos_apos_o_pedido: number;
}

/** O que se viu de um pedido num intervalo (até o tempo, ou depois dele). */
export interface ObservadoNoHistorico {
  ack_do_servidor: boolean;
  /** Código de erro do ack, se o servidor recusou o pedido. */
  erro_no_ack: string | null;
  /** O `type` dos recibos do pedido (ex.: "peer_msg"; "sem_tipo" = entregue), na ordem, sem repetir. */
  recibo_do_celular: string | null;
  eventos_de_historico: EventoDeHistoricoNoDiagnostico[];
  notificacoes_de_historico: NotificacaoDeHistoricoNoDiagnostico[];
  respostas_pdo: RespostaPdoNoDiagnostico[];
  /** 0.7.4: todo nó do WebSocket (até 60). */
  nos_recebidos: NoRecebidoNoDiagnostico[];
  /** 0.7.4: os avisos da biblioteca (texto fixo saneado), com quantas vezes vieram. */
  avisos_da_biblioteca: AvisoDaBiblioteca[];
  /** 0.7.4: a conexão com o WhatsApp caiu enquanto isto era observado. */
  conexao_caiu_durante_o_pedido: boolean;
}

export interface DiagnosticoDoHistorico extends ObservadoNoHistorico {
  variacao: VariacaoDoHistorico;
  /** O pedido saiu (o `fetchMessageHistory`/`sendPeerDataOperationMessage` resolveu). */
  pedido_enviado: boolean;
  espera_ms: number;
}

/** A resposta de um pedido anterior que chegou depois do tempo, dentro da observação. */
export interface RespostaAtrasada {
  variacao: VariacaoDoHistorico;
  segundos_apos_o_pedido: number;
  recebidas: number;
  novas: number;
  cortadas: number;
}

/** O que voltou de um pedido de histórico ao celular. */
export interface ResultadoDoHistorico {
  /** Chegou resposta reconhecida dentro do tempo (pelo id do pedido, ou mensagem/chat da conversa pedida). */
  chegou: boolean;
  /** Mensagens desta conversa que vieram na resposta e passaram pelos filtros. */
  recebidas: number;
  /** Quantas delas ficaram guardadas (eram novas e couberam no teto). */
  novas: number;
  /** Quantas eram novas mas o teto de mensagens por conversa cortou (mais antigas que as guardadas). */
  cortadas: number;
  diagnostico: DiagnosticoDoHistorico;
  /** A resposta do pedido anterior desta conversa, se chegou depois do tempo (e só uma vez). */
  resposta_atrasada_do_pedido_anterior?: RespostaAtrasada;
  /** O que se viu do pedido anterior desta conversa depois do tempo (recibo, eventos), se algo chegou. */
  pedido_anterior_depois_do_tempo?: ObservadoNoHistorico;
}

export interface Transporte {
  estado(): EstadoDaConexao;
  /** Liga. Sem sessão pareada e sem `parear`, não conecta (fica `nao_pareado`). */
  iniciar(opcoes?: { parear?: boolean }): Promise<void>;
  /** LID de um número, se a Baileys souber (para a lista "nunca ler" pegar as duas formas). */
  lidDoNumero(jid: string): Promise<string | undefined>;
  /** Guarda o ID de uma mensagem que vamos enviar, ANTES de enviar (Nod whatsapp.ts:489-492). */
  registrarEnviado(id: string): Promise<void>;
  /** Busca os metadados dos grupos no WhatsApp e guarda no cache (1 h). Só conectado. */
  buscarGrupos(): Promise<CacheDeGrupos>;
  /**
   * Envia a resposta (só depois do clique, quem chama garante). "Digitando" por 1 a 3 s e "pausado", nunca
   * "disponível"; id próprio em `sentIds` antes de enviar; confere o id devolvido; grava como mensagem minha.
   * Conversa individual ou grupo (desde a 0.7.0; quem chama confere que o grupo está escolhido).
   */
  responder(jid: string, texto: string, citar?: Citacao, opcoes?: OpcoesDaResposta): Promise<{ id: string; ts: number }>;
  /** O jid com que o número existe no WhatsApp (pode vir corrigido), ou undefined se não tem WhatsApp. Só conectado. */
  noWhatsApp(jid: string): Promise<string | undefined>;
  /** Reage a uma mensagem (emoji vazio tira a reação). Ação reversível, sem cartão. */
  reagir(jid: string, chave: ChaveDeMensagem, emoji: string): Promise<void>;
  /** Edita uma mensagem de texto minha (só depois do clique) e atualiza o banco. */
  editar(jid: string, id: string, texto: string): Promise<void>;
  /** Apaga para todos uma mensagem minha (só depois do clique) e tira do banco. */
  apagar(jid: string, id: string): Promise<void>;
  /**
   * Pede ao celular até `quantidade` mensagens anteriores a `ancora` (a mais antiga guardada) e espera a resposta
   * (`messaging-history.set` ON_DEMAND) até `esperaMs`. Só o que corresponde a este pedido é guardado.
   */
  buscarHistorico(jid: string, quantidade: number, ancora: ChaveDeMensagem & { ts: number }, esperaMs: number, variacao?: VariacaoDoHistorico): Promise<ResultadoDoHistorico>;
  /**
   * 0.7.2: a variação que o próximo pedido desta conversa usa. `auto`: a que funcionou da última vez, ou a seguinte da
   * ordem depois de um pedido sem resposta, pulando as que não se aplicam; no primeiro pedido, `lid` se a conversa
   * individual tem LID conhecido, senão `padrao` (0.7.3). Pedida e que não se aplica: erro com o porquê.
   */
  variacaoDoHistorico(jid: string, pedida: VariacaoDoHistorico | "auto"): Promise<VariacaoDoHistorico>;
  /**
   * Baixa e decifra a mídia de uma mensagem guardada (0.7.0, parte 2), com as travas de midia.ts. Mídia vencida no
   * servidor (404/410): pede UMA vez ao celular para reenviar (`updateMediaMessage`) e tenta de novo.
   */
  baixarMidia(jid: string, mensagem: MensagemGuardada): Promise<Buffer>;
  /** Envia um arquivo (só depois do clique, quem chama garante): "digitando" (ou "gravando", na voz) e "pausado", id próprio antes, grava como mensagem minha. */
  enviarArquivo(jid: string, arquivo: ArquivoParaEnviar): Promise<{ id: string; ts: number }>;
  /** 0.7.4: os avisos da biblioteca guardados na memória (anel de 40, texto saneado). */
  avisosDaBiblioteca(): AvisoDaBiblioteca[];
  /**
   * 0.15.0: pede de novo ao celular a agenda do WhatsApp (as coleções de contatos do app state, desde o começo) e espera
   * os contatos chegarem até `esperaMs`. Não manda nada a ninguém. Devolve só contagens. `aoComecar` roda depois das
   * conferências (conexão, socket que permite) e antes do pedido: quem chama reserva ali o freio (se lançar, nada sai).
   */
  atualizarContatos(esperaMs: number, aoComecar?: () => void): Promise<ResultadoDosContatos>;
  /** Logout de verdade (se conectado) e apaga a sessão e o banco. Devolve se o WhatsApp confirmou o logout. */
  desconectar(): Promise<{ logout_no_whatsapp: boolean }>;
  /** Espera o processamento do que já chegou e as gravações da sessão. */
  esperar(): Promise<void>;
  fechar(): Promise<void>;
}

/** O caminho que funciona quando a sessão salva não vale mais: o wa_parear recusa enquanto houver sessão salva. */
/**
 * 0.15.0: as coleções do app state onde o celular guarda a agenda: `contactAction` vai em `critical_unblock_low`
 * (Baileys rc14, lib/Utils/chat-utils.js:500-507, o patch de `chatModify({ contact })`). As outras coleções ficam de
 * fora de propósito: refazer `regular_high` (arquivar, silenciar, lida) do zero mexeria nas não lidas das conversas.
 */
export const COLECOES_DE_CONTATOS = ["critical_unblock_low"] as const;

/** 0.15.0: o resultado do pedido da agenda (wa_atualizar_contatos e, desde a 0.15.1, o automático), só contagens. */
export interface ResultadoDosContatos {
  /** O pedido saiu deste computador. */
  pedido_enviado: boolean;
  /** A Baileys terminou a ressincronização dentro do tempo (com ou sem erro). */
  terminou: boolean;
  tempo_esgotado: boolean;
  /** Só o nome do tipo do erro da Baileys (a mensagem pode trazer jid). */
  erro?: string;
  contatos_recebidos: number;
  nomes_novos: number;
  nomes_atualizados: number;
  colecoes: string[];
  espera_ms: number;
}

export const PAREAR_DE_NOVO = "Para usar de novo, use wa_desconectar e depois wa_parear.";

const MOTIVOS: Record<number, string> = {
  [DisconnectReason.connectionReplaced]: "Outra conexão abriu com a mesma sessão (connectionReplaced). Feche o outro Claude e reabra este.",
  [DisconnectReason.badSession]: `O WhatsApp encerrou a conexão com erro de sessão (badSession) ${QUEDAS_500_TOLERADAS + 1} vezes em 10 minutos; parei para não insistir. Feche e abra o Claude Desktop; se continuar, a sessão guardada não vale mais. ${PAREAR_DE_NOVO}`,
  [DisconnectReason.forbidden]: "O WhatsApp recusou a conexão (forbidden). Confira o número no celular antes de tentar de novo.",
  [DisconnectReason.multideviceMismatch]: `O WhatsApp não aceitou este aparelho vinculado (multideviceMismatch). ${PAREAR_DE_NOVO}`,
};

/** Um pedido de histórico deste processo (só na memória). O jid e o id ficam aqui e NUNCA vão para o diagnóstico. */
interface PedidoDeHistorico {
  jid: string;
  variacao: VariacaoDoHistorico;
  inicio: number;
  /** O id da mensagem do pedido (devolvido pela Baileys): a resposta ON_DEMAND traz em `peerDataRequestSessionId`. */
  id?: string;
  fase: "pendente" | "observacao";
  chegou: boolean;
  recebidas: number;
  novas: number;
  cortadas: number;
  diag: DiagnosticoDoHistorico;
  /** O que chegou depois do tempo (na observação). */
  depois: ObservadoNoHistorico;
  vistosSemId: Array<{ tipo: "ack" | "recibo"; id: string; detalhe: string | null }>;
  atrasada?: RespostaAtrasada;
  acordar: () => void;
  fimDaObservacao?: unknown;
}

const observadoVazio = (): ObservadoNoHistorico => ({
  ack_do_servidor: false,
  erro_no_ack: null,
  recibo_do_celular: null,
  eventos_de_historico: [],
  notificacoes_de_historico: [],
  respostas_pdo: [],
  nos_recebidos: [],
  avisos_da_biblioteca: [],
  conexao_caiu_durante_o_pedido: false,
});
const algoObservado = (o: ObservadoNoHistorico): boolean =>
  o.ack_do_servidor ||
  o.recibo_do_celular !== null ||
  o.eventos_de_historico.length > 0 ||
  o.notificacoes_de_historico.length > 0 ||
  o.respostas_pdo.length > 0 ||
  o.nos_recebidos.length > 0 ||
  o.avisos_da_biblioteca.length > 0 ||
  o.conexao_caiu_durante_o_pedido;
/**
 * Valor curto do protocolo (tipo de recibo, código de erro, tag) que pode ir para o diagnóstico; o resto vira "outro".
 * 0.7.4: também vira "outro" o que tem 6 ou mais dígitos seguidos (nenhum nome do protocolo é assim; um número seria).
 */
const valorDoProtocolo = (v: unknown): string => (typeof v === "string" && /^[A-Za-z0-9_-]{1,30}$/.test(v) && !/\d{6,}/.test(v) ? v : "outro");
/**
 * 0.7.6: como o aparelho se registra no pareamento. Padrão: navegador, `Browsers.macOS("Chrome")`, que a Baileys
 * transforma em `DeviceProps.platformType = CHROME` (validate-connection.js, `getPlatformType`). Hipótese em teste
 * (13/11/2026): o iPhone que ignora o histórico sob demanda só atende aparelho do tipo navegador; com
 * `Browsers.macOS("Desktop")` (até a 0.7.5) o tipo era DESKTOP. Consequência conhecida: a documentação da Baileys diz
 * que o perfil de desktop traz mais histórico na sincronização inicial. `WA_APARELHO_DESKTOP=1` volta ao desktop.
 * Só vale para pareamento novo: a sessão já pareada continua com o tipo com que foi registrada.
 */
export function navegadorDoRegistro(desktop: boolean = aparelhoDesktop()): [string, string, string] {
  return desktop ? Browsers.macOS("Desktop") : Browsers.macOS("Chrome");
}

/** A parte do usuário de um jid (sem servidor, aparelho nem agente), para comparar com o dono. */
const usuarioDoJid = (j: unknown): string | undefined => (typeof j === "string" && j.includes("@") ? j.split("@")[0]!.split(":")[0]!.split("_")[0] || undefined : undefined);

/**
 * 0.7.4: o resumo de um nó do WebSocket. Lê SÓ `tag`, `type`, `category`, `offline`, a parte do usuário de `from` e
 * `participant` (comparada com o dono e jogada fora) e o `type` dos filhos `enc`.
 */
export function resumoDoNo(no: unknown, proprios: ReadonlySet<string>, segundos: number): NoRecebidoNoDiagnostico | undefined {
  if (typeof no !== "object" || no === null || no instanceof Uint8Array) return undefined;
  const { tag, attrs, content } = no as { tag?: unknown; attrs?: Record<string, unknown>; content?: unknown };
  if (typeof tag !== "string") return undefined;
  const a = attrs ?? {};
  const cifras = Array.isArray(content)
    ? content
        .filter((f): f is { tag: string; attrs?: Record<string, unknown> } => typeof f === "object" && f !== null && (f as { tag?: unknown }).tag === "enc")
        .slice(0, 5)
        .map((f) => valorDoProtocolo(f.attrs?.type))
    : [];
  const de = usuarioDoJid(a.from);
  const participante = usuarioDoJid(a.participant);
  return {
    tag: valorDoProtocolo(tag),
    tipo: a.type === undefined || a.type === null ? null : valorDoProtocolo(a.type),
    categoria: a.category === undefined || a.category === null ? null : valorDoProtocolo(a.category),
    do_proprio_numero: (de !== undefined && proprios.has(de)) || (participante !== undefined && proprios.has(participante)),
    offline: a.offline !== undefined && a.offline !== null,
    cifras,
    segundos_apos_o_pedido: segundos,
  };
}

/** 0.7.4: o resumo de um ou mais `messaging-history.set` do mesmo tipo para a caixa-preta (só contagens). */
interface SomaDoHistorico {
  tipo: number | null;
  progresso: number | null;
  chats: number;
  mensagens: number;
  gravadas: number;
  duracao_ms: number;
  eventos: number;
}

function somarHistorico(a: SomaDoHistorico, b: SomaDoHistorico): void {
  a.progresso = b.progresso ?? a.progresso;
  a.chats += b.chats;
  a.mensagens += b.mensagens;
  a.gravadas += b.gravadas;
  a.duracao_ms += b.duracao_ms;
  a.eventos += b.eventos;
}

export function criarTransporte(opcoes: OpcoesTransporte): Transporte {
  const { banco, sessao } = opcoes;
  const criarSocket = opcoes.criarSocket ?? criarSocketReal;
  const relogio = opcoes.temporizador ?? TEMPORIZADOR_REAL;
  const esperaDigitando = opcoes.esperaDigitandoMs ?? esperaDigitandoPadrao;
  const buscarMidia = opcoes.buscarMidia ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  let socket: SocketWa | undefined;
  let auth: AuthenticationState | undefined;
  let iniciando: Promise<void> | undefined;
  let fechado = false;
  let parado = false;
  let pareando = false;
  let qrLido = false;
  let gravacoes: Promise<void> = Promise.resolve();
  let recebidas: Promise<void> = Promise.resolve();
  let naFila = 0;
  let reconexao: unknown;
  let expiracao: unknown;
  let tentativa = 0;
  let estado: EstadoDaConexao = { situacao: "desligado" };
  const enviados = new Set<string>();
  /** Horas das quedas 500 (badSession) recentes. */
  let quedas500: number[] = [];
  /** Momento da ligação (pair-success), em ms: mensagem entregue offline (`append`) depois dele conta como não lida. */
  let ligadoEm: number | undefined;
  let descartadas = 0;
  /** As respostas que NÓS enviamos, só na memória, para o getMessage atender o pedido de reenvio de quem recebeu. */
  const respostasRecentes = new Map<string, { message: proto.IMessage; em: number }>();
  /**
   * Pedidos de histórico sob demanda feitos por ESTE processo, por conversa (chave do banco): os que esperam a resposta
   * e, 0.7.2, os que passaram do tempo e ficam em observação por OBSERVACAO_DO_HISTORICO_MS. Resposta ON_DEMAND de
   * conversa que não está aqui é ignorada: ninguém aqui pediu.
   */
  const pedidosDeHistorico = new Map<string, PedidoDeHistorico>();
  /** 0.7.2: anotações de pedidos anteriores, entregues (e apagadas) na próxima chamada da mesma conversa. */
  const respostasAtrasadas = new Map<string, RespostaAtrasada>();
  const observadoDepoisDoTempo = new Map<string, ObservadoNoHistorico>();
  /** 0.7.2: a variação do modo `auto` para o próximo pedido de cada conversa (só na memória do processo). */
  const variacaoAuto = new Map<string, VariacaoDoHistorico>();
  /** Tira os ouvintes de ack/recibo do `ws` do socket atual (socket trocado ou fechado). */
  let soltarOuvintesDoWs: (() => void) | undefined;
  const caixaPreta = opcoes.caixaPreta;
  /** 0.15.1: houve pair-success nesta vida do transporte e a conexão ainda não abriu depois dele. */
  let abrirAposPareamento = false;
  /** 0.7.4: quando a conexão atual abriu e quando a última caiu (para a caixa-preta dizer quanto durou cada uma). */
  let abriuEm: number | undefined;
  let caiuEm: number | undefined;
  /** 0.7.4: o último registro de cada aviso na caixa-preta e quantas vezes ele veio desde então. */
  const avisosNaCaixaPreta = new Map<string, { em: number; vezes: number }>();
  /** 0.7.4: `historico_recebido` por tipo: o último registro e o que se somou desde então (rajada). */
  const historicoNaCaixaPreta = new Map<string, { em: number; soma?: SomaDoHistorico; temporizador?: unknown }>();
  /**
   * 0.11.0: os pares LID -> número dos participantes de cada grupo, da última busca dos grupos (só na memória do
   * processo; os dos grupos escolhidos também vão para o mapa do banco). Cache: nada de buscar metadados por mensagem.
   */
  const participantesDosGrupos = new Map<string, Map<string, string>>();
  /** 0.15.0: o pedido da agenda em andamento (manual ou automático): o que chegou desde o pedido, só contagens. */
  let contandoContatos: { recebidos: number; novos: number; atualizados: number } | undefined;

  /** 0.7.4: a biblioteca avisa aqui (nada vai para o stdout nem para o stderr): o anel, o pedido de histórico e a caixa-preta. */
  const { logger: loggerDaBiblioteca, anel: anelDeAvisos } = criarLoggerDaBiblioteca((aviso) => {
    for (const p of pedidosDeHistorico.values()) anotarAviso(alvoDe(p), aviso);
    avisarNaCaixaPreta(aviso);
  });

  function anotarAviso(alvo: ObservadoNoHistorico, aviso: { nivel: NivelDoAviso; texto: string }): void {
    const igual = alvo.avisos_da_biblioteca.find((a) => a.nivel === aviso.nivel && a.texto === aviso.texto);
    if (igual) igual.vezes++;
    else if (alvo.avisos_da_biblioteca.length < MAXIMO_DE_AVISOS_NO_DIAGNOSTICO) alvo.avisos_da_biblioteca.push({ ...aviso, vezes: 1 });
  }

  /** No máximo um registro por texto a cada 60 s; o registro diz quantas vezes ele veio desde o anterior. */
  function avisarNaCaixaPreta(aviso: { nivel: NivelDoAviso; texto: string }): void {
    if (!caixaPreta) return;
    const chave = `${aviso.nivel}|${aviso.texto}`;
    const agora = relogio.agora();
    const visto = avisosNaCaixaPreta.get(chave);
    if (visto && agora - visto.em < ENTRE_AVISOS_IGUAIS_MS) {
      visto.vezes++;
      return;
    }
    if (avisosNaCaixaPreta.size > 200) avisosNaCaixaPreta.clear();
    avisosNaCaixaPreta.set(chave, { em: agora, vezes: 0 });
    caixaPreta.registrar("aviso_da_biblioteca", { nivel: aviso.nivel, texto: aviso.texto, vezes: (visto?.vezes ?? 0) + 1 });
  }

  /** Um `messaging-history.set` processado. O primeiro de cada tipo vai na hora; os que vêm em até 5 s somam e saem juntos. */
  function historicoNaCaixa(soma: SomaDoHistorico): void {
    if (!caixaPreta) return;
    const chave = String(soma.tipo);
    const agora = relogio.agora();
    const h = historicoNaCaixaPreta.get(chave);
    if (!h || agora - h.em >= JANELA_DO_HISTORICO_RECEBIDO_MS) {
      if (h?.soma) despejarHistorico(chave);
      historicoNaCaixaPreta.set(chave, { em: agora });
      registrarHistorico(soma);
      return;
    }
    if (h.soma) somarHistorico(h.soma, soma);
    else {
      h.soma = { ...soma };
      const t = relogio.setTimeout(() => despejarHistorico(chave), Math.max(0, JANELA_DO_HISTORICO_RECEBIDO_MS - (agora - h.em)));
      t.unref?.();
      h.temporizador = t;
    }
  }

  function despejarHistorico(chave: string): void {
    const h = historicoNaCaixaPreta.get(chave);
    if (!h?.soma) return;
    relogio.clearTimeout(h.temporizador);
    const soma = h.soma;
    h.soma = undefined;
    h.temporizador = undefined;
    h.em = relogio.agora();
    registrarHistorico(soma);
  }

  function registrarHistorico(s: SomaDoHistorico): void {
    caixaPreta?.registrar("historico_recebido", {
      tipo: s.tipo,
      ...(s.progresso !== null ? { progresso: s.progresso } : {}),
      chats: s.chats,
      mensagens: s.mensagens,
      gravadas: s.gravadas,
      duracao_ms: s.duracao_ms,
      ...(s.eventos > 1 ? { eventos: s.eventos } : {}),
    });
  }

  function avisar(onde: string, erro: unknown): void {
    log(`[whatsapp-claude] ${onde}: ${erro instanceof Error ? erro.message : String(erro)}`);
  }

  /** Para de vez: sem reconectar (Nod whatsapp.ts:91-98). */
  function parar(situacao: Situacao, motivo?: string, codigo?: number): void {
    parado = true;
    pareando = false;
    estado = { situacao, ...(estado.numero ? { numero: estado.numero } : {}), ...(estado.nome ? { nome: estado.nome } : {}), ...(motivo ? { motivo } : {}), ...(codigo ? { codigo } : {}) };
    relogio.clearTimeout(reconexao);
    relogio.clearTimeout(expiracao);
    soltarOuvintesDoWs?.();
    soltarOuvintesDoWs = undefined;
    encerrarObservacoes();
    socket?.end(undefined);
  }

  /** Grava na sessão, uma de cada vez; falha de gravação para a conexão (Nod whatsapp.ts:99-108). */
  function salvar(valores: Record<string, string | null>): Promise<void> {
    const pendente = gravacoes.then(async () => {
      if (fechado) throw new Error("A sessão do WhatsApp está fechada.");
      await sessao.set(valores);
    });
    gravacoes = pendente.catch((erro) => {
      if (!fechado) {
        avisar("não consegui gravar a sessão", erro);
        parar("parado", "Não consegui gravar a sessão cifrada no disco.");
      }
    });
    return pendente;
  }

  /** Apaga a sessão inteira depois das gravações pendentes (Nod whatsapp.ts:109-122). */
  async function apagarSessao(): Promise<void> {
    await gravacoes;
    await sessao.limpar();
  }

  /** Apaga a sessão E o banco (conversas, índice e listas): `loggedOut` e wa_desconectar (decisão da Fase 2). */
  async function apagarTudo(): Promise<void> {
    await recebidas;
    await apagarSessao();
    banco.apagarTudo();
  }

  const dormir = (ms: number) =>
    new Promise<void>((pronto) => {
      relogio.setTimeout(pronto, ms);
    });

  async function buscarGrupos(): Promise<CacheDeGrupos> {
    if (!socket || estado.situacao !== "conectado") throw new Error("O WhatsApp não está conectado agora.");
    const todos = await socket.groupFetchAllParticipating();
    const saida: Record<string, { nome: string; participantes: number }> = {};
    participantesDosGrupos.clear();
    for (const [jid, g] of Object.entries(todos)) {
      if (!ehGrupo(jid)) continue;
      saida[jid] = { nome: (g.subject ?? "").slice(0, 100), participantes: g.size ?? g.participants?.length ?? 0 };
      const pares = paresDosParticipantes(g.participants);
      if (pares.size > 0) participantesDosGrupos.set(jid, pares);
    }
    const cache = banco.guardarGrupos(saida, relogio.agora());
    // 0.11.0: o mapa LID -> número aprende com os participantes dos grupos ESCOLHIDOS (os outros ficam só na memória, para
    // o caso de o grupo ser escolhido depois): quem escreve em grupo só com o LID passa a aparecer com o número mascarado.
    // Pelo `mapearLids`, que respeita a lista "nunca ler" como o `mapearLid`.
    seguro("participantes dos grupos", () => {
      const pares: Array<{ lid: string; pn: string }> = [];
      for (const [jid, mapa] of participantesDosGrupos) if (banco.grupoPermitido(jid)) for (const [lid, pn] of mapa) pares.push({ lid, pn });
      banco.mapearLids(pares);
    });
    return cache;
  }

  /** Os pares LID -> número dos participantes de um grupo (Baileys 7: `id` em LID com `phoneNumber`, ou `id` em número com `lid`). */
  function paresDosParticipantes(participantes: ReadonlyArray<{ id?: string; lid?: string; phoneNumber?: string; jid?: string }> | undefined): Map<string, string> {
    const pares = new Map<string, string>();
    for (const p of participantes ?? []) {
      const id = typeof p.id === "string" ? normalizar(p.id) : undefined;
      const lid = id && ehLid(id) ? id : typeof p.lid === "string" && ehLid(normalizar(p.lid)) ? normalizar(p.lid) : undefined;
      const alternativas = [p.phoneNumber, p.jid, id].filter((x): x is string => typeof x === "string");
      const pn = alternativas.map((x) => normalizar(x)).find((x) => numeroDe(x) !== undefined);
      if (lid && pn) pares.set(lid, pn);
    }
    return pares;
  }

  /**
   * 0.11.0: o número de quem escreveu num grupo só com o LID: o `participantAlt` da chave (Baileys 7), o mapa do banco
   * ou os participantes da última busca dos grupos (memória). Sem buscar metadados a cada mensagem.
   */
  function numeroDoParticipante(msg: WAMessage, grupo: string): string | undefined {
    const p = msg.key.participant ? normalizar(msg.key.participant) : undefined;
    if (!p || !ehLid(p) || msg.key.fromMe) return undefined;
    const alt = msg.key.participantAlt && numeroDe(msg.key.participantAlt) ? normalizar(msg.key.participantAlt) : undefined;
    return alt ?? banco.numeroDoLid(p) ?? participantesDosGrupos.get(grupo)?.get(p);
  }

  /** Mensagem de grupo com participante em LID: o mapa aprende o par e o remetente ganha o número. */
  function completarRemetente(msg: WAMessage, grupo: string, mensagem: MensagemGuardada): void {
    const p = mensagem.participante;
    if (!p || !ehLid(p)) return;
    const pn = numeroDoParticipante(msg, grupo);
    if (!pn) return;
    if (banco.numeroDoLid(p) !== pn) banco.mapearLid(p, pn);
    const numero = numeroDe(pn);
    if (numero && !mensagem.remetente?.numero) mensagem.remetente = { ...mensagem.remetente, numero };
  }

  /**
   * 0.11.0: a mensagem pode mudar o mapa LID -> número (e, com ele, mover ou bloquear conversa)? Conversa individual por
   * LID ainda sem número conhecido (ou com outro número, ou com conversa guardada sob o LID) e participante de grupo em
   * LID com número novo. Só essas forçam a gravação das pendentes do lote ao vivo.
   */
  function podeMudarOMapa(msg: WAMessage): boolean {
    const remoto = normalizar(msg.key.remoteJid ?? "");
    if (ehLid(remoto)) {
      const conhecido = banco.numeroDoLid(remoto);
      if (!conhecido) return true;
      const alt = msg.key.remoteJidAlt && numeroDe(msg.key.remoteJidAlt) ? normalizar(msg.key.remoteJidAlt) : undefined;
      return (alt !== undefined && alt !== conhecido) || banco.entrada(remoto) !== undefined;
    }
    if (ehGrupo(remoto) && banco.grupoPermitido(remoto)) {
      const p = msg.key.participant ? normalizar(msg.key.participant) : undefined;
      const pn = numeroDoParticipante(msg, remoto);
      return p !== undefined && pn !== undefined && banco.numeroDoLid(p) !== pn;
    }
    return false;
  }

  function donoDoSocket(): { numero?: string; nome?: string } {
    const numero = numeroDe(auth?.creds.me?.id ?? socket?.user?.id);
    const nome = (auth?.creds.me?.name ?? socket?.user?.name)?.slice(0, 200);
    return { ...(numero ? { numero } : {}), ...(nome ? { nome } : {}) };
  }

  /** O número de um LID segundo a Baileys (o mapa dela fica na sessão: lid-mapping). undefined se ela não sabe. */
  async function numeroPelaBaileys(lid: string): Promise<string | undefined> {
    try {
      const pn = await socket?.signalRepository.lidMapping.getPNForLID(lid);
      return pn && numeroDe(pn) ? normalizar(pn) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Em que conversa a mensagem entra (número quando o LID é conhecido), ou undefined se não entra.
   * Repete o filtro do `shouldIgnoreJid`: o histórico não passa por ele.
   * LID sem número conhecido: pergunta à Baileys antes de gravar e reconfere as listas. Se ela também não sabe e há
   * algum bloqueio por número sem LID conhecido, a mensagem pode ser de quem está na lista "nunca ler": descarta e
   * conta, sem guardar nada dela.
   */
  async function conversaDe(msg: WAMessage): Promise<{ chave: string; grupo: boolean } | undefined> {
    const remoto = msg.key.remoteJid;
    if (!remoto) return undefined;
    const jid = normalizar(remoto);
    if (ehSempreIgnorado(jid)) return undefined;
    if (ehGrupo(jid)) return banco.grupoPermitido(jid) ? { chave: jid, grupo: true } : undefined;
    if (!ehIndividual(jid)) return undefined;
    let chave = jid;
    if (ehLid(jid)) {
      // Baileys 7: conversa com LID traz o número em remoteJidAlt (Nod whatsapp.ts:149).
      const alt = msg.key.remoteJidAlt && numeroDe(msg.key.remoteJidAlt) ? normalizar(msg.key.remoteJidAlt) : undefined;
      if (alt) banco.mapearLid(jid, alt);
      chave = alt ?? banco.chaveDaConversa(jid);
      if (chave === jid) {
        const pn = await numeroPelaBaileys(jid);
        if (pn) {
          banco.mapearLid(jid, pn); // se o número está na lista "nunca ler", o LID entra também
          chave = pn;
        } else if (banco.haBloqueioSemLid()) {
          descartadas++;
          log(`[whatsapp-claude] mensagem de um LID sem número conhecido descartada: há bloqueio por número sem LID conhecido (${descartadas} desde a partida).`);
          return undefined;
        }
      }
    }
    if (banco.estaBloqueado(chave) || banco.estaBloqueado(jid)) return undefined;
    return { chave, grupo: false };
  }

  async function preparar(msg: WAMessage): Promise<{ chave: string; grupo: boolean; mensagem: MensagemGuardada } | undefined> {
    const id = msg.key.id;
    // Eco do que nós enviamos nunca vira mensagem recebida (Nod whatsapp.ts:270-272, `sentIds`).
    if (!id || enviados.has(id)) return undefined;
    const ts = dataDaMensagem(msg, relogio.agora());
    if (ts === undefined) return undefined;
    // Converte antes: o que não vira mensagem guardada (reação, aviso de protocolo...) nem pergunta à Baileys.
    // (`grupo` aqui é o mesmo que conversaDe decide: só jid de grupo vira conversa de grupo.)
    const mensagem = converterMensagem(msg, { ts, grupo: ehGrupo(normalizar(msg.key.remoteJid ?? "")) });
    if (!mensagem) return undefined;
    const destino = await conversaDe(msg);
    if (!destino) return undefined;
    if (destino.grupo && !mensagem.de_mim) completarRemetente(msg, destino.chave, mensagem);
    return { ...destino, mensagem };
  }

  /** Apagada para todos e editada: muda a linha guardada, só se quem apaga ou edita é quem escreveu. */
  async function receberAlteracao(msg: WAMessage): Promise<boolean> {
    const alt = alteracaoDaMensagem(msg);
    if (!alt) return false;
    if (msg.key.id && enviados.has(msg.key.id)) return true;
    const destino = await conversaDe(msg);
    if (!destino) return true;
    const autor = autorDaMensagem(msg, destino.grupo);
    if (alt.tipo === "apagada") banco.apagarMensagem(destino.chave, alt.id, autor);
    else banco.editarMensagem(destino.chave, alt.id, alt.texto, autor);
    return true;
  }

  /**
   * 0.9.2: um lote ao vivo (`messages.upsert`), gravado UMA vez por conversa. Com o teto de 5.000, regravar o arquivo
   * inteiro a cada mensagem custava segundos num lote de mensagens atrasadas. As mensagens novas ficam pendentes por
   * conversa, na ordem de chegada, e vão juntas por `Banco.gravarEmSequencia`, que aplica uma por uma em memória (o
   * resultado é o mesmo de antes). As pendentes são gravadas ANTES de:
   * - edição e exclusão (aplicadas na ordem em que chegaram, sobre o banco como estaria);
   * - mensagem que pode mudar o mapa LID -> número (0.11.0: só ela; antes, toda mensagem de LID), porque o `conversaDe`
   *   ou o remetente de grupo dela pode mapear o LID e mover ou bloquear conversa (`mapearLid`). Conversa de LID já
   *   mapeado entra no lote como as outras.
   * O filtro de entrada não muda (é o mesmo `preparar`). Se o transporte fechar no meio do lote, as pendentes NÃO são
   * gravadas: depois de um wa_desconectar, gravar recriaria dado apagado.
   */
  async function receberLoteAoVivo(lote: readonly WAMessage[], tipo: "notify" | "append", aindaVale: () => boolean): Promise<void> {
    const pendentes = new Map<string, Array<{ grupo: boolean; mensagem: MensagemGuardada; contarNaoLidas: boolean; nome: string | null | undefined }>>();
    const gravarPendentes = async (): Promise<void> => {
      const conversas = [...pendentes];
      pendentes.clear();
      for (const [chave, lista] of conversas) {
        if (!aindaVale()) return;
        seguro("mensagem não gravada", () => {
          banco.gravarEmSequencia(
            chave,
            lista.map((p) => ({ novas: [p.mensagem], opcoes: { contarNaoLidas: p.contarNaoLidas } })),
          );
          for (const p of lista) if (!p.grupo && !p.mensagem.de_mim) banco.definirNome(chave, p.nome, PRIORIDADE.publico, "publico");
        });
        await cederAoLaco();
      }
    };
    let vistas = 0;
    for (const msg of lote) {
      if (!aindaVale()) return;
      await seguroAssincrono("mensagem não gravada", async () => {
        if (pendentes.size > 0 && (alteracaoDaMensagem(msg) || podeMudarOMapa(msg))) await gravarPendentes();
        if (await receberAlteracao(msg)) return;
        const p = await preparar(msg);
        if (!p) return;
        // `append` = entregue enquanto este aparelho estava offline (lib/Socket/messages-recv.js:1432, `node.attrs.offline`):
        // conta como não lida se é depois do momento da ligação. Minha (escrita no celular) zera, como no `notify`.
        const contarNaoLidas = tipo === "notify" || (ligadoEm !== undefined && p.mensagem.ts > ligadoEm);
        const lista = pendentes.get(p.chave) ?? [];
        lista.push({ grupo: p.grupo, mensagem: p.mensagem, contarNaoLidas, nome: msg.pushName });
        pendentes.set(p.chave, lista);
      });
      // 0.7.4: lote grande (mensagens entregues offline) também devolve o controle ao laço.
      if (++vistas % CEDER_A_CADA === 0) await cederAoLaco();
    }
    await gravarPendentes();
  }

  /**
   * Resposta a um pedido de histórico (`messaging-history.set` com syncType ON_DEMAND; Baileys rc14,
   * lib/Utils/process-message.js:241-276). Só entra o que é de uma conversa com pedido em andamento NESTE processo, pelos
   * mesmos filtros de sempre (preparar/conversaDe: "nunca ler", grupos escolhidos, LID). Sem pedido, nada entra.
   */
  async function receberHistoricoSobDemanda(evento: {
    chats?: Array<{ id?: string | null }>;
    messages?: WAMessage[];
    lidPnMappings?: Array<{ lid: string; pn: string }>;
    peerDataRequestSessionId?: string | null;
  }): Promise<number> {
    if (pedidosDeHistorico.size === 0) return 0;
    let vistas = 0;
    await aplicarEmLotes(paresParaAplicar(evento.lidPnMappings ?? []));
    const ganhos = new Map<PedidoDeHistorico, { recebidas: number; novas: number; cortadas: number }>();
    const ganhoDe = (p: PedidoDeHistorico) => ganhos.get(p) ?? ganhos.set(p, { recebidas: 0, novas: 0, cortadas: 0 }).get(p)!;
    // 0.7.2: pelo id do pedido. Conta como resposta mesmo sem mensagem nenhuma ("não há nada mais antigo").
    const sessaoDoPedido = evento.peerDataRequestSessionId || undefined;
    if (sessaoDoPedido) for (const p of pedidosDeHistorico.values()) if (p.id === sessaoDoPedido) ganhoDe(p);
    // As mensagens: só de conversa que este processo pediu, pelos filtros de sempre (vale também a reserva de antes:
    // mensagem da conversa pedida é resposta, mesmo com outro id).
    const porConversa = new Map<string, MensagemGuardada[]>();
    for (const msg of evento.messages ?? []) {
      if (++vistas % CEDER_A_CADA === 0) await cederAoLaco();
      const p = await preparar(msg);
      if (!p || !pedidosDeHistorico.has(p.chave)) continue;
      const lista = porConversa.get(p.chave) ?? [];
      lista.push(p.mensagem);
      porConversa.set(p.chave, lista);
    }
    let gravadas = 0;
    for (const [chave, lista] of porConversa) {
      const pedido = pedidosDeHistorico.get(chave);
      if (!pedido) continue;
      // 0.11.0: uma leitura do arquivo só (antes eram três: antes, na gravação e depois), com o mesmo resultado.
      const { aceitas, ficaram: guardadas } = banco.gravarMensagensContando(chave, lista, { contarNaoLidas: false });
      const g = ganhoDe(pedido);
      g.recebidas += lista.length;
      g.novas += guardadas;
      g.cortadas += Math.max(0, aceitas - guardadas);
      gravadas += guardadas;
      await cederAoLaco();
    }
    // Reserva: resposta sem mensagem nenhuma da conversa, mas com o chat dela, também é resposta.
    for (const chat of evento.chats ?? []) {
      const chave = chat.id ? banco.chaveDaConversa(chat.id) : undefined;
      const pedido = chave ? pedidosDeHistorico.get(chave) : undefined;
      if (pedido) ganhoDe(pedido);
    }
    for (const [pedido, g] of ganhos) {
      pedido.recebidas += g.recebidas;
      pedido.novas += g.novas;
      pedido.cortadas += g.cortadas;
      pedido.chegou = true;
      if (pedido.fase === "pendente") pedido.acordar();
      else anotarAtrasada(pedido, g);
    }
    return gravadas;
  }

  /** 0.7.2: resposta reconhecida depois do tempo. Fica anotada para a próxima chamada da conversa, e o `auto` fica nela. */
  function anotarAtrasada(pedido: PedidoDeHistorico, g: { recebidas: number; novas: number; cortadas: number }): void {
    if (!pedido.atrasada) {
      pedido.atrasada = { variacao: pedido.variacao, segundos_apos_o_pedido: segundosDesde(pedido), recebidas: 0, novas: 0, cortadas: 0 };
      respostasAtrasadas.set(pedido.jid, pedido.atrasada);
    }
    pedido.atrasada.recebidas += g.recebidas;
    pedido.atrasada.novas += g.novas;
    pedido.atrasada.cortadas += g.cortadas;
    variacaoAuto.set(pedido.jid, pedido.variacao);
    log(`[whatsapp-claude] histórico sob demanda: resposta atrasada (variação ${pedido.variacao}, ${pedido.atrasada.segundos_apos_o_pedido} s depois do pedido, ${g.novas} mensagem(ns) nova(s)).`);
  }

  const segundosDesde = (p: PedidoDeHistorico): number => Math.round((relogio.agora() - p.inicio) / 100) / 10;
  /** Onde vai o que se vê de um pedido: no diagnóstico até o tempo, e depois na observação. */
  const alvoDe = (p: PedidoDeHistorico): ObservadoNoHistorico => (p.fase === "pendente" ? p.diag : p.depois);

  /** A mensagem é da conversa pedida? Só para contar no diagnóstico: sem perguntar nada à Baileys e sem gravar. */
  function daConversa(msg: WAMessage, jid: string): boolean {
    const remoto = msg.key?.remoteJid;
    if (!remoto) return false;
    const n = normalizar(remoto);
    if (n === jid || banco.chaveDaConversa(n) === jid) return true;
    return Boolean(msg.key.remoteJidAlt && normalizar(msg.key.remoteJidAlt) === jid);
  }

  /** 0.7.2: todo `messaging-history.set` que chega enquanto há pedido vira uma linha no diagnóstico (tipos e contagens). */
  function observarHistorico(evento: { chats?: unknown[]; messages?: WAMessage[]; syncType?: number | null; peerDataRequestSessionId?: string | null }): void {
    const tipo = typeof evento.syncType === "number" ? evento.syncType : null;
    const sessaoDoPedido = evento.peerDataRequestSessionId || undefined;
    for (const p of pedidosDeHistorico.values()) {
      const alvo = alvoDe(p);
      if (alvo.eventos_de_historico.length >= MAXIMO_DE_EVENTOS_NO_DIAGNOSTICO) continue;
      alvo.eventos_de_historico.push({
        tipo,
        tem_id_de_pedido: sessaoDoPedido !== undefined,
        id_bate: sessaoDoPedido !== undefined && sessaoDoPedido === p.id,
        chats: evento.chats?.length ?? 0,
        mensagens: evento.messages?.length ?? 0,
        da_conversa_pedida: (evento.messages ?? []).filter((m) => daConversa(m, p.jid)).length,
        segundos_apos_o_pedido: segundosDesde(p),
      });
    }
  }

  /**
   * 0.7.2: mensagens de protocolo do `messages.upsert` que interessam ao pedido, vistas ANTES de qualquer filtro (nada
   * aqui muda o que é gravado ou ignorado): a resposta PDO (só os nomes dos campos de cada resultado) e a notificação de
   * histórico (que a Baileys baixa e só depois vira `messaging-history.set`; se o download falhar, só ela aparece).
   */
  function observarProtocolo(mensagens: readonly WAMessage[]): void {
    for (const msg of mensagens) {
      const pm = msg.message?.protocolMessage;
      if (!pm) continue;
      if (pm.type === proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE) {
        const resposta = pm.peerDataOperationRequestResponseMessage;
        const campos = new Set<string>();
        for (const item of resposta?.peerDataOperationResult ?? []) {
          for (const [nome, valor] of Object.entries(item ?? {})) if (valor !== null && valor !== undefined && /^[A-Za-z0-9_]{1,60}$/.test(nome)) campos.add(nome);
        }
        for (const p of pedidosDeHistorico.values()) {
          const alvo = alvoDe(p);
          if (alvo.respostas_pdo.length >= MAXIMO_DE_RESPOSTAS_PDO_NO_DIAGNOSTICO) continue;
          alvo.respostas_pdo.push({ id_bate: p.id !== undefined && resposta?.stanzaId === p.id, campos: [...campos].sort() });
        }
      } else if (pm.type === proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION) {
        const n = pm.historySyncNotification;
        const sessaoDoPedido = n?.peerDataRequestSessionId || undefined;
        for (const p of pedidosDeHistorico.values()) {
          const alvo = alvoDe(p);
          if (alvo.notificacoes_de_historico.length >= MAXIMO_DE_EVENTOS_NO_DIAGNOSTICO) continue;
          alvo.notificacoes_de_historico.push({
            tipo: typeof n?.syncType === "number" ? n.syncType : null,
            tem_id_de_pedido: sessaoDoPedido !== undefined,
            id_bate: sessaoDoPedido !== undefined && sessaoDoPedido === p.id,
            segundos_apos_o_pedido: segundosDesde(p),
          });
        }
      }
    }
  }

  /** 0.7.2: ack do servidor e recibo do celular, comparados pelo id do pedido (só o tipo vai para o diagnóstico). */
  function verNoWs(tipo: "ack" | "recibo", no: unknown): void {
    if (pedidosDeHistorico.size === 0) return;
    const attrs = (no as { attrs?: Record<string, unknown> } | undefined)?.attrs;
    const id = typeof attrs?.id === "string" ? attrs.id : undefined;
    if (!id) return;
    const detalhe = tipo === "recibo" ? (attrs?.type === undefined ? "sem_tipo" : valorDoProtocolo(attrs.type)) : attrs?.error === undefined ? null : valorDoProtocolo(attrs.error);
    for (const p of pedidosDeHistorico.values()) {
      if (p.id === undefined) {
        if (p.vistosSemId.length < MAXIMO_DE_VISTOS_SEM_ID) p.vistosSemId.push({ tipo, id, detalhe });
      } else if (p.id === id) aplicarNoWs(p, tipo, detalhe);
    }
  }

  function aplicarNoWs(p: PedidoDeHistorico, tipo: "ack" | "recibo", detalhe: string | null): void {
    const alvo = alvoDe(p);
    if (tipo === "ack") {
      alvo.ack_do_servidor = true;
      if (detalhe) alvo.erro_no_ack ??= detalhe;
      return;
    }
    const vistos = alvo.recibo_do_celular ? alvo.recibo_do_celular.split(",") : [];
    if (detalhe && !vistos.includes(detalhe) && vistos.length < 5) alvo.recibo_do_celular = [...vistos, detalhe].join(",");
  }

  /** 0.7.4: a parte do usuário do número e do LID do dono (para `do_proprio_numero`; nunca vai para o diagnóstico). */
  function proprios(): Set<string> {
    const s = new Set<string>();
    for (const j of [auth?.creds.me?.id, auth?.creds.me?.lid, socket?.user?.id, (socket?.user as { lid?: string } | undefined)?.lid]) {
      const u = usuarioDoJid(j);
      if (u) s.add(u);
    }
    return s;
  }

  /** 0.7.4: um nó do WebSocket vira uma linha (só tag, tipo, categoria e booleanos) no diagnóstico de cada pedido. */
  function verNo(no: unknown): void {
    let meus: Set<string> | undefined;
    for (const p of pedidosDeHistorico.values()) {
      const alvo = alvoDe(p);
      if (alvo.nos_recebidos.length >= MAXIMO_DE_NOS_NO_DIAGNOSTICO) continue;
      meus ??= proprios();
      const r = resumoDoNo(no, meus, segundosDesde(p));
      if (!r) return;
      alvo.nos_recebidos.push(r);
    }
  }

  /** Fim da observação (ou pedido novo da mesma conversa): sai da lista e guarda o que se viu depois do tempo. */
  function encerrarObservacao(p: PedidoDeHistorico): void {
    relogio.clearTimeout(p.fimDaObservacao);
    p.fimDaObservacao = undefined;
    if (pedidosDeHistorico.get(p.jid) === p) pedidosDeHistorico.delete(p.jid);
    if (algoObservado(p.depois)) observadoDepoisDoTempo.set(p.jid, p.depois);
  }

  /** Conexão parada ou fechada: nenhum temporizador de observação fica vivo. */
  function encerrarObservacoes(): void {
    for (const p of [...pedidosDeHistorico.values()]) if (p.fase === "observacao") encerrarObservacao(p);
  }

  /** O LID de uma conversa individual pelo número: o mapa do banco, ou o da Baileys. undefined se não se sabe. */
  async function lidDaConversa(jid: string, atual: SocketWa): Promise<string | undefined> {
    if (ehGrupo(jid) || !numeroDe(jid)) return undefined;
    const doBanco = banco.lidDoNumero(jid);
    if (doBanco) return doBanco;
    try {
      const lid = await atual.signalRepository.lidMapping.getLIDForPN(jid);
      return lid && ehLid(normalizar(lid)) ? normalizar(lid) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Por que uma variação não serve para esta conversa (frase sem jid), ou undefined se serve. */
  function motivoParaNaoUsar(v: VariacaoDoHistorico, jid: string, lid: string | undefined, atual: SocketWa): string | undefined {
    if (v === "padrao" || v === "segundos") return undefined;
    if (ehGrupo(jid)) return "em grupo não há LID da conversa";
    if (ehLid(jid)) return v === "lid" ? "esta conversa só é conhecida pelo LID, e o pedido padrão já usa o LID" : "o número desta conversa não é conhecido (só o LID)";
    if (!lid) return "o LID desta conversa ainda não é conhecido";
    if (v === "pn_com_conta" && typeof atual.sendPeerDataOperationMessage !== "function") return "esta conexão não permite montar o pedido com o LID da conta";
    return undefined;
  }

  /** Histórico recente (`messaging-history.set`): só conversas individuais fora da lista "nunca ler" e grupos da lista. */
  async function receberHistorico(evento: {
    chats?: Array<{ id?: string | null; name?: string | null; unreadCount?: number | null }>;
    contacts?: Array<{ id: string; lid?: string; phoneNumber?: string; name?: string; notify?: string; verifiedName?: string }>;
    messages?: WAMessage[];
    lidPnMappings?: Array<{ lid: string; pn: string }>;
  }): Promise<number> {
    // 0.7.4: cada passo grava no disco de forma síncrona (o índice cifrado inteiro, a conversa inteira): a cada
    // CEDER_A_CADA itens e depois de cada conversa, o laço de eventos respira. A ordem e o resultado não mudam.
    let vistos = 0;
    const respirar = async () => {
      if (++vistos % CEDER_A_CADA === 0) await cederAoLaco();
    };
    // 0.15.2: os pares e os contatos em lote (uma gravação do índice por lote), cedendo ao laço entre lotes.
    await aplicarEmLotes(paresParaAplicar(evento.lidPnMappings ?? []));
    const porConversa = new Map<string, MensagemGuardada[]>();
    for (const msg of evento.messages ?? []) {
      await respirar();
      const p = await preparar(msg);
      if (!p) continue;
      const lista = porConversa.get(p.chave) ?? [];
      lista.push(p.mensagem);
      porConversa.set(p.chave, lista);
    }
    let gravadas = 0;
    for (const [chave, lista] of porConversa) {
      gravadas += banco.gravarMensagens(chave, lista, { contarNaoLidas: false });
      await cederAoLaco();
    }
    const contatos = evento.contacts ?? [];
    if (contatos.length > 0) {
      const contando = contandoContatos;
      if (contando) contando.recebidos += contatos.length;
      await aplicarEmLotes(contatos.map(contatoParaAplicar), contando);
    }
    for (const chat of evento.chats ?? []) {
      await respirar();
      if (!chat.id) continue;
      const chave = banco.chaveDaConversa(chat.id);
      if (!banco.aceitaGravar(chave)) continue;
      if (chat.name) banco.definirNome(chave, chat.name, ehGrupo(chave) ? PRIORIDADE.contato : PRIORIDADE.conversa, ehGrupo(chave) ? undefined : "nome_da_conversa");
      if (typeof chat.unreadCount === "number" && chat.unreadCount >= 0) banco.definirNaoLidas(chave, chat.unreadCount);
    }
    return gravadas;
  }

  /**
   * Contatos que chegam (histórico, `contacts.upsert`, `contacts.update`, e a agenda pedida de novo). A ordem dos nomes
   * não muda: o da agenda do dono (`name`, PRIORIDADE.contato), o de empresa verificada (`verifiedName`, entre os dois) e
   * o público (`notify`). 0.15.0: a origem do nome vai junto. Com LID e número, o par vai para o mapa antes do nome.
   */
  function contatoParaAplicar(c: { id?: string; lid?: string; phoneNumber?: string; name?: string; notify?: string; verifiedName?: string }): ContatoParaAplicar {
    const id = c.id ? normalizar(c.id) : undefined;
    const pn = c.phoneNumber && numeroDe(c.phoneNumber) ? normalizar(c.phoneNumber) : id && numeroDe(id) ? id : undefined;
    const lid = c.lid && ehLid(c.lid) ? normalizar(c.lid) : id && ehLid(id) ? id : undefined;
    const nome = c.name
      ? { nome: c.name, prioridade: PRIORIDADE.contato, origem: "agenda_do_whatsapp" as const }
      : c.verifiedName
        ? { nome: c.verifiedName, prioridade: PRIORIDADE.conversa, origem: "empresa" as const }
        : c.notify
          ? { nome: c.notify, prioridade: PRIORIDADE.publico, origem: "publico" as const }
          : { prioridade: 0 };
    return { ...(lid ? { lid } : {}), ...(pn ? { pn } : {}), ...nome };
  }
  const paresParaAplicar = (pares: ReadonlyArray<{ lid: string; pn: string }>): ContatoParaAplicar[] => pares.map((p) => ({ lid: p.lid, pn: p.pn, prioridade: 0 }));

  /** Um lote pequeno no banco, de uma vez (o evento que vai na hora); com um pedido da agenda em andamento, conta os nomes novos e os atualizados. */
  function aplicarLote(itens: readonly ContatoParaAplicar[], contando: typeof contandoContatos): void {
    for (let i = 0; i < itens.length; ) i += aplicarParte(itens.slice(i), contando, Number.POSITIVE_INFINITY);
  }

  /** Aplica do começo de `itens` até o banco parar (lote ou pares que movem conversa); devolve quantos foram. */
  function aplicarParte(itens: readonly ContatoParaAplicar[], contando: typeof contandoContatos, complicados: number): number {
    const { resultados, aplicados } = banco.aplicarContatos(itens, complicados);
    if (contando) {
      for (const r of resultados) {
        if (r === "novo") contando.novos++;
        else if (r === "atualizado") contando.atualizados++;
      }
    }
    return Math.max(1, aplicados);
  }

  /** 0.15.2: em lotes de LOTE_DE_CONTATOS, cedendo ao laço entre eles. Para no meio se a conexão fechou ou parou. */
  async function aplicarEmLotes(itens: readonly ContatoParaAplicar[], contando?: typeof contandoContatos, aindaVale: () => boolean = () => !(fechado || parado)): Promise<void> {
    for (let i = 0; i < itens.length; ) {
      if (i > 0) await cederAoLaco();
      if (!aindaVale()) return;
      i += aplicarParte(itens.slice(i, i + LOTE_DE_CONTATOS), contando, PARES_QUE_MOVEM_POR_LOTE);
    }
  }

  /**
   * 0.15.2: a fila dos contatos e dos pares LID -> número que chegam por evento, na ordem de chegada. Evento pequeno com a
   * fila parada vai na hora, como antes; o grande vai em lotes; os `lid-mapping.update` (a Baileys emite um por contato,
   * seguidos, dentro do mesmo laço síncrono) se juntam e vão em lote no giro seguinte.
   */
  const filaDeContatos: Array<{ itens: ContatoParaAplicar[]; contando: typeof contandoContatos; aindaVale: () => boolean; pares: boolean }> = [];
  let tratandoContatos: Promise<void> | undefined;

  function receberContatos(contatos: ReadonlyArray<{ id?: string; lid?: string; phoneNumber?: string; name?: string; notify?: string; verifiedName?: string }>, aindaVale: () => boolean): void {
    const contando = contandoContatos;
    if (contando) contando.recebidos += contatos.length;
    const itens = contatos.map(contatoParaAplicar);
    if (!tratandoContatos && itens.length <= LOTE_DE_CONTATOS) {
      seguro("contatos", () => aplicarLote(itens, contando));
      return;
    }
    filaDeContatos.push({ itens, contando, aindaVale, pares: false });
    tratarFilaDeContatos();
  }

  function receberParDeLid(par: { lid: string; pn: string }, aindaVale: () => boolean): void {
    const ultimo = filaDeContatos.at(-1);
    if (ultimo?.pares && ultimo.aindaVale === aindaVale) ultimo.itens.push(...paresParaAplicar([par]));
    else filaDeContatos.push({ itens: paresParaAplicar([par]), contando: undefined, aindaVale, pares: true });
    tratarFilaDeContatos();
  }

  function tratarFilaDeContatos(): void {
    if (tratandoContatos) return;
    tratandoContatos = (async () => {
      // O giro seguinte: os pares que a Baileys emite em rajada chegam todos antes.
      await cederAoLaco();
      for (let op = filaDeContatos.shift(); op; op = filaDeContatos.shift()) {
        const { itens, contando, aindaVale } = op;
        await seguroAssincrono("contatos", () => aplicarEmLotes(itens, contando, aindaVale));
        await cederAoLaco();
      }
    })().finally(() => {
      tratandoContatos = undefined;
      // Chegou algo entre o fim do laço e aqui: começa de novo.
      if (filaDeContatos.length > 0) tratarFilaDeContatos();
    });
  }

  /** Executa um tratador de evento sem deixar erro derrubar o processo. */
  function seguro(onde: string, f: () => void): void {
    try {
      f();
    } catch (erro) {
      avisar(onde, erro);
    }
  }
  async function seguroAssincrono(onde: string, f: () => Promise<void>): Promise<void> {
    try {
      await f();
    } catch (erro) {
      avisar(onde, erro);
    }
  }

  /** Só as respostas que NÓS enviamos (e só pelo id, que é nosso): nunca uma mensagem recebida. */
  function respostaParaReenviar(chave: { id?: string | null; fromMe?: boolean | null }): proto.IMessage | undefined {
    if (chave.fromMe !== true || !chave.id) return undefined;
    const r = respostasRecentes.get(chave.id);
    if (!r) return undefined;
    if (relogio.agora() - r.em > VALIDADE_DAS_RESPOSTAS_EM_MEMORIA_MS) {
      respostasRecentes.delete(chave.id);
      return undefined;
    }
    return r.message;
  }

  /** Marcas do pareamento em andamento, para o cartão saber em que etapa está. */
  const marcasDoPareamento = (): Partial<EstadoDaConexao> => (pareando ? { pareando: true, ...(qrLido ? { qr_lido: true } : {}) } : {});

  function conectar(): void {
    if (fechado || parado || !auth) return;
    soltarOuvintesDoWs?.();
    soltarOuvintesDoWs = undefined;
    estado = { ...donoDoSocket(), situacao: "conectando", ...marcasDoPareamento() };
    const atual = criarSocket({
      auth,
      // Nod whatsapp.ts:331 usa um logger mudo. 0.7.4: continua sem escrever nada, mas guarda os avisos (só o texto
      // saneado) para o diagnóstico do histórico e a caixa-preta (avisos-da-biblioteca.ts).
      logger: loggerDaBiblioteca as unknown as SocketConfig["logger"],
      // Aparelho vinculado com o nome padrão de Mac da Baileys (no Nod: ['nod','Chrome','1.0'], whatsapp.ts:332).
      // 0.7.6: registra como navegador (Chrome) por padrão; ver navegadorDoRegistro.
      browser: navegadorDoRegistro(),
      // Histórico: só o recente, como o WhatsApp Web (Nod whatsapp.ts:333 também usa false).
      syncFullHistory: false,
      // O Nod recusa todo histórico (whatsapp.ts:334); aqui só o completo (FULL) é recusado. Histórico sob demanda
      // só quando o dono pede (wa_buscar_historico, experimental): a resposta ON_DEMAND passa por aqui e depois pelo
      // receberHistoricoSobDemanda, que só guarda o que este processo pediu.
      shouldSyncHistoryMessage: (n) => n.syncType !== proto.HistorySync.HistorySyncType.FULL,
      markOnlineOnConnect: false, // Nod whatsapp.ts:335: nunca aparece online
      emitOwnEvents: false, // Nod whatsapp.ts:336
      // Desvio do Nod (whatsapp.ts:337 usa 0): ver PEDIDOS_DE_REENVIO.
      maxMsgRetryCount: PEDIDOS_DE_REENVIO,
      enableAutoSessionRecreation: false, // Nod whatsapp.ts:338
      // Nod whatsapp.ts:339. Fica desligado de propósito: o MessageRetryManager que ele liga (lib/Socket/messages-send.js:32)
      // guarda na memória não só o que enviamos (messages-send.js:879) mas também toda mensagem RECEBIDA e decifrada
      // (messages-recv.js:1295), e muda o fluxo de reenvio (pedido ao celular com atraso, chave-base). O que importa
      // dele, reenviar a NOSSA resposta a quem pediu, o getMessage abaixo faz.
      enableRecentMessageCache: false,
      // Desvio do Nod (whatsapp.ts:340 devolve sempre undefined): devolve só as respostas que NÓS enviamos nos últimos
      // 30 min, pelo id (o pedido de reenvio pode vir pelo LID), para quem recebeu não ficar com "aguardando mensagem".
      getMessage: async (chave) => respostaParaReenviar(chave),
      connectTimeoutMs: 30_000, // Nod whatsapp.ts:341
      defaultQueryTimeoutMs: 30_000, // Nod whatsapp.ts:342
      qrTimeout: VIDA_DO_QR_MS, // Nod whatsapp.ts:343
      // Nod whatsapp.ts:344-349, com as listas do dono: o que volta true nem é decifrado.
      shouldIgnoreJid: (jid) => banco.deveIgnorar(jid),
    });
    socket = atual;
    // Nunca marcar como lida: mesmo que algum código chame, o socket recusa.
    if ("readMessages" in atual) {
      (atual as { readMessages: unknown }).readMessages = async () => {
        throw new Error("Este servidor nunca marca mensagens como lidas.");
      };
    }

    // Credenciais novas vão cifradas para a sessão (Nod whatsapp.ts:352-356).
    atual.ev.on("creds.update", (update) => {
      if (fechado || parado || socket !== atual || !auth) return;
      Object.assign(auth.creds, update);
      sessao.registrarSegredosDasCredenciais(auth.creds);
      void salvar({ creds: JSON.stringify(auth.creds, BufferJSON.replacer) }).catch(() => {});
    });

    // Mensagens ao vivo, em fila e com teto (Nod whatsapp.ts:357-371). `requestId` = resposta a pedido de
    // reenvio ao celular: ignorada, como no Nod (358).
    atual.ev.on("messages.upsert", (evento) => {
      if (fechado || parado || socket !== atual) return;
      // 0.7.2: diagnóstico do pedido de histórico, antes de qualquer filtro (só olha; não grava nem ignora nada).
      if (pedidosDeHistorico.size > 0) seguro("diagnóstico do histórico", () => observarProtocolo(evento.messages));
      if (evento.requestId) return;
      const lote = evento.messages.slice(0, Math.max(0, TETO_DA_FILA - naFila));
      naFila += lote.length;
      const tipo = evento.type === "notify" ? "notify" : "append";
      recebidas = recebidas
        .then(() => receberLoteAoVivo(lote, tipo, () => !(fechado || parado || socket !== atual)))
        .finally(() => {
          naFila -= lote.length;
        });
    });

    atual.ev.on("messaging-history.set", (evento) => {
      if (fechado || parado || socket !== atual) return;
      // Histórico sob demanda (resposta a wa_buscar_historico) tem caminho próprio: só entra o que este processo pediu.
      const sobDemanda = (evento as { syncType?: number | null }).syncType === proto.HistorySync.HistorySyncType.ON_DEMAND;
      if (pedidosDeHistorico.size > 0) seguro("diagnóstico do histórico", () => observarHistorico(evento));
      recebidas = recebidas.then(() =>
        seguroAssincrono("histórico não gravado", async () => {
          // 0.7.4: a caixa-preta registra cada lote (só contagens e quanto tempo levou), mesmo se a gravação falhar no meio.
          const inicio = relogio.agora();
          let gravadas = 0;
          try {
            gravadas = sobDemanda ? await receberHistoricoSobDemanda(evento) : await receberHistorico(evento);
          } finally {
            const e = evento as { syncType?: number | null; progress?: number | null };
            historicoNaCaixa({
              tipo: typeof e.syncType === "number" ? e.syncType : null,
              progresso: typeof e.progress === "number" ? e.progress : null,
              chats: evento.chats?.length ?? 0,
              mensagens: evento.messages?.length ?? 0,
              gravadas,
              duracao_ms: Math.max(0, Math.round(relogio.agora() - inicio)),
              eventos: 1,
            });
          }
        }),
      );
    });

    // 0.7.2: ack do servidor e recibo do celular do pedido de histórico (só se o socket expõe o `ws`). Os outros ouvintes
    // ficam no `ev` do socket velho e só checam `socket !== atual`; estes saem de vez quando o socket é trocado ou fechado.
    const ws = atual.ws;
    if (ws) {
      const aoAck = (no: unknown) => {
        if (!(fechado || parado || socket !== atual)) seguro("diagnóstico do histórico", () => verNoWs("ack", no));
      };
      const aoRecibo = (no: unknown) => {
        if (!(fechado || parado || socket !== atual)) seguro("diagnóstico do histórico", () => verNoWs("recibo", no));
      };
      // 0.7.4: todo nó que chega (o `frame` sai antes de qualquer `CB:<tag>`, lib/Socket/socket.js:446), resumido.
      const aoNo = (no: unknown) => {
        if (pedidosDeHistorico.size > 0 && !(fechado || parado || socket !== atual)) seguro("diagnóstico do histórico", () => verNo(no));
      };
      ws.on("CB:ack,class:message", aoAck);
      ws.on("CB:receipt", aoRecibo);
      ws.on("frame", aoNo);
      soltarOuvintesDoWs = () => {
        ws.off("CB:ack,class:message", aoAck);
        ws.off("CB:receipt", aoRecibo);
        ws.off("frame", aoNo);
      };
    }

    // 0.15.1: o fim do histórico inicial (Baileys rc14, lib/Socket/chats.js:947-970: o RECENT com progress 100, ou parado
    // depois de 120 s sem pedaço novo). Não passa pelo buffer de eventos (Utils/event-buffer.js:6-19): chega na hora.
    atual.ev.on("messaging-history.status", (status) => {
      if (fechado || parado || socket !== atual) return;
      if (status.syncType === proto.HistorySync.HistorySyncType.RECENT) seguro("agenda automática", () => opcoes.aoTerminarHistoricoInicial?.());
    });
    const valeEsteSocket = () => !(fechado || parado || socket !== atual);
    atual.ev.on("lid-mapping.update", (m) => {
      if (!valeEsteSocket()) return;
      receberParDeLid(m, valeEsteSocket);
    });
    atual.ev.on("contacts.upsert", (contatos) => {
      if (!valeEsteSocket()) return;
      receberContatos(contatos, valeEsteSocket);
    });
    atual.ev.on("contacts.update", (contatos) => {
      if (!valeEsteSocket()) return;
      receberContatos(contatos, valeEsteSocket);
    });
    const conversas = (lista: ReadonlyArray<{ id?: string | null; name?: string | null; unreadCount?: number | null }>) =>
      seguro("conversas", () => {
        for (const chat of lista) {
          if (!chat.id) continue;
          const chave = banco.chaveDaConversa(chat.id);
          if (!banco.aceitaGravar(chave)) continue;
          if (chat.name) banco.definirNome(chave, chat.name, ehGrupo(chave) ? PRIORIDADE.contato : PRIORIDADE.conversa, ehGrupo(chave) ? undefined : "nome_da_conversa");
          // Lida no celular: zera aqui. Os incrementos a gente conta sozinho.
          if (chat.unreadCount === 0) banco.definirNaoLidas(chave, 0);
        }
      });
    atual.ev.on("chats.upsert", (lista) => {
      if (!(fechado || parado || socket !== atual)) conversas(lista);
    });
    atual.ev.on("chats.update", (lista) => {
      if (!(fechado || parado || socket !== atual)) conversas(lista);
    });
    atual.ev.on("groups.update", (lista) => {
      if (fechado || parado || socket !== atual) return;
      seguro("grupos", () => {
        for (const g of lista) if (g.id && g.subject && banco.grupoPermitido(g.id)) banco.definirNome(g.id, g.subject, PRIORIDADE.contato);
      });
    });

    // Conexão: QR, aberta e fechada (Nod whatsapp.ts:372-424).
    atual.ev.on("connection.update", (update) => {
      if (fechado || parado || socket !== atual) return;
      if (update.isNewLogin) {
        // pair-success (lib/Socket/socket.js:729-736): a sessão já está pareada. O prazo de 5 min do pareamento sai daqui:
        // se a reconexão 515 que vem depois demorar, ele apagaria uma sessão que deu certo.
        relogio.clearTimeout(expiracao);
        qrLido = true;
        abrirAposPareamento = true;
        ligadoEm = relogio.agora();
        void salvar({ "ligado-em": String(ligadoEm) }).catch(() => {});
        estado = { situacao: "conectando", ...marcasDoPareamento() };
      }
      else if (update.qr) {
        if (!pareando) {
          // Sessão guardada que pede QR = sessão que não vale mais. QR só aparece no cartão de pareamento.
          parar("parado", `A sessão guardada não foi aceita e o WhatsApp pediu um QR novo. ${PAREAR_DE_NOVO}`);
          return;
        }
        // O QR nunca sai em log nem em erro: só o cartão de pareamento o desenha (wa_estado_pareamento_tela).
        registrarSegredo(update.qr);
        estado = { situacao: "aguardando_qr", pareando: true, qr: update.qr, expira_em: new Date(relogio.agora() + VIDA_DO_QR_MS).toISOString() };
      }
      if (update.connection === "open") {
        // 0.7.4: na caixa-preta, quanto durou a conexão anterior e quanto tempo ficou sem conexão.
        const agora = relogio.agora();
        caixaPreta?.registrar("conexao_abriu", {
          conexao_anterior_durou_s: abriuEm !== undefined && caiuEm !== undefined && caiuEm >= abriuEm ? Math.round((caiuEm - abriuEm) / 1000) : null,
          sem_conexao_s: caiuEm !== undefined ? Math.round((agora - caiuEm) / 1000) : null,
        });
        abriuEm = agora;
        relogio.clearTimeout(expiracao); // Nod whatsapp.ts:388
        tentativa = 0; // Nod whatsapp.ts:389
        pareando = false;
        estado = { ...donoDoSocket(), situacao: "conectado" };
        if (ligadoEm === undefined) {
          // Sessão pareada antes da 0.4.0, sem o momento da ligação: vale a primeira conexão daqui em diante.
          ligadoEm = relogio.agora();
          void salvar({ "ligado-em": String(ligadoEm) }).catch(() => {});
        }
        // Metadados dos grupos uma vez ao conectar, se o cache passou de 1 h (decisão da Fase 2). Nenhuma mensagem é decifrada.
        if (!banco.cacheDeGruposFresco(relogio.agora())) {
          recebidas = recebidas.then(() => buscarGrupos().then(() => undefined, (erro) => avisar("não busquei os grupos", erro)));
        }
        // 0.15.1: a agenda automática (agenda.ts) decide se pede a agenda; dispara sem esperar.
        const aposPareamento = abrirAposPareamento;
        abrirAposPareamento = false;
        seguro("agenda automática", () => opcoes.aoAbrirConexao?.(aposPareamento));
      }
      if (update.connection === "close") {
        const codigo = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        // 0.7.4: caixa-preta (só o código numérico e a duração) e o diagnóstico do pedido de histórico em andamento.
        const agora = relogio.agora();
        caixaPreta?.registrar("conexao_caiu", {
          codigo: typeof codigo === "number" && Number.isFinite(codigo) ? codigo : null,
          durou_s: abriuEm !== undefined && (caiuEm === undefined || abriuEm > caiuEm) ? Math.round((agora - abriuEm) / 1000) : null,
        });
        caiuEm = agora;
        for (const p of pedidosDeHistorico.values()) alvoDe(p).conexao_caiu_durante_o_pedido = true;
        if (codigo === DisconnectReason.loggedOut) {
          // Nod whatsapp.ts:403-407: saiu do aparelho vinculado = apaga a sessão. Aqui apaga também o banco e as
          // listas, igual ao wa_desconectar (decisão da Fase 2).
          parar("sessao_encerrada", "O aparelho foi desconectado pelo celular (loggedOut). A sessão e as mensagens guardadas foram apagadas; será preciso parear de novo.", codigo);
          void apagarTudo().catch((erro) => avisar("não consegui apagar a sessão e o banco", erro));
        } else if (codigo === DisconnectReason.badSession && !quedas500Demais()) {
          reconectar(codigo);
        } else if (codigo !== undefined && MOTIVOS[codigo]) {
          // Nod whatsapp.ts:408-414: códigos graves param de vez, sem reconectar.
          parar("parado", MOTIVOS[codigo], codigo);
        } else {
          reconectar(codigo);
        }
      }
    });
  }

  /**
   * badSession (500): a Baileys usa 500 como padrão para todo stream:error desconhecido (lib/Utils/generics.js:292),
   * então nem sempre é sessão corrompida. Reconecta até QUEDAS_500_TOLERADAS vezes em 10 min; na seguinte, para de vez.
   */
  function quedas500Demais(): boolean {
    const agora = relogio.agora();
    quedas500 = [...quedas500.filter((t) => agora - t < JANELA_DAS_QUEDAS_500_MS), agora];
    return quedas500.length > QUEDAS_500_TOLERADAS;
  }

  /** Nod whatsapp.ts:415-421: reconexão com espera crescente até 60 s. */
  function reconectar(codigo: number | undefined): void {
    relogio.clearTimeout(reconexao);
    const espera = esperaDaReconexao(tentativa++);
    estado = {
      ...donoDoSocket(),
      situacao: "reconectando",
      ...marcasDoPareamento(),
      ...(codigo ? { codigo } : {}),
      proxima_tentativa_em: new Date(relogio.agora() + espera).toISOString(),
    };
    const t = relogio.setTimeout(() => conectar(), espera);
    t.unref?.();
    reconexao = t;
  }

  async function iniciar(op: { parear?: boolean } = {}): Promise<void> {
    if (fechado || parado) return;
    iniciando ??= (async () => {
      const credenciais = await sessao.get("creds");
      const creds = credenciais ? JSON.parse(credenciais, BufferJSON.reviver) : undefined;
      const pareada = typeof creds?.me?.id === "string";
      if (!pareada && !op.parear) {
        // Sem sessão, não conecta. Parear é da Fase 2 (wa_parear).
        estado = { situacao: "nao_pareado" };
        iniciando = undefined;
        return;
      }
      pareando = !pareada;
      qrLido = false;
      if (pareando) estado = { situacao: "conectando", ...marcasDoPareamento() };
      if (creds) sessao.registrarSegredosDasCredenciais(creds);
      // Estado de autenticação lido e gravado slot a slot, cifrado (Nod whatsapp.ts:434-460).
      auth = {
        creds: creds ?? initAuthCreds(),
        keys: {
          async get<T extends keyof SignalDataTypeMap>(tipo: T, ids: string[]) {
            const valores: { [id: string]: SignalDataTypeMap[T] } = Object.create(null);
            for (const id of ids) {
              const guardado = await sessao.get(`${tipo}:${id}`);
              if (guardado === undefined) continue;
              let valor = JSON.parse(guardado, BufferJSON.reviver);
              if (tipo === "app-state-sync-key") valor = proto.Message.AppStateSyncKeyData.fromObject(valor); // Nod 444-445
              valores[id] = valor;
            }
            return valores;
          },
          async set(dados) {
            const valores: Record<string, string | null> = Object.create(null);
            for (const [tipo, entradas] of Object.entries(dados)) {
              for (const [id, valor] of Object.entries(entradas ?? {})) {
                valores[`${tipo}:${id}`] = valor == null ? null : JSON.stringify(valor, BufferJSON.replacer);
              }
            }
            await salvar(valores);
          },
        },
      };
      // IDs enviados persistidos (Nod whatsapp.ts:462-463).
      for (const id of JSON.parse((await sessao.get("sent-ids")) ?? "[]") as string[]) enviados.add(id);
      const ligado = Number(await sessao.get("ligado-em"));
      ligadoEm = pareada && Number.isFinite(ligado) && ligado > 0 ? ligado : undefined;
      if (!credenciais) await salvar({ creds: JSON.stringify(auth.creds, BufferJSON.replacer) }); // Nod 465
      if (pareando) {
        // Pareamento que não termina em 5 min apaga a sessão (Nod whatsapp.ts:466-473).
        const t = relogio.setTimeout(() => {
          parar("expirado", "O pareamento não terminou em 5 minutos; a sessão incompleta foi apagada.");
          void apagarSessao().catch((erro) => avisar("não consegui apagar a sessão", erro));
        }, PRAZO_DO_PAREAMENTO_MS);
        t.unref?.();
        expiracao = t;
      }
      conectar();
    })().catch((erro) => {
      avisar("o WhatsApp não iniciou", erro);
      if (!fechado) parar("parado", "Não consegui ler a sessão guardada.");
    });
    await iniciando;
  }

  async function registrarEnviado(id: string): Promise<void> {
    enviados.add(id);
    while (enviados.size > MAXIMO_DE_IDS_ENVIADOS) enviados.delete(enviados.values().next().value!);
    await salvar({ "sent-ids": JSON.stringify([...enviados]) });
  }

  return {
    estado() {
      const { qr: _qr, ...semQr } = estado;
      // O QR só sai pelo cartão de pareamento (wa_estado_pareamento_tela); quem mostra ao modelo nunca o copia.
      return estado.situacao === "aguardando_qr" ? { ...semQr, qr: estado.qr! } : semQr;
    },
    iniciar,
    async lidDoNumero(jid) {
      if (!socket || estado.situacao !== "conectado") return undefined;
      try {
        const lid = await socket.signalRepository.lidMapping.getLIDForPN(jid);
        return lid && ehLid(normalizar(lid)) ? normalizar(lid) : undefined;
      } catch {
        return undefined;
      }
    },
    registrarEnviado,
    buscarGrupos,
    async responder(jid, texto, citar, opcoes) {
      const atual = socket;
      if (!atual || estado.situacao !== "conectado") throw new Error("O WhatsApp não está conectado agora. Nada foi enviado.");
      if (!ehIndividual(jid) && !ehGrupo(jid)) throw new Error("Só se responde conversa individual ou grupo. Nada foi enviado.");
      if (ehGrupo(jid) && !banco.grupoPermitido(jid)) throw new Error("Esse grupo não está entre os escolhidos. Nada foi enviado.");
      // "Digitando…" por 1 a 3 s e depois "pausado". NUNCA "available": o dono não aparece online.
      await atual.sendPresenceUpdate("composing", jid);
      await dormir(esperaDigitando());
      await atual.sendPresenceUpdate("paused", jid);
      if (socket !== atual || estado.situacao !== "conectado") throw new Error("A conexão caiu antes do envio. Nada foi enviado.");
      // Id nosso, guardado ANTES de enviar: o eco nunca vira mensagem recebida (Nod whatsapp.ts:489-492).
      const id = generateMessageIDV2(atual.user?.id);
      await registrarEnviado(id);
      // Em grupo, a chave da citada leva quem escreveu: o participante guardado, ou eu mesmo.
      const participante = ehGrupo(jid) ? (citar?.de_mim ? (atual.user?.id ? normalizar(atual.user.id) : undefined) : citar?.participante) : undefined;
      const quoted = citar
        ? ({ key: { remoteJid: jid, id: citar.id, fromMe: citar.de_mim, ...(participante ? { participant: participante } : {}) }, message: { conversation: citar.texto ?? "" } } as WAMessage)
        : undefined;
      const r = await atual.sendMessage(jid, { text: texto }, { messageId: id, ...(quoted ? { quoted } : {}) });
      const devolvido = r?.key?.id ?? undefined;
      // Para atender o pedido de reenvio de quem recebeu (getMessage): a mensagem exata que saiu, só na memória.
      respostasRecentes.set(id, { message: r?.message ?? { conversation: texto }, em: relogio.agora() });
      while (respostasRecentes.size > MAXIMO_DE_RESPOSTAS_EM_MEMORIA) respostasRecentes.delete(respostasRecentes.keys().next().value!);
      if (devolvido && devolvido !== id) await registrarEnviado(devolvido);
      if (devolvido !== id) {
        throw new Error("O WhatsApp não devolveu o id da mensagem. Ela pode ter saído: confira no celular antes de pedir de novo.");
      }
      const ts = relogio.agora();
      // A resposta vira mensagem minha na hora (o eco que chegar depois é ignorado pelo id).
      seguro("resposta não gravada", () => {
        banco.gravarMensagens(
          jid,
          [
            {
              id,
              ts,
              de_mim: true,
              tipo: "texto",
              texto,
              ...(citar ? { citada: { id: citar.id, ...(citar.texto ? { texto: citar.texto.slice(0, 200) } : {}) } } : {}),
              ...(opcoes?.rascunho ? { rascunho_da_ia: opcoes.rascunho } : {}),
            },
          ],
          { contarNaoLidas: true },
        );
      });
      return { id, ts };
    },
    async noWhatsApp(jid) {
      const atual = socket;
      if (!atual || estado.situacao !== "conectado") throw new Error("O WhatsApp não está conectado agora.");
      const r = await atual.onWhatsApp(jid);
      const achado = (r ?? []).find((x) => x.exists && typeof x.jid === "string" && numeroDe(x.jid));
      return achado ? normalizar(achado.jid) : undefined;
    },
    async reagir(jid, chave, emoji) {
      const atual = socket;
      if (!atual || estado.situacao !== "conectado") throw new Error("O WhatsApp não está conectado agora. Nada foi feito.");
      const key = { remoteJid: jid, id: chave.id, fromMe: chave.de_mim, ...(ehGrupo(jid) && !chave.de_mim && chave.participante ? { participant: chave.participante } : {}) };
      await atual.sendMessage(jid, { react: { text: emoji, key } });
    },
    async editar(jid, id, texto) {
      const atual = socket;
      if (!atual || estado.situacao !== "conectado") throw new Error("O WhatsApp não está conectado agora. Nada foi editado.");
      await atual.sendMessage(jid, { text: texto, edit: { remoteJid: jid, id, fromMe: true } });
      seguro("edição não gravada", () => {
        banco.editarMensagem(jid, id, texto, { de_mim: true });
      });
    },
    async apagar(jid, id) {
      const atual = socket;
      if (!atual || estado.situacao !== "conectado") throw new Error("O WhatsApp não está conectado agora. Nada foi apagado.");
      await atual.sendMessage(jid, { delete: { remoteJid: jid, id, fromMe: true } });
      seguro("exclusão não gravada", () => {
        banco.apagarMensagem(jid, id, { de_mim: true });
      });
    },
    async variacaoDoHistorico(jid, pedida) {
      const atual = socket;
      if (!atual || estado.situacao !== "conectado") throw new Error("O WhatsApp não está conectado agora (veja wa_estado).");
      const lid = await lidDaConversa(jid, atual);
      if (pedida !== "auto") {
        const motivo = motivoParaNaoUsar(pedida, jid, lid, atual);
        if (motivo) throw new Error(`A variação "${pedida}" não se aplica a esta conversa: ${motivo}. Use "auto" ou outra variação. Nada foi pedido.`);
        return pedida;
      }
      // 0.7.3: o ponto de partida é o `lid` quando ele se aplica (conversa individual com LID conhecido); sem LID, em
      // grupo ou em conversa conhecida só pelo LID, é o `padrao`. Depois, o rodízio e a que funcionou, como antes.
      let v = variacaoAuto.get(jid) ?? (motivoParaNaoUsar("lid", jid, lid, atual) ? "padrao" : "lid");
      for (let i = 0; i < VARIACOES_DO_HISTORICO.length; i++) {
        if (!motivoParaNaoUsar(v, jid, lid, atual)) return v;
        v = proximaVariacao(v);
      }
      return "padrao";
    },
    async atualizarContatos(esperaMs, aoComecar) {
      const atual = socket;
      if (!atual || estado.situacao !== "conectado") throw new Error("O WhatsApp não está conectado agora (veja wa_estado). Nada foi pedido.");
      // Baileys rc14: `resyncAppState(collections, isInitialSync)` (lib/Socket/chats.js:410, exposto em :1182).
      const ressincronizar = atual.resyncAppState;
      if (typeof ressincronizar !== "function") throw new Error("Esta conexão não permite pedir a agenda de novo ao celular. Nada foi pedido.");
      if (contandoContatos) throw new Error("Já há um pedido da agenda em andamento. Nada foi pedido de novo.");
      aoComecar?.();
      const contagem = { recebidos: 0, novos: 0, atualizados: 0 };
      contandoContatos = contagem;
      let terminou = false;
      let erro: string | undefined;
      let pedidoEnviado = false;
      const dormir = (ms: number) => new Promise<void>((pronto) => setTimeout(pronto, Math.max(0, ms)));
      // Relógio de verdade, como o pedido de histórico: é o tempo que o modelo fica esperando.
      const fim = Date.now() + esperaMs;
      try {
        // Desde o começo: sem a versão guardada, a Baileys pede o retrato inteiro da coleção (`return_snapshot`,
        // chats.js:436-461) e cada `contactAction` volta como `contacts.upsert` (Utils/sync-action-utils.js:7-37). Com a
        // versão guardada, viria só o que mudou depois dela, e o que nunca chegou continuaria sem chegar.
        try {
          const chaves = atual.authState?.keys ?? auth?.keys;
          await chaves?.set({ "app-state-sync-version": Object.fromEntries(COLECOES_DE_CONTATOS.map((n) => [n, null])) });
        } catch (e) {
          log(`[whatsapp-claude] agenda: não consegui zerar a versão da coleção (${e instanceof Error ? e.name : "erro"}); peço do jeito que está.`);
        }
        const andamento = ressincronizar([...COLECOES_DE_CONTATOS], false).then(
          () => {
            terminou = true;
          },
          (e: unknown) => {
            terminou = true;
            erro = e instanceof Error ? e.name : "erro";
          },
        );
        pedidoEnviado = true;
        let relogioReal: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([andamento, new Promise<void>((pronto) => (relogioReal = setTimeout(pronto, esperaMs)))]);
        clearTimeout(relogioReal);
        if (terminou) {
          // A Baileys solta os eventos guardados uns 100 ms depois de terminar (Utils/event-buffer.js:141-166): espera até
          // a contagem parar de mudar, dentro do tempo.
          const quieto = Math.min(400, Math.max(20, Math.floor(esperaMs / 10)));
          let visto = -1;
          // 0.15.2: e até a fila dos contatos esvaziar (eles vão em lotes, cedendo ao laço).
          while (Date.now() < fim && (visto !== contagem.recebidos || tratandoContatos !== undefined)) {
            visto = contagem.recebidos;
            await dormir(Math.min(quieto, fim - Date.now()));
          }
        }
      } finally {
        contandoContatos = undefined;
      }
      log(`[whatsapp-claude] agenda: pedido ${pedidoEnviado ? "enviado" : "não saiu"}, ${terminou ? "terminou" : "sem resposta no tempo"}${erro ? ` (erro ${erro})` : ""}, ${contagem.recebidos} contato(s) recebido(s).`);
      return {
        pedido_enviado: pedidoEnviado,
        terminou,
        tempo_esgotado: !terminou,
        ...(erro ? { erro } : {}),
        contatos_recebidos: contagem.recebidos,
        nomes_novos: contagem.novos,
        nomes_atualizados: contagem.atualizados,
        colecoes: [...COLECOES_DE_CONTATOS],
        espera_ms: esperaMs,
      };
    },
    async buscarHistorico(jid, quantidade, ancora, esperaMs, variacao = "padrao") {
      const atual = socket;
      if (!atual || estado.situacao !== "conectado") throw new Error("O WhatsApp não está conectado agora (veja wa_estado).");
      const anterior = pedidosDeHistorico.get(jid);
      if (anterior?.fase === "pendente") throw new Error("Já há um pedido de histórico desta conversa em andamento.");
      const lid = variacao === "lid" || variacao === "pn_com_conta" ? await lidDaConversa(jid, atual) : undefined;
      const motivo = motivoParaNaoUsar(variacao, jid, lid, atual);
      if (motivo) throw new Error(`A variação "${variacao}" não se aplica a esta conversa: ${motivo}. Nada foi pedido.`);
      // Pedido novo da mesma conversa substitui a observação do anterior; o que o anterior deixou anotado sai agora.
      if (anterior) encerrarObservacao(anterior);
      const atrasada = respostasAtrasadas.get(jid);
      respostasAtrasadas.delete(jid);
      const depoisDoTempo = observadoDepoisDoTempo.get(jid);
      observadoDepoisDoTempo.delete(jid);

      let acordar = () => {};
      const chegou = new Promise<void>((pronto) => {
        acordar = pronto;
      });
      const pedido: PedidoDeHistorico = {
        jid,
        variacao,
        inicio: relogio.agora(),
        fase: "pendente",
        chegou: false,
        recebidas: 0,
        novas: 0,
        cortadas: 0,
        diag: { variacao, pedido_enviado: false, ...observadoVazio(), espera_ms: esperaMs },
        depois: observadoVazio(),
        vistosSemId: [],
        acordar,
      };
      pedidosDeHistorico.set(jid, pedido);
      let relogioReal: ReturnType<typeof setTimeout> | undefined;
      try {
        try {
          const chave = {
            remoteJid: variacao === "lid" ? lid! : jid,
            id: ancora.id,
            fromMe: ancora.de_mim,
            ...(ehGrupo(jid) && !ancora.de_mim && ancora.participante ? { participant: ancora.participante } : {}),
          };
          const id =
            variacao === "pn_com_conta"
              ? // O `fetchMessageHistory` não aceita o `accountLid`: o mesmo pedido, montado à mão (messages-recv.js:40-55).
                await atual.sendPeerDataOperationMessage!({
                  historySyncOnDemandRequest: { chatJid: jid, oldestMsgFromMe: ancora.de_mim, oldestMsgId: ancora.id, oldestMsgTimestampMs: ancora.ts, onDemandMsgCount: quantidade, accountLid: lid! },
                  peerDataOperationRequestType: proto.Message.PeerDataOperationRequestType.HISTORY_SYNC_ON_DEMAND,
                })
              : await atual.fetchMessageHistory(quantidade, chave, variacao === "segundos" ? Math.floor(ancora.ts / 1000) : ancora.ts);
          pedido.diag.pedido_enviado = true;
          if (typeof id === "string" && id) {
            pedido.id = id;
            for (const v of pedido.vistosSemId.splice(0)) if (v.id === id) aplicarNoWs(pedido, v.tipo, v.detalhe);
          }
          pedido.vistosSemId = [];
        } catch (erro) {
          // Só o tipo do erro: a mensagem da Baileys pode trazer jid.
          log(`[whatsapp-claude] histórico sob demanda: o pedido não saiu (variação ${variacao}, ${erro instanceof Error ? erro.name : "erro"}).`);
        }
        if (pedido.diag.pedido_enviado) {
          // Relógio de verdade: é o tempo que o modelo fica esperando.
          await Promise.race([chegou, new Promise<void>((pronto) => (relogioReal = setTimeout(pronto, esperaMs)))]);
          await recebidas;
        }
        const d = pedido.diag;
        // Cópia: o diagnóstico devolvido não muda depois (o que chega depois do tempo vai para `depois`).
        const diagnostico: DiagnosticoDoHistorico = structuredClone(d);
        log(
          `[whatsapp-claude] histórico sob demanda: variação ${variacao}, enviado ${d.pedido_enviado ? "sim" : "não"}, ack ${d.ack_do_servidor ? "sim" : "não"}${d.erro_no_ack ? ` (erro ${d.erro_no_ack})` : ""}, ` +
            `recibo ${d.recibo_do_celular ?? "nenhum"}, ${d.eventos_de_historico.length} evento(s) de histórico (${d.eventos_de_historico.filter((e) => e.id_bate).length} com o id do pedido), ` +
            `${d.notificacoes_de_historico.length} notificação(ões), ${d.respostas_pdo.length} resposta(s) PDO, chegou ${pedido.chegou ? "sim" : "não"}.`,
        );
        return {
          chegou: pedido.chegou,
          recebidas: pedido.recebidas,
          novas: pedido.novas,
          cortadas: pedido.cortadas,
          diagnostico,
          ...(atrasada ? { resposta_atrasada_do_pedido_anterior: atrasada } : {}),
          ...(depoisDoTempo ? { pedido_anterior_depois_do_tempo: depoisDoTempo } : {}),
        };
      } finally {
        clearTimeout(relogioReal);
        variacaoAuto.set(jid, pedido.chegou ? variacao : proximaVariacao(variacao));
        if (pedido.chegou || !pedido.diag.pedido_enviado || fechado || parado) {
          if (pedidosDeHistorico.get(jid) === pedido) pedidosDeHistorico.delete(jid);
        } else {
          // Passou do tempo sem resposta: fica em observação, sem segurar a chamada nem o processo.
          pedido.fase = "observacao";
          const t = relogio.setTimeout(() => encerrarObservacao(pedido), OBSERVACAO_DO_HISTORICO_MS);
          t.unref?.();
          pedido.fimDaObservacao = t;
        }
      }
    },
    async baixarMidia(jid, mensagem) {
      const meta = mensagem.midia;
      const tipo = tipoDaBaileys(mensagem.tipo);
      if (!meta?.chave || !meta.caminho || !tipo) throw new ErroDeMidia("Essa mensagem não tem os dados para baixar a mídia.");
      const tentar = async (caminho: string, url?: string) => {
        const endereco = enderecoParaBaixar(caminho, url);
        if (!endereco) throw new ErroDeMidia("O endereço da mídia não passou nas travas (só servidores de mídia do WhatsApp).");
        const cifrado = await baixarCifrado(endereco, buscarMidia, MAXIMO_DE_MIDIA_BYTES);
        return decifrarMidia(cifrado, meta.chave!, tipo, { ...(meta.sha256 ? { sha256: meta.sha256 } : {}), ...(meta.sha256_cifrado ? { sha256_cifrado: meta.sha256_cifrado } : {}) });
      };
      try {
        return await tentar(meta.caminho, meta.url);
      } catch (erro) {
        if (!(erro instanceof ErroDeMidia) || (erro.status !== 404 && erro.status !== 410)) throw erro;
      }
      // Vencida no servidor: pede ao celular para reenviar, uma vez.
      const INDISPONIVEL = "Essa mídia não está mais disponível no servidor do WhatsApp, e o celular não a reenviou (pode ter sido apagada do celular, ou ele está desligado).";
      const atual = socket;
      if (!atual || estado.situacao !== "conectado") throw new ErroDeMidia(`${INDISPONIVEL} O WhatsApp não está conectado agora para pedir de novo ao celular.`);
      const campo = `${tipo}Message` as const;
      const participante = ehGrupo(jid) && !mensagem.de_mim ? mensagem.participante : undefined;
      const pedido = {
        key: { remoteJid: jid, id: mensagem.id, fromMe: mensagem.de_mim, ...(participante ? { participant: participante } : {}) },
        message: { [campo]: { mediaKey: Buffer.from(meta.chave, "base64"), directPath: meta.caminho, ...(meta.url ? { url: meta.url } : {}) } },
      } as WAMessage;
      let novoCaminho: string | undefined;
      let relogioReal: ReturnType<typeof setTimeout> | undefined;
      try {
        const r = await Promise.race([
          atual.updateMediaMessage(pedido),
          new Promise<never>((_, falhar) => (relogioReal = setTimeout(() => falhar(new Error("tempo")), ESPERA_DO_REENVIO_MS))),
        ]);
        const c = (r?.message as Record<string, { directPath?: string | null } | undefined> | undefined)?.[campo];
        novoCaminho = c?.directPath ?? undefined;
      } catch {
        throw new ErroDeMidia(INDISPONIVEL);
      } finally {
        clearTimeout(relogioReal);
      }
      if (!novoCaminho) throw new ErroDeMidia(INDISPONIVEL);
      try {
        return await tentar(novoCaminho);
      } catch (erro) {
        if (erro instanceof ErroDeMidia && (erro.status === 404 || erro.status === 410)) throw new ErroDeMidia(INDISPONIVEL);
        throw erro;
      }
    },
    async enviarArquivo(jid, arquivo) {
      const atual = socket;
      if (!atual || estado.situacao !== "conectado") throw new Error("O WhatsApp não está conectado agora. Nada foi enviado.");
      if (!ehIndividual(jid) && !ehGrupo(jid)) throw new Error("Só se envia para conversa individual ou grupo. Nada foi enviado.");
      if (ehGrupo(jid) && !banco.grupoPermitido(jid)) throw new Error("Esse grupo não está entre os escolhidos. Nada foi enviado.");
      // "Digitando…" (ou "gravando áudio…" na voz) e depois "pausado". NUNCA "available".
      await atual.sendPresenceUpdate(arquivo.tipo === "nota_de_voz" ? "recording" : "composing", jid);
      await dormir(esperaDigitando());
      await atual.sendPresenceUpdate("paused", jid);
      if (socket !== atual || estado.situacao !== "conectado") throw new Error("A conexão caiu antes do envio. Nada foi enviado.");
      const id = generateMessageIDV2(atual.user?.id);
      await registrarEnviado(id);
      const legenda = arquivo.legenda ? { caption: arquivo.legenda } : {};
      // Foto: a miniatura vem pronta (miniatura.ts); sem ela, vazia, para a Baileys não tentar a dela (que não funciona com
      // o jimp 1.x). No vídeo a Baileys rodaria o `ffmpeg` do computador por linha de comando: a miniatura vazia evita isso
      // (vídeo sem miniatura é aceito pelo WhatsApp).
      // 0.18.0: figurinha. Na Baileys rc14 (`prepareWAMessageMedia`, lib/Utils/messages.js:134-137) só imagem e vídeo
      // calculam miniatura e só áudio calcula duração e forma de onda: o sticker é só cifrado e enviado (nada de sharp,
      // jimp nem ffmpeg). Largura e altura vão fixas (512, já conferidas), e o isAnimated vem da leitura do contêiner.
      const conteudo =
        arquivo.tipo === "imagem"
          ? {
              image: arquivo.conteudo,
              mimetype: arquivo.mimetype,
              jpegThumbnail: arquivo.miniatura?.jpegThumbnail ?? "",
              ...(arquivo.miniatura ? { width: arquivo.miniatura.width, height: arquivo.miniatura.height } : {}),
              ...legenda,
            }
          : arquivo.tipo === "figurinha"
            ? { sticker: arquivo.conteudo, mimetype: "image/webp", isAnimated: arquivo.animada === true, width: FIGURINHA_LADO, height: FIGURINHA_LADO }
            : arquivo.tipo === "video"
              ? { video: arquivo.conteudo, mimetype: arquivo.mimetype, jpegThumbnail: "", ...legenda }
              : arquivo.tipo === "nota_de_voz"
                ? { audio: arquivo.conteudo, mimetype: "audio/ogg; codecs=opus", ptt: true }
                : arquivo.tipo === "audio"
                  ? { audio: arquivo.conteudo, mimetype: arquivo.mimetype }
                  : { document: arquivo.conteudo, mimetype: arquivo.mimetype, fileName: arquivo.nome, ...legenda };
      const r = await atual.sendMessage(jid, conteudo, { messageId: id });
      const devolvido = r?.key?.id ?? undefined;
      if (r?.message) {
        respostasRecentes.set(id, { message: r.message, em: relogio.agora() });
        while (respostasRecentes.size > MAXIMO_DE_RESPOSTAS_EM_MEMORIA) respostasRecentes.delete(respostasRecentes.keys().next().value!);
      }
      if (devolvido && devolvido !== id) await registrarEnviado(devolvido);
      if (devolvido !== id) throw new Error("O WhatsApp não devolveu o id da mensagem. Ela pode ter saído: confira no celular antes de pedir de novo.");
      const ts = relogio.agora();
      seguro("arquivo enviado não gravado", () => {
        banco.gravarMensagens(
          jid,
          [
            {
              id,
              ts,
              de_mim: true,
              tipo: arquivo.tipo,
              ...(arquivo.legenda ? { texto: arquivo.legenda } : {}),
              ...(arquivo.legenda && arquivo.rascunho ? { rascunho_da_ia: arquivo.rascunho } : {}),
              midia: { mimetype: arquivo.mimetype, tamanho: arquivo.conteudo.length, ...(arquivo.tipo === "documento" ? { nome: arquivo.nome } : {}), baixavel: false },
            },
          ],
          { contarNaoLidas: true },
        );
      });
      return { id, ts };
    },
    async desconectar() {
      const atual = socket;
      let confirmado = false;
      if (atual && estado.situacao === "conectado") {
        try {
          await atual.logout("Desconectado pelo dono");
          confirmado = true;
        } catch (erro) {
          avisar("o logout não foi confirmado", erro);
        }
      }
      parar("sessao_encerrada", "Desconectado a pedido do dono. A sessão e as mensagens guardadas foram apagadas.");
      await apagarTudo();
      return { logout_no_whatsapp: confirmado };
    },
    avisosDaBiblioteca: () => anelDeAvisos.lista(),
    async esperar() {
      await iniciando;
      await recebidas;
      while (tratandoContatos) await tratandoContatos;
      await gravacoes;
    },
    async fechar() {
      // Nod whatsapp.ts:708-722.
      if (fechado) return;
      fechado = true;
      parado = true;
      relogio.clearTimeout(reconexao);
      relogio.clearTimeout(expiracao);
      soltarOuvintesDoWs?.();
      soltarOuvintesDoWs = undefined;
      encerrarObservacoes();
      socket?.end(undefined);
      await iniciando;
      await gravacoes;
      await recebidas;
      // 0.7.4: o histórico somado da última rajada não fica sem registro.
      for (const chave of [...historicoNaCaixaPreta.keys()]) despejarHistorico(chave);
      await sessao.esperar();
      estado = { situacao: "fechado" };
    },
  };
}

/** Número mascarado do dono, para mostrar. */
export const donoMascarado = (e: EstadoDaConexao): string | undefined => (e.numero ? mascararNumero(e.numero) : undefined);
