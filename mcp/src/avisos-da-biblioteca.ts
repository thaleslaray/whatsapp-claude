// 0.7.4: o logger que a Baileys recebe. Por quê: até a 0.7.3 ele era mudo, e no WhatsApp real o pedido de histórico de
// uma conta grande falhou 10 de 10 sem rastro; a Baileys avisa no logger quando uma mensagem não decifra, quando a
// notificação de histórico chega e quando algo dá errado, e tudo isso se perdia.
//
// Continua NÃO escrevendo nada no stdout nem no stderr. Guarda na memória, num anel de 40 (com contagem de repetidos),
// só as chamadas `warn`, `error` e `fatal`, e a `info` "got history notification". De cada chamada fica SÓ o texto (o
// argumento string): os objetos que a Baileys passa junto carregam chaves de sessão, jids e mensagens, e são
// descartados inteiros. O texto passa por `limpar`, perde todo trecho com `@` e toda sequência de 6 ou mais dígitos e
// é cortado em 160.

import { limpar } from "./segredos.ts";

export type NivelDoAviso = "warn" | "error" | "fatal" | "info";

export interface AvisoDaBiblioteca {
  nivel: NivelDoAviso;
  texto: string;
  vezes: number;
}

export const TAMANHO_DO_ANEL = 40;
export const TAMANHO_DO_TEXTO = 160;
/** A única `info` que interessa: a notificação de histórico chegou (process-message.js, HISTORY_SYNC_NOTIFICATION). */
export const INFO_GUARDADA = "got history notification";

/** O texto que pode ficar: limpo, sem trechos com `@`, sem números de 6+ dígitos, no máximo 160 caracteres. */
export function textoDoAviso(bruto: string): string {
  const texto = limpar(bruto.split(/\r?\n/, 1)[0] ?? "")
    .replace(/\S*@\S*/g, "")
    .replace(/\d{6,}/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TAMANHO_DO_TEXTO);
  return texto || "sem texto";
}

/** Anel dos avisos, com contagem de repetidos (mesmo nível e texto somam em vez de ocupar outra posição). */
export class AnelDeAvisos {
  readonly #itens: AvisoDaBiblioteca[] = [];

  guardar(nivel: NivelDoAviso, texto: string): AvisoDaBiblioteca {
    const igual = this.#itens.find((a) => a.nivel === nivel && a.texto === texto);
    if (igual) {
      igual.vezes++;
      return igual;
    }
    const novo = { nivel, texto, vezes: 1 };
    this.#itens.push(novo);
    while (this.#itens.length > TAMANHO_DO_ANEL) this.#itens.shift();
    return novo;
  }

  lista(): AvisoDaBiblioteca[] {
    return this.#itens.map((a) => ({ ...a }));
  }
}

/** O texto de uma chamada no estilo do pino: `(obj, msg?)` ou `(msg)`. Os outros argumentos são descartados. */
function textoDaChamada(args: unknown[]): string | undefined {
  if (typeof args[0] === "string") return args[0];
  if (typeof args[1] === "string") return args[1];
  return undefined;
}

/** O que a Baileys usa do logger (Utils/logger.d.ts, mais o `fatal` do pino). */
export interface LoggerDaBiblioteca {
  level: string;
  child(obj?: Record<string, unknown>): LoggerDaBiblioteca;
  trace(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  fatal(...args: unknown[]): void;
}

/**
 * O logger. `aoAvisar` recebe cada chamada guardada (nível e texto já saneado; uma chamada = uma vez); erro dentro dele é
 * engolido.
 * `level` fica em "info": a Baileys só monta os textos caros (XML do nó) quando é "trace" ou "debug" (socket.js:75, 450, 466).
 * `child()` devolve o mesmo logger: tudo cai no mesmo anel.
 */
export function criarLoggerDaBiblioteca(aoAvisar: (aviso: { nivel: NivelDoAviso; texto: string }) => void = () => {}): { logger: LoggerDaBiblioteca; anel: AnelDeAvisos } {
  const anel = new AnelDeAvisos();
  const guardar = (nivel: NivelDoAviso, args: unknown[]) => {
    try {
      const bruto = textoDaChamada(args);
      if (nivel === "info" && bruto !== INFO_GUARDADA) return;
      const texto = textoDoAviso(bruto ?? "");
      anel.guardar(nivel, texto);
      aoAvisar({ nivel, texto });
    } catch {
      /* o logger nunca derruba a Baileys */
    }
  };
  const logger: LoggerDaBiblioteca = {
    level: "info",
    child: () => logger,
    trace() {},
    debug() {},
    info: (...args) => guardar("info", args),
    warn: (...args) => guardar("warn", args),
    error: (...args) => guardar("error", args),
    fatal: (...args) => guardar("fatal", args),
  };
  return { logger, anel };
}
