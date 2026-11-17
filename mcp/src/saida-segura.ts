// Saída segura do processo. Importado PRIMEIRO pelo stdio.ts, antes de qualquer módulo que carregue a Baileys.
//
// stdout é o canal JSON-RPC do MCP. A libsignal (dependência da Baileys) escreve direto no console, inclusive com
// objetos de sessão inteiros e chaves em Buffer (node_modules/libsignal/src/session_record.js:273,
// `console.info("Closing session:", session)`, e outros). Por isso, ao importar este módulo:
// - console.log/info/debug (e trace, dir, table...) viram no-op: nada vai para o stdout;
// - console.warn/error vão para o stderr só com a primeira linha de TEXTO (argumentos que não são texto, como
//   objetos, Buffers e erros com pilha, ficam de fora), limpa de segredos e números (`limpar`) e cortada em 300.
//
// `instalarTratadoresDeErro`: unhandledRejection e uncaughtException viram uma linha limpa no stderr, sem derrubar o
// processo (um erro solto num tratador de evento da Baileys não pode encerrar a conexão). Na partida, o erro encerra.
//
// 0.7.3: `observarErrosSoltos` é o gancho da caixa-preta (caixa-preta.ts). Este módulo carrega primeiro e não importa
// nada que carregue a Baileys; por isso é a caixa-preta que se pendura aqui, e não este módulo que a importa. O gancho
// recebe só o tipo, o NOME do erro, a frase já limpa (linhaSegura) e o código (ex.: EPIPE), nunca o erro inteiro.

import { limpar } from "./segredos.ts";

export const TAMANHO_MAXIMO_DA_LINHA = 300;

/** A primeira linha dos argumentos que são texto, limpa e cortada. Vazio se não há texto. */
export function linhaSegura(argumentos: readonly unknown[]): string {
  const texto = argumentos.filter((a): a is string => typeof a === "string").join(" ");
  const primeira = texto.split(/\r?\n/, 1)[0] ?? "";
  return limpar(primeira).trim().slice(0, TAMANHO_MAXIMO_DA_LINHA);
}

const escreverNoStderr = (linha: string): void => {
  process.stderr.write(`${linha}\n`);
};

function mudo(): void {}

export function instalarConsoleSeguro(saida: (linha: string) => void = escreverNoStderr): void {
  const c = console as unknown as Record<string, unknown>;
  for (const nome of ["log", "info", "debug", "trace", "dir", "dirxml", "table", "group", "groupCollapsed", "groupEnd", "count", "countReset", "time", "timeEnd", "timeLog", "assert"]) {
    c[nome] = mudo;
  }
  const paraOStderr = (...argumentos: unknown[]) => {
    const linha = linhaSegura(argumentos);
    if (linha !== "") saida(`[console] ${linha}`);
  };
  c.warn = paraOStderr;
  c.error = paraOStderr;
}

/** Só a primeira linha da mensagem do erro (nunca a pilha nem os campos), limpa e cortada. */
function fraseDoErro(erro: unknown): string {
  const mensagem = erro instanceof Error ? erro.message : typeof erro === "string" ? erro : "erro sem mensagem";
  return linhaSegura([mensagem]) || "erro sem mensagem";
}

/** Quem quer saber dos erros soltos (a caixa-preta). Só nomes e a frase limpa. */
export type ObservadorDeErro = (tipo: "excecao" | "promessa_rejeitada", nome: string, frase: string, codigo: string | undefined) => void;
let observador: ObservadorDeErro | undefined;

/** 0.7.3: pendura o observador dos erros soltos (um só; o último vale). */
export function observarErrosSoltos(f: ObservadorDeErro | undefined): void {
  observador = f;
}

/**
 * Erro solto depois da partida: uma linha no stderr e o processo segue. Antes de `iniciado()` ficar true, o erro é
 * da inicialização: escreve a linha e sai com código 1.
 */
export function instalarTratadoresDeErro(iniciado: () => boolean, saida: (linha: string) => void = escreverNoStderr): void {
  const tratar = (tipo: string, curto: "excecao" | "promessa_rejeitada") => (erro: unknown) => {
    const frase = fraseDoErro(erro);
    // A caixa-preta antes da linha no stderr: se o stderr estiver quebrado, o registro já ficou.
    try {
      const nome = erro instanceof Error ? erro.name : typeof erro;
      const codigo = (erro as { code?: unknown } | null)?.code;
      observador?.(curto, nome, frase, typeof codigo === "string" ? codigo : undefined);
    } catch {
      /* o observador nunca muda o que acontece aqui */
    }
    // 0.11.0: o stderr quebrado não pode lançar de dentro do tratador (o Node derrubaria o processo com código 7, como
    // erro dentro do tratador de erro); o registro da caixa-preta já ficou acima.
    try {
      saida(`[whatsapp-claude] ${tipo}: ${frase}`);
    } catch {
      /* segue */
    }
    if (!iniciado()) process.exit(1);
  };
  process.on("unhandledRejection", tratar("promessa rejeitada sem tratamento", "promessa_rejeitada"));
  process.on("uncaughtException", tratar("erro não tratado", "excecao"));
}

instalarConsoleSeguro();
