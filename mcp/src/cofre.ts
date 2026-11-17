// A chave AES-256 da instalação: aleatória (32 bytes), criada na primeira partida e guardada no cofre automático do
// sistema, sem nada para quem instala preencher. (Na 0.5.0 uma senha num campo da extensão foi tentada e descartada
// pelo dono.) Pesquisa: ~/pesquisas/pesquisa-cofre-windows-dpapi-node-2026-11-13.md.
//
// - Mac: Keychain (serviço `whatsapp-claude`, conta `chave-aes`), pelo `security`, com o truque do `security -i`: o
//   valor nunca vai no argv (o comando inteiro segue pela ENTRADA PADRÃO, fora da lista de processos). Como na 0.4.0.
// - Windows: DPAPI do usuário, pelo Windows PowerShell 5.1 (caminho absoluto, `-NoProfile -NonInteractive -Command -`)
//   SÓ com cmdlets (`ConvertTo-SecureString`/`ConvertFrom-SecureString`) e tipos permitidos no modo restrito
//   (ConstrainedLanguage), com o script pela entrada padrão. O bloco cifrado (hex) fica em `cofre-chave.dpapi` na pasta
//   de dados; criado sem sobrescrever (temporário + `link`), para dois processos acabarem com a mesma chave. Ele
//   sobrevive ao apagarTudo, como o `envios.enc` (senão a contagem do dia se perderia).
//   Falhas:
//   (a) o PowerShell não roda (não existe, estoura o tempo, bloqueado): nada é apagado; o contexto tenta de novo (M6);
//   (b) o bloco existe e o PowerShell roda, mas o Windows não abre (senha da conta redefinida, perfil recriado, pasta
//       copiada de outra máquina: "Key not valid for use in specified state"), ou o arquivo está estragado: o arquivo vai
//       para `cofre-chave.dpapi.antiga`, nasce uma chave nova, e o banco e a sessão antigos caem no caminho M5.
//   Para não confundir (a) com (b) quando o PowerShell roda mas não consegue abrir NADA (ex.: o modo restrito barrando
//   a leitura de `.Password`, que não está confirmada em fonte), toda chave nova é conferida (protege e abre de novo)
//   antes de ser guardada, e uma falha ao abrir só vira (b) se uma prova (proteger e abrir um valor qualquer) funciona.
// - Outros sistemas: erro de configuração (o manifest só lista Mac e Windows).
// `WA_TESTE_CHAVE` (64 hex) troca tudo por um cofre em memória, e só vale com `WA_DADOS_DIR` (ver config.ts).
//
// 0.16.0 (revisão de segurança), o limite do cofre, de propósito e documentado (README, "Onde fica a chave" e
// "Segurança"): a chave fica presa à CONTA do dono neste computador. Protege contra disco roubado ou copiado, backup
// levado para outro lugar e outro usuário do computador. NÃO protege contra programa malicioso rodando na conta do dono:
// no Mac o item é criado pelo /usr/bin/security, então qualquer processo do mesmo usuário o lê sem pedir senha (a ACL do
// item confia no `security`); no Windows, a DPAPI do usuário abre para qualquer processo da mesma conta. O mecanismo não
// muda aqui: fechar isso pediria um binário assinado com ACL própria no Keychain, fora do escopo de uma extensão em Node.

import { randomBytes } from "node:crypto";
import { closeSync, linkSync, openSync, renameSync, writeSync } from "node:fs";
import { win32 } from "node:path";
import { ErroConfig, lerCampo } from "./config.ts";
import { apagarArquivo, garantirPasta, gravarAtomico, lerOuNulo, unir } from "./pasta.ts";
import { registrar } from "./segredos.ts";
import { executarReal, type Executor } from "./sistema.ts";

export const SERVICO_KEYCHAIN = "whatsapp-claude";
export const CONTA_CHAVE = "chave-aes";
/** O bloco da chave protegido pela DPAPI (Windows), na pasta de dados. */
export const ARQUIVO_DPAPI = "cofre-chave.dpapi";

