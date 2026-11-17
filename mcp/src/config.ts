// Configuração do servidor, lida das variáveis de ambiente.
// Nenhum segredo mora aqui: a chave da instalação vem do Cofre (cofre.ts), o cofre automático do sistema.

import { homedir } from "node:os";
import { posix, win32 } from "node:path";

const NOME = "whatsapp-claude";

export interface Pastas {
  dados: string;
  logs: string;
}

/**
 * As pastas de dados e de logs de cada sistema. Função pura (plataforma, env e casa entram de fora) para testar o
 * Windows sem estar nele.
 * - Mac: ~/Library/Application Support/whatsapp-claude e ~/Library/Logs/whatsapp-claude (como sempre foi);
 * - Windows: %LOCALAPPDATA%\whatsapp-claude e a subpasta logs dela (sem a variável: <casa>\AppData\Local);
 * - outros (Linux): ~/.local/share/whatsapp-claude e ~/.local/state/whatsapp-claude.
 */
export function pastasPadrao(plataforma: NodeJS.Platform, env: Ambiente, casa: string): Pastas {
  if (plataforma === "win32") {
    const local = lerCampo(env, "LOCALAPPDATA");
    const base = local !== "" && win32.isAbsolute(local) ? local : win32.join(casa, "AppData", "Local");
    const dados = win32.join(base, NOME);
    return { dados, logs: win32.join(dados, "logs") };
  }
  if (plataforma === "darwin") {
    return { dados: posix.join(casa, "Library", "Application Support", NOME), logs: posix.join(casa, "Library", "Logs", NOME) };
  }
  return { dados: posix.join(casa, ".local", "share", NOME), logs: posix.join(casa, ".local", "state", NOME) };
}

/** As pastas deste computador. */
export const pastasDesteComputador = (env: Ambiente = process.env): Pastas => pastasPadrao(process.platform, env, homedir());
export const MAXIMO_DE_MENSAGENS_POR_CONVERSA = 5_000;
/** Envios por dia (wa_responder), quando `WA_LIMITE_DIARIO` (campo da extensão) não diz outro. */
export const LIMITE_DIARIO_PADRAO = 30;
/** Teto do limite diário: mais que isso é jeito de robô e chama atenção do WhatsApp. */
export const LIMITE_DIARIO_MAXIMO = 200;
/** Conversas novas por dia (wa_iniciar_conversa), quando `WA_LIMITE_NOVAS_CONVERSAS` não diz outro. */
export const LIMITE_NOVAS_CONVERSAS_PADRAO = 5;
export const LIMITE_NOVAS_CONVERSAS_MAXIMO = 20;
/** Pedidos de histórico antigo ao celular por dia (wa_buscar_historico), quando `WA_PEDIDOS_DE_HISTORICO_POR_DIA` não diz outro. */
export const PEDIDOS_DE_HISTORICO_POR_DIA = 30;
/**
 * 0.13.0: teto do campo: pedidos demais em pouco tempo podem chamar a atenção do WhatsApp.
 * 0.16.1: teto subiu de 200 para 500 a pedido do dono (16/11/2026), para encher vários grupos no mesmo dia.
 */
export const PEDIDOS_DE_HISTORICO_MAXIMO = 500;
/** Intervalo mínimo entre dois pedidos de histórico da mesma conversa. */
export const INTERVALO_DO_HISTORICO_MS = 30_000;
/** Mídias abertas (wa_abrir_midia) por dia: uma injeção não enche o disco (0.7.0, parte 2). */
export const ABERTURAS_POR_DIA = 100;
/** 0.15.0: pedidos da agenda ao celular (wa_atualizar_contatos e, desde a 0.15.1, os automáticos) por dia, e o intervalo mínimo entre dois. */
export const ATUALIZACOES_DE_CONTATOS_POR_DIA = 6;
export const INTERVALO_DOS_CONTATOS_MS = 10 * 60_000;
/** 0.15.1: a agenda se atualiza sozinha na abertura da conexão se a última bem-sucedida tem mais que isso. */
export const AGENDA_AUTOMATICA_A_CADA_MS = 7 * 24 * 60 * 60_000;
/** 0.15.1: depois do pareamento, a agenda sai quando o histórico inicial termina ou este tempo depois de a conexão abrir. */
export const ESPERA_DA_AGENDA_DEPOIS_DO_PAREAMENTO_MS = 60_000;

