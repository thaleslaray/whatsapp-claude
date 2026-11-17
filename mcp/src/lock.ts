// Lock de dono da conexão: `conexao.lock` na pasta de dados, com o PID e a HORA DE INÍCIO do processo.
// Dois sockets com as mesmas credenciais derrubam um ao outro (connectionReplaced), então só um processo conecta;
// os outros ficam em modo leitor. Lock de PID morto pode ser tomado. O arquivo é criado com `wx` (falha se já
// existe), então só um vence a corrida.
//
// Tomar um lock VELHO: o conteúdo novo é escrito num arquivo temporário e posto no lugar com `rename` (atômico; o
// lock nunca some no meio, como acontecia com apagar e recriar, quando um terceiro podia criar o dele no buraco).
// Depois, o token é conferido de novo, logo e após uma pausa curta: se dois tomaram ao mesmo tempo, o último rename
// vence e o outro, ao reconferir, vira leitor.
//
// A hora de início (decisão da Fase 2) resolve o PID reaproveitado: o dono morreu sem soltar o lock e o sistema deu
// o mesmo PID a outro processo. Sem ela, este processo ficaria leitor para sempre. Com ela, se o processo que tem
// aquele PID agora começou em outra hora, o lock é velho e pode ser tomado. Na dúvida (o comando falhou, ou o lock é
// da Fase 1, sem a hora), o processo vivo vale como dono: melhor ficar leitor que derrubar a conexão de outro.
// A hora de início de outro processo vem do `ps` no Mac e no Linux e do PowerShell no Windows (lá não há `ps`).
//
// 0.6.0: o lock também leva o endereço do canal do dono (campo `canal`, socket Unix ou named pipe com parte aleatória
// a cada partida). O leitor lê esse campo para repassar as chamadas ao dono. Lock sem `canal` (de uma versão antiga
// ainda rodando) = não há com quem falar: o leitor responde só a leitura, localmente.

import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { garantirPasta, protegerPermissao, renomearComTentativas, unir } from "./pasta.ts";
import { executarReal, type Executor } from "./sistema.ts";

export type ResultadoDoLock = { dono: true } | { dono: false; pid: number };

/** Pausa antes de reconferir o token depois de tomar um lock velho (outro processo pode ter tomado junto). */
export const PAUSA_DA_RECONFERENCIA_MS = 50;

/** Diferença máxima entre a hora gravada e a hora medida pelo `ps` (que tem resolução de 1 s) ou pelo PowerShell. */
export const TOLERANCIA_DO_INICIO_MS = 3_000;