const NOME_SEGURO = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const HEX64 = /^[0-9a-fA-F]{64}$/;
const HEX = /^[0-9a-fA-F]+$/;

export function conferirNomeKeychain(nome: string): string {
  if (!NOME_SEGURO.test(nome)) throw new Error(`Nome inválido para o Keychain: ${nome}`);
  return nome;
}

export interface Cofre {
  /** A chave AES-256 (32 bytes) da instalação. Cria na primeira vez. */
  obterChave(): Promise<Buffer>;
}

function paraChave(hex: string): Buffer {
  if (!HEX64.test(hex)) throw new Error("A chave guardada não tem 64 caracteres hexadecimais.");
  const chave = Buffer.from(hex, "hex");
  registrar(hex);
  registrar(chave);
  return chave;
}

/** Cofre em memória: testes e autoteste. */
export class CofreEmMemoria implements Cofre {
  readonly #chave: Buffer;
  constructor(hex: string = randomBytes(32).toString("hex")) {
    this.#chave = paraChave(hex);
  }
  async obterChave(): Promise<Buffer> {
    return Buffer.from(this.#chave);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Mac: Keychain

export interface OpcoesKeychain {
  executar?: Executor;
  servico?: string;
}

/** `security` do macOS. Sem shell; o valor só existe em memória. */
export class CofreKeychain implements Cofre {
  readonly #executar: Executor;
  readonly #servico: string;
  constructor(opcoes: OpcoesKeychain = {}) {
    this.#executar = opcoes.executar ?? executarReal;
    this.#servico = conferirNomeKeychain(opcoes.servico ?? SERVICO_KEYCHAIN);
  }

  async #ler(): Promise<string | null> {
    const r = await this.#executar("security", ["find-generic-password", "-s", this.#servico, "-a", CONTA_CHAVE, "-w"]);
    if (r.codigo === 44) return null; // errSecItemNotFound: ainda não existe
    if (r.codigo !== 0) {
      throw new Error(`Não consegui ler o Keychain (security saiu com código ${r.codigo}). Confira se o Mac está desbloqueado.`);
    }
    const valor = r.stdout.replace(/\r?\n$/, "");
    return valor === "" ? null : valor;
  }

  async obterChave(): Promise<Buffer> {
    const existente = await this.#ler();
    if (existente !== null) return paraChave(existente);
    const novo = randomBytes(32).toString("hex");
    registrar(novo);
    // Sem -U: se outro processo criou a chave no meio-tempo, o security recusa (item duplicado) e lemos a dele.
    const g = await this.#executar("security", ["-i"], `add-generic-password -s ${this.#servico} -a ${CONTA_CHAVE} -w "${novo}"\n`);
    const depois = await this.#ler();
    if (depois === null) {
      // A mensagem do security pode ecoar o comando (e o valor): fica de fora.
      throw new Error(`O security não gravou a chave (código ${g.codigo}; a mensagem dele foi omitida para não arriscar mostrar o valor).`);
    }
    return paraChave(depois);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Windows: DPAPI pelo PowerShell

type Ambiente = Record<string, string | undefined>;

/** O Windows PowerShell 5.1 pelo caminho absoluto (nunca o `pwsh` nem o PATH). */
export function caminhoDoPowerShell(env: Ambiente): string {
  return win32.join(env.SystemRoot ?? env.windir ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

const ARGS_DO_POWERSHELL = ["-NoProfile", "-NonInteractive", "-Command", "-"] as const;
const PARE_NO_ERRO = "$ErrorActionPreference = 'Stop'";

/**
 * Script que protege a chave (64 hex) com a DPAPI e escreve o bloco em hex. Uma instrução por linha (com `-Command -`
 * o PowerShell executa uma por vez). Só hexadecimal entra no script: nada de aspa nem de quebra de linha.
 */
export function scriptDeProteger(hex: string): string {
  if (!HEX64.test(hex)) throw new Error("A chave a proteger tem de ser hexadecimal, com 64 caracteres.");
  return `${PARE_NO_ERRO}\nConvertFrom-SecureString -SecureString (ConvertTo-SecureString -String '${hex}' -AsPlainText -Force)\n`;
}

/** Script que abre um bloco da DPAPI (hex) e escreve o que estava protegido. Só hexadecimal entra no script. */
export function scriptDeAbrir(bloco: string): string {
  if (!HEX.test(bloco)) throw new Error("O bloco a abrir tem de ser hexadecimal.");
  return `${PARE_NO_ERRO}\n(New-Object System.Management.Automation.PSCredential 'x', (ConvertTo-SecureString -String '${bloco}')).GetNetworkCredential().Password\n`;
}

/** Caso (a): o PowerShell não roda ou não serve. Nada é apagado; o contexto tenta de novo. */
export class ErroDaProtecaoDoWindows extends Error {
  override name = "ErroDaProtecaoDoWindows";
}
const fraseDoWindows = (detalhe: string): string =>
  `Não consegui usar a proteção de dados do Windows (${detalhe}). Confira se o Windows PowerShell não está bloqueado por antivírus ou política.`;

export interface OpcoesDpapi {
  dirDados: string;
  executar?: Executor;
  env?: Ambiente;
}

type Leitura = { bloco: string } | null | "estragado";

/** DPAPI do usuário, pelo PowerShell só com cmdlets. Ver o cabeçalho para os casos de falha. */
export class CofreDpapi implements Cofre {
  readonly #dir: string;
  readonly #caminho: string;
  readonly #executar: Executor;
  readonly #powershell: string;

  constructor(opcoes: OpcoesDpapi) {
    this.#dir = opcoes.dirDados;
    this.#caminho = unir(opcoes.dirDados, ARQUIVO_DPAPI);
    this.#executar = opcoes.executar ?? executarReal;
    this.#powershell = caminhoDoPowerShell(opcoes.env ?? process.env);
  }

  /** Roda um script; o processo que não roda (não existe, tempo, bloqueio) vira o caso (a). */
  async #rodar(script: string): Promise<{ codigo: number; saida: string }> {
    let r;
    try {
      r = await this.#executar(this.#powershell, ARGS_DO_POWERSHELL, script);
    } catch (erro) {
      throw new ErroDaProtecaoDoWindows(fraseDoWindows(erro instanceof Error ? erro.message : String(erro)));
    }
    return { codigo: r.codigo, saida: r.stdout.replace(/[\r\n]+$/, "").trim() };
  }

  /** Protege; falha aqui é sempre o caso (a) (nada foi guardado ainda). */
  async #proteger(hex: string): Promise<string> {
    const r = await this.#rodar(scriptDeProteger(hex));
    if (r.codigo !== 0) throw new ErroDaProtecaoDoWindows(fraseDoWindows(`o PowerShell saiu com código ${r.codigo} ao proteger`));
    if (!HEX.test(r.saida)) throw new ErroDaProtecaoDoWindows(fraseDoWindows("o PowerShell não devolveu um bloco em hexadecimal"));
    return r.saida;
  }

  /** Abre; devolve a chave em hex ou null se o PowerShell rodou e não abriu (código diferente de 0 ou saída que não é a chave). */
  async #abrir(bloco: string): Promise<string | null> {
    const r = await this.#rodar(scriptDeAbrir(bloco));
    if (r.codigo !== 0 || !HEX64.test(r.saida)) return null;
    return r.saida;
  }

  #ler(): Leitura {
    const bruto = lerOuNulo(this.#caminho);
    if (bruto === null) return null;
    try {
      const c = JSON.parse(bruto) as { versao?: unknown; bloco?: unknown };
      if (c.versao === 1 && typeof c.bloco === "string" && HEX.test(c.bloco)) return { bloco: c.bloco };
    } catch {
      /* cai abaixo */
    }
    return "estragado";
  }

  /** Tira do lugar o arquivo que não serve (sem apagar), só se ainda é o mesmo que foi lido (outro processo pode ter trocado). */
  #guardarComoAntiga(conteudoLido: string | null): void {
    if (lerOuNulo(this.#caminho) !== conteudoLido) return;
    let destino = `${this.#caminho}.antiga`;
    if (lerOuNulo(destino) !== null) destino = `${destino}-${Date.now()}`;
    try {
      renameSync(this.#caminho, destino);
    } catch {
      /* outro processo já tirou do lugar */
    }
  }

  /** A DPAPI desta conta funciona (protege e abre um valor qualquer)? Decide entre (a) e (b). */
  async #provaFunciona(): Promise<boolean> {
    try {
      const prova = randomBytes(32).toString("hex");
      return (await this.#abrir(await this.#proteger(prova))) === prova;
    } catch {
      return false;
    }
  }

  /** Chave nova: protege, confere que abre e guarda sem sobrescrever. Se outro processo guardou antes, vale a dele. */
  async #criar(): Promise<Buffer> {
    const hex = randomBytes(32).toString("hex");
    registrar(hex);
    const bloco = await this.#proteger(hex);
    if ((await this.#abrir(bloco)) !== hex) {
      throw new ErroDaProtecaoDoWindows(fraseDoWindows("o PowerShell protege, mas não abre o que protegeu"));
    }
    garantirPasta(this.#dir);
    const conteudo = JSON.stringify({ versao: 1, bloco });
    const temporario = `${this.#caminho}.${randomBytes(4).toString("hex")}.tmp`;
    let venci = false;
    try {
      gravarAtomico(temporario, conteudo);
      try {
        linkSync(temporario, this.#caminho);
        venci = true;
      } catch (erro) {
        if ((erro as NodeJS.ErrnoException).code !== "EEXIST") venci = criarSemSobrescrever(this.#caminho, conteudo);
      }
    } finally {
      apagarArquivo(temporario);
    }
    if (venci) return paraChave(hex);
    return this.obterChave(); // outro processo criou no meio: vale a chave dele
  }

  async obterChave(): Promise<Buffer> {
    const lido = this.#ler();
    if (lido === null) return this.#criar();
    const conteudo = lerOuNulo(this.#caminho);
    if (lido === "estragado") {
      this.#guardarComoAntiga(conteudo);
      return this.#criar();
    }
    const hex = await this.#abrir(lido.bloco);
    if (hex !== null) return paraChave(hex);
    // O PowerShell rodou e não abriu: só é o caso (b) se a DPAPI desta conta funciona para um valor novo.
    if (!(await this.#provaFunciona())) throw new ErroDaProtecaoDoWindows(fraseDoWindows("o PowerShell roda, mas não consegue abrir nada"));
    this.#guardarComoAntiga(conteudo);
    return this.#criar();
  }
}

/** Cria com `wx` (não sobrescreve). true se criou; false se outro processo criou antes. */
function criarSemSobrescrever(caminho: string, conteudo: string): boolean {
  try {
    const fd = openSync(caminho, "wx", 0o600);
    try {
      writeSync(fd, conteudo);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (erro) {
    if ((erro as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw erro;
  }
}

// ---------------------------------------------------------------------------------------------------------------

/** O cofre deste sistema. `plataforma` e `executar` só os testes trocam. */
export function escolherCofre(dirDados: string, env: Ambiente = process.env, plataforma: NodeJS.Platform = process.platform, executar?: Executor): Cofre {
  const teste = lerCampo(env, "WA_TESTE_CHAVE");
  if (teste !== "") {
    if (lerCampo(env, "WA_DADOS_DIR") === "") {
      throw new ErroConfig("WA_TESTE_CHAVE só vale nos testes, junto com WA_DADOS_DIR. Tire essa variável da configuração.");
    }
    return new CofreEmMemoria(teste);
  }
  if (plataforma === "darwin") return new CofreKeychain(executar ? { executar } : {});
  if (plataforma === "win32") return new CofreDpapi({ dirDados, env, ...(executar ? { executar } : {}) });
  throw new ErroConfig(`Só Mac e Windows são suportados (este sistema é ${plataforma}): aqui não há cofre automático para guardar a chave.`);
}