export interface Config {
  /** Pasta dos dados (0700). Só os testes trocam, e só junto com a chave de teste. */
  dirDados: string;
  /** Pasta do registro de ações. */
  dirLogs: string;
  maxMensagens: number;
  /** Quantas respostas o wa_responder pode enviar por dia (dia do relógio deste computador). */
  limiteDiario: number;
  /** Quantas conversas com número novo o wa_iniciar_conversa pode começar por dia (0 desliga). */
  limiteNovasConversas: number;
  /** 0.13.0: quantos pedidos de histórico ao celular por dia (wa_buscar_historico, inclusive os do `ate_total`). */
  pedidosDeHistoricoPorDia: number;
  /** Avisos de configuração (ex.: limite diário inválido), mostrados no wa_estado. */
  avisos: string[];
  /** Autoteste: socket inerte no lugar da Baileys (`WA_TESTE_SOCKET=falso`, só com a trava de teste). */
  socketDeTeste: boolean;
  /** 0.7.0, parte 3: idioma da transcrição (`WA_IDIOMA_TRANSCRICAO`: pt, en, es ou auto; padrão pt). */
  idiomaTranscricao: string;
}

export class ErroConfig extends Error {
  override name = "ErroConfig";
}

type Ambiente = Record<string, string | undefined>;

/** Valor de uma variável já sem espaços. Campo opcional do `.mcpb` em branco pode chegar como `${user_config.X}`: conta como vazio. */
export function lerCampo(env: Ambiente, nome: string): string {
  const valor = env[nome]?.trim() ?? "";
  return valor.startsWith("${") ? "" : valor;
}

/**
 * `WA_DADOS_DIR` (e `WA_LOGS_DIR`) existem só para os testes e o autoteste: valem SÓ junto com `WA_TESTE_CHAVE`
 * (cofre em memória). Assim uma pasta de teste nunca é aberta com a chave de verdade, nem a pasta de verdade com chave de teste.
 * `WA_TESTE_SOCKET=falso` (socket inerte do autoteste, sem rede) vale SÓ com essa mesma trava completa
 * (`WA_TESTE_CHAVE` E `WA_DADOS_DIR`), como o `IG_GRAPH_BASE` do Instagram; fora dela o servidor não sobe.
 */
export function lerConfig(env: Ambiente = process.env): Config {
  const dados = lerCampo(env, "WA_DADOS_DIR");
  const logs = lerCampo(env, "WA_LOGS_DIR");
  const chaveDeTeste = lerCampo(env, "WA_TESTE_CHAVE");
  if ((dados !== "" || logs !== "") && chaveDeTeste === "") {
    throw new ErroConfig(
      "WA_DADOS_DIR e WA_LOGS_DIR só valem nos testes, junto com WA_TESTE_CHAVE. Tire essas variáveis da configuração: os dados de verdade ficam na pasta do sistema (no Mac, ~/Library/Application Support/whatsapp-claude; no Windows, %LOCALAPPDATA%\\whatsapp-claude).",
    );
  }
  const socket = lerCampo(env, "WA_TESTE_SOCKET");
  if (socket !== "" && (socket !== "falso" || chaveDeTeste === "" || dados === "")) {
    throw new ErroConfig("WA_TESTE_SOCKET só vale no autoteste (WA_TESTE_SOCKET=falso, junto com WA_TESTE_CHAVE e WA_DADOS_DIR). Tire essa variável da configuração.");
  }
  const avisos: string[] = [];
  const padrao = pastasDesteComputador(env);
  return {
    dirDados: dados || padrao.dados,
    dirLogs: logs || padrao.logs,
    maxMensagens: MAXIMO_DE_MENSAGENS_POR_CONVERSA,
    limiteDiario: lerLimiteDiario(lerCampo(env, "WA_LIMITE_DIARIO"), avisos),
    limiteNovasConversas: lerLimiteNovasConversas(lerCampo(env, "WA_LIMITE_NOVAS_CONVERSAS"), avisos),
    pedidosDeHistoricoPorDia: lerPedidosDeHistorico(lerCampo(env, "WA_PEDIDOS_DE_HISTORICO_POR_DIA"), avisos),
    idiomaTranscricao: lerIdiomaTranscricao(lerCampo(env, "WA_IDIOMA_TRANSCRICAO"), avisos),
    avisos,
    socketDeTeste: socket === "falso",
  };
}