export function processoVivo(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (erro) {
    return (erro as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Hora de início deste processo, em ms desde 1970. */
export const inicioDesteProcesso = (): number => Math.round(Date.now() - process.uptime() * 1000);

/** `[[dd-]hh:]mm:ss` (o `etime` do `ps`) em segundos. undefined se não reconhece. */
export function segundosDoEtime(texto: string): number | undefined {
  const m = /^(?:(\d+)-)?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/.exec(texto.trim());
  if (!m) return undefined;
  return Number(m[1] ?? 0) * 86_400 + Number(m[2] ?? 0) * 3_600 + Number(m[3]) * 60 + Number(m[4]);
}

/** Hora de início de outro processo (ms desde 1970). undefined se não deu para saber. */
export type InicioDe = (pid: number) => Promise<number | undefined>;

/** Mac e Linux: `ps -o etime=` (o tempo desde o início; o formato independe do idioma do sistema). */
export function inicioPeloPs(executar: Executor = executarReal): InicioDe {
  return async (pid) => {
    try {
      const r = await executar("ps", ["-o", "etime=", "-p", String(pid)], undefined, 5_000);
      if (r.codigo !== 0) return undefined;
      const s = segundosDoEtime(r.stdout);
      return s === undefined ? undefined : Date.now() - s * 1000;
    } catch {
      return undefined;
    }
  };
}

/**
 * Windows: PowerShell, sem perfil e sem interação, sem shell (execFile). A saída é um número puro (milissegundos desde
 * 1970, `ToUnixTimeMilliseconds`), que não depende do idioma nem do formato de data do Windows.
 */
export function inicioPeloPowerShell(executar: Executor = executarReal): InicioDe {
  return async (pid) => {
    if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
    try {
      const comando = `([DateTimeOffset](Get-Process -Id ${pid} -ErrorAction Stop).StartTime).ToUnixTimeMilliseconds()`;
      const r = await executar("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", comando], undefined, 10_000);
      if (r.codigo !== 0) return undefined;
      const texto = r.stdout.trim();
      return /^\d{10,16}$/.test(texto) ? Number(texto) : undefined;
    } catch {
      return undefined;
    }
  };
}

/** O jeito de cada sistema saber a hora de início de outro processo. */
export function inicioPeloSistema(plataforma: NodeJS.Platform = process.platform, executar: Executor = executarReal): InicioDe {
  return plataforma === "win32" ? inicioPeloPowerShell(executar) : inicioPeloPs(executar);
}

interface ConteudoDoLock {
  pid: number;
  token: string;
  /** Hora de início do processo dono (ms). Ausente em lock da Fase 1. */
  inicio?: number;
  /** Endereço do canal do dono (0.6.0). Ausente em lock de versão antiga. */
  canal?: string;
}

export interface OpcoesDoLock {
  pid?: number;
  /** Hora de início gravada no lock (padrão: a deste processo). */
  inicio?: number;
  /** Como saber a hora de início de outro PID (padrão: o do sistema, `ps` ou PowerShell). Os testes trocam. */
  inicioDe?: InicioDe;
  /** Endereço do canal deste processo, gravado no lock quando ele vira dono (0.6.0). */
  canal?: string;
}

export class LockDeConexao {
  readonly caminho: string;
  readonly #token = randomUUID();
  readonly #pid: number;
  readonly #inicio: number;
  readonly #inicioDe: InicioDe;
  readonly #canal: string | undefined;
  #meu = false;

  constructor(dirDados: string, opcoes: OpcoesDoLock | number = {}) {
    const o = typeof opcoes === "number" ? { pid: opcoes } : opcoes;
    garantirPasta(dirDados);
    this.caminho = unir(dirDados, "conexao.lock");
    this.#pid = o.pid ?? process.pid;
    this.#inicio = o.inicio ?? inicioDesteProcesso();
    this.#inicioDe = o.inicioDe ?? inicioPeloSistema();
    this.#canal = o.canal;
  }

  #conteudo(): string {
    return JSON.stringify({ pid: this.#pid, token: this.#token, inicio: this.#inicio, ...(this.#canal ? { canal: this.#canal } : {}) });
  }

  /** O endereço do canal gravado pelo dono atual (undefined se não há lock, se é nosso ou se é de versão antiga). */
  canalDoDono(): string | undefined {
    const atual = this.#ler();
    if (!atual || atual.token === this.#token) return undefined;
    return atual.canal;
  }

  get ehDono(): boolean {
    return this.#meu;
  }

  #ler(): ConteudoDoLock | null {
    try {
      const c = JSON.parse(readFileSync(this.caminho, "utf8")) as Partial<ConteudoDoLock>;
      if (typeof c.pid !== "number" || typeof c.token !== "string") return null;
      return {
        pid: c.pid,
        token: c.token,
        ...(typeof c.inicio === "number" ? { inicio: c.inicio } : {}),
        ...(typeof c.canal === "string" && c.canal.length > 0 && c.canal.length < 300 ? { canal: c.canal } : {}),
      };
    } catch {
      return null;
    }
  }

  #criar(): boolean {
    try {
      const fd = openSync(this.caminho, "wx", 0o600);
      try {
        writeSync(fd, this.#conteudo());
      } finally {
        closeSync(fd);
      }
      protegerPermissao(this.caminho, 0o600);
      return true;
    } catch (erro) {
      if ((erro as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw erro;
    }
  }

  /** O dono gravado ainda está de pé? PID vivo E (quando o lock tem a hora) começado na mesma hora. */
  async #donoVivo(atual: ConteudoDoLock): Promise<boolean> {
    if (!processoVivo(atual.pid)) return false;
    if (atual.inicio === undefined) return true; // lock da Fase 1: na dúvida, vivo
    const agora = await this.#inicioDe(atual.pid);
    if (agora === undefined) return true; // não deu para saber: na dúvida, vivo
    return Math.abs(agora - atual.inicio) <= TOLERANCIA_DO_INICIO_MS;
  }

  async tentar(): Promise<ResultadoDoLock> {
    if (this.#meu) return { dono: true };
    if (this.#criar()) return this.#assumir();
    const atual = this.#ler();
    // Lock ilegível (escrita pela metade), de PID morto ou de PID reaproveitado: velho, pode ser tomado.
    if (atual !== null && atual.token === this.#token) return this.#assumir();
    if (atual !== null && (await this.#donoVivo(atual))) return { dono: false, pid: atual.pid };
    const reler = this.#ler();
    if (reler?.token !== atual?.token || reler?.pid !== atual?.pid) {
      // Mudou no meio: outro processo tomou (ou soltou). Recomeça uma vez, sem tomar.
      if (this.#criar()) return this.#assumir();
      const quem = this.#ler();
      return { dono: false, pid: quem?.pid ?? 0 };
    }
    this.#tomar();
    if (this.#ler()?.token !== this.#token) return { dono: false, pid: this.#ler()?.pid ?? 0 };
    await new Promise((pronto) => setTimeout(pronto, PAUSA_DA_RECONFERENCIA_MS));
    return this.#assumir();
  }

  /** Põe o nosso conteúdo no lugar do lock velho: arquivo temporário + rename atômico. */
  #tomar(): void {
    const temporario = `${this.caminho}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      writeFileSync(temporario, this.#conteudo(), { mode: 0o600 });
      protegerPermissao(temporario, 0o600);
      renomearComTentativas(temporario, this.caminho);
    } finally {
      rmSync(temporario, { force: true });
    }
  }

  #assumir(): ResultadoDoLock {
    // Confere que o arquivo é mesmo o nosso (outro processo pode ter apagado e recriado no meio).
    if (this.#ler()?.token !== this.#token) return { dono: false, pid: this.#ler()?.pid ?? 0 };
    this.#meu = true;
    return { dono: true };
  }

  /** Solta o lock, só se for nosso. Síncrono: serve ao `process.on("exit")`. */
  liberar(): void {
    if (!this.#meu) return;
    this.#meu = false;
    if (this.#ler()?.token === this.#token) {
      try {
        unlinkSync(this.caminho);
      } catch {
        /* já sumiu */
      }
    }
  }
}