/**
 * `WA_LIMITE_DIARIO` (campo numérico "Limite de respostas por dia" da extensão, de 1 a 200, padrão 30): inteiro de 1 a 200.
 * Vazio vale o padrão (30). O campo numérico pode chegar como "30.0": inteiro com ",0"/".0" vale.
 * Valor inválido NÃO derruba o servidor: vale o padrão e o wa_estado avisa. Acima do teto vale o teto.
 */
export function lerLimiteDiario(valor: string, avisos: string[] = []): number {
  if (valor === "") return LIMITE_DIARIO_PADRAO;
  valor = valor.replace(/[.,]0+$/, "");
  if (!/^\d{1,6}$/.test(valor) || Number(valor) < 1) {
    avisos.push(`O limite de envios por dia ("${valor.slice(0, 20)}") não é um número inteiro a partir de 1; vale o padrão, ${LIMITE_DIARIO_PADRAO}.`);
    return LIMITE_DIARIO_PADRAO;
  }
  const n = Number(valor);
  if (n > LIMITE_DIARIO_MAXIMO) {
    avisos.push(`O limite de envios por dia passa do teto; vale ${LIMITE_DIARIO_MAXIMO}.`);
    return LIMITE_DIARIO_MAXIMO;
  }
  return n;
}

/** A instalação é a extensão do Claude Desktop (`.mcpb`)? O manifest define `WA_INSTALACAO=extensao`. */
export function ehExtensao(env: Ambiente = process.env): boolean {
  return lerCampo(env, "WA_INSTALACAO").toLowerCase() === "extensao";
}

/**
 * 0.7.5: `WA_SEM_ON_DEMAND_READY=1` desliga a declaração de "pronto para histórico sob demanda" no registro do
 * aparelho (registro-do-aparelho.ts). Variável de ambiente só, sem campo na extensão.
 */
export function semOnDemandReady(env: Ambiente = process.env): boolean {
  return lerCampo(env, "WA_SEM_ON_DEMAND_READY") === "1";
}

/**
 * 0.7.6: `WA_APARELHO_DESKTOP=1` volta a registrar o aparelho como desktop (`Browsers.macOS("Desktop")`), como até a
 * 0.7.5. O padrão agora é navegador (transporte.ts, `navegadorDoRegistro`). Variável de ambiente só, sem campo na extensão.
 */
export function aparelhoDesktop(env: Ambiente = process.env): boolean {
  return lerCampo(env, "WA_APARELHO_DESKTOP") === "1";
}

/**
 * 0.10.1: `WA_LEITURA_LOCAL=1` faz a cópia leitora responder as leituras ela mesma, com o código dela, em vez de
 * repassar ao dono da conexão. Só para teste (scripts/chamar.mjs): roda um servidor recém-construído contra os dados
 * reais sem reinstalar a extensão. Variável de ambiente só, sem campo na extensão.
 */
export function leituraLocal(env: Ambiente = process.env): boolean {
  return lerCampo(env, "WA_LEITURA_LOCAL") === "1";
}

/** Era do protocolo MCP por stdio: padrão a de 2025 (igual ao Instagram); `WA_PROTOCOLO=moderno` serve as duas. */
export function protocoloModerno(env: Ambiente = process.env): boolean {
  return lerCampo(env, "WA_PROTOCOLO").toLowerCase() === "moderno";
}

/**
 * `WA_LIMITE_NOVAS_CONVERSAS` (campo numérico "Conversas novas por dia", de 0 a 20, padrão 5): quantas conversas com
 * número novo o wa_iniciar_conversa pode começar por dia. 0 desliga a ferramenta. Começar conversa com desconhecido é o
 * comportamento que mais leva a banimento: por isso o teto é baixo. Inválido vale o padrão (com aviso); acima, o teto.
 */
export function lerLimiteNovasConversas(valor: string, avisos: string[] = []): number {
  if (valor === "") return LIMITE_NOVAS_CONVERSAS_PADRAO;
  valor = valor.replace(/[.,]0+$/, "");
  if (!/^\d{1,6}$/.test(valor)) {
    avisos.push(`O limite de conversas novas por dia ("${valor.slice(0, 20)}") não é um número inteiro de 0 a ${LIMITE_NOVAS_CONVERSAS_MAXIMO}; vale o padrão, ${LIMITE_NOVAS_CONVERSAS_PADRAO}.`);
    return LIMITE_NOVAS_CONVERSAS_PADRAO;
  }
  const n = Number(valor);
  if (n > LIMITE_NOVAS_CONVERSAS_MAXIMO) {
    avisos.push(`O limite de conversas novas por dia passa do teto; vale ${LIMITE_NOVAS_CONVERSAS_MAXIMO}.`);
    return LIMITE_NOVAS_CONVERSAS_MAXIMO;
  }
  return n;
}

/**
 * 0.13.0: `WA_PEDIDOS_DE_HISTORICO_POR_DIA` (campo numérico "Pedidos de histórico por dia", de 1 a 200, padrão 30):
 * quantos pedidos de mensagens antigas o wa_buscar_historico faz ao celular por dia. O dono pode subir de propósito
 * para encher um grupo de histórico (`ate_total`); pedidos demais em pouco tempo podem chamar a atenção do WhatsApp.
 * Como os outros limites: vazio vale o padrão; inválido vale o padrão, com aviso; acima do teto, o teto.
 */
export function lerPedidosDeHistorico(valor: string, avisos: string[] = []): number {
  if (valor === "") return PEDIDOS_DE_HISTORICO_POR_DIA;
  valor = valor.replace(/[.,]0+$/, "");
  if (!/^\d{1,6}$/.test(valor) || Number(valor) < 1) {
    avisos.push(`O limite de pedidos de histórico por dia ("${valor.slice(0, 20)}") não é um número inteiro a partir de 1; vale o padrão, ${PEDIDOS_DE_HISTORICO_POR_DIA}.`);
    return PEDIDOS_DE_HISTORICO_POR_DIA;
  }
  const n = Number(valor);
  if (n > PEDIDOS_DE_HISTORICO_MAXIMO) {
    avisos.push(`O limite de pedidos de histórico por dia passa do teto; vale ${PEDIDOS_DE_HISTORICO_MAXIMO}.`);
    return PEDIDOS_DE_HISTORICO_MAXIMO;
  }
  return n;
}

/** Idiomas do campo "Idioma da transcrição" da extensão. `auto` deixa o motor descobrir. */
export const IDIOMAS_DA_TRANSCRICAO = ["pt", "en", "es", "auto"] as const;

/**
 * `WA_IDIOMA_TRANSCRICAO` (0.7.0, parte 3): o idioma em que o áudio é transcrito. Vazio vale `pt`. Fora da lista não
 * derruba o servidor: vale `pt` e o wa_estado avisa.
 */
export function lerIdiomaTranscricao(valor: string, avisos: string[] = []): string {
  const v = valor.toLowerCase();
  if (v === "") return "pt";
  if ((IDIOMAS_DA_TRANSCRICAO as readonly string[]).includes(v)) return v;
  avisos.push(`O idioma da transcrição ("${valor.slice(0, 20)}") não é pt, en, es nem auto; vale pt.`);
  return "pt";
}
