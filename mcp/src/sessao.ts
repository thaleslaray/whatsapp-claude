// Armazenamento cifrado das credenciais e chaves da Baileys: uma entrada por slot (`creds`, `session:...`,
// `sent-ids`...), no formato do channel-session.ts do Nod (slot -> texto, null apaga). Cada entrada é um arquivo
// em sessao/, cifrado com AES-256-GCM e AAD = o slot. O nome do arquivo é um HMAC do slot (pasta.ts).

import { BufferJSON } from "@whiskeysockets/baileys";
import { abrir, ErroDeLeitura, selar } from "./cripto.ts";
import { apagarArquivo, apagarPasta, garantirPasta, gravarAtomico, listar, lerOuNulo, nomeDoArquivo, unir } from "./pasta.ts";
import { registrar } from "./segredos.ts";

export interface DonoDaConta {
  /** Dígitos do número. */
  numero: string | undefined;
  nome: string | undefined;
}

export interface CredenciaisLidas {
  me?: { id?: string; lid?: string; name?: string };
  [campo: string]: unknown;
}

export class Sessao {
  readonly dir: string;
  readonly #chave: Buffer;
  /** Fila de gravações: uma de cada vez, na ordem. */
  #fila: Promise<unknown> = Promise.resolve();

  constructor(dirDados: string, chave: Buffer) {
    this.dir = unir(dirDados, "sessao");
    this.#chave = chave;
    garantirPasta(dirDados);
  }

  #arquivo(slot: string): string {
    return unir(this.dir, `${nomeDoArquivo(this.#chave, `sessao:${slot}`)}.enc`);
  }

  async get(slot: string): Promise<string | undefined> {
    const bruto = lerOuNulo(this.#arquivo(slot));
    return bruto === null ? undefined : abrir(this.#chave, `sessao:${slot}`, bruto.trim());
  }

  set(valores: Record<string, string | null>): Promise<void> {
    const trabalho = this.#fila.then(() => {
      garantirPasta(this.dir);
      for (const [slot, valor] of Object.entries(valores)) {
        if (valor === null) apagarArquivo(this.#arquivo(slot));
        else gravarAtomico(this.#arquivo(slot), selar(this.#chave, `sessao:${slot}`, valor));
      }
    });
    this.#fila = trabalho.catch(() => {});
    return trabalho;
  }

  /** Espera as gravações pendentes. */
  async esperar(): Promise<void> {
    await this.#fila;
  }

  /** Apaga a sessão inteira (credenciais, chaves e IDs enviados). */
  async limpar(): Promise<void> {
    const trabalho = this.#fila.then(() => apagarPasta(this.dir));
    this.#fila = trabalho.catch(() => {});
    await trabalho;
  }

  temArquivos(): boolean {
    return listar(this.dir).length > 0;
  }

  /** Registra as chaves privadas das credenciais para a limpeza de segredos nunca deixá-las sair. */
  registrarSegredosDasCredenciais(creds: unknown): void {
    const c = creds as {
      noiseKey?: { private?: Uint8Array };
      signedIdentityKey?: { private?: Uint8Array };
      signedPreKey?: { keyPair?: { private?: Uint8Array } };
      pairingEphemeralKeyPair?: { private?: Uint8Array };
      advSecretKey?: string;
    };
    registrar(c.noiseKey?.private);
    registrar(c.signedIdentityKey?.private);
    registrar(c.signedPreKey?.keyPair?.private);
    registrar(c.pairingEphemeralKeyPair?.private);
    registrar(c.advSecretKey);
  }

  async lerCredenciais(): Promise<CredenciaisLidas | undefined> {
    const bruto = await this.get("creds");
    if (bruto === undefined) return undefined;
    const creds = JSON.parse(bruto, BufferJSON.reviver) as CredenciaisLidas;
    this.registrarSegredosDasCredenciais(creds);
    return creds;
  }

  /**
   * Há sessão pareada? Sem isso o servidor nunca conecta.
   * Conserto: a versão anterior olhava `creds.registered`, que a Baileys 7 NUNCA põe em true no pareamento por QR
   * (só `initAuthCreds` o cria, com false: lib/Utils/auth-utils.js:295). O sinal certo é `creds.me.id`, gravado no
   * `pair-success` (lib/Utils/validate-connection.js, configureSuccessfulPairing).
   */
  async pareada(): Promise<boolean> {
    let c: CredenciaisLidas | undefined;
    try {
      c = await this.lerCredenciais();
    } catch (erro) {
      // Credenciais que a chave atual não abre (a chave do cofre se perdeu ou o arquivo foi alterado): a sessão não
      // serve mais para conectar. Conta como não pareada, para o wa_parear poder começar de novo (ele apaga a sessão
      // velha só depois do clique no cartão).
      if (erro instanceof ErroDeLeitura) return false;
      throw erro;
    }
    return typeof c?.me?.id === "string" && c.me.id.length > 0;
  }

  /**
   * 0.7.4: a plataforma que o celular informou no pareamento (`creds.platform`: iphone, android, smba, smbi...), só o
   * nome curto; "desconhecida" sem sessão, sem o campo ou com valor fora do formato.
   */
  async plataforma(): Promise<string> {
    let c: CredenciaisLidas | undefined;
    try {
      c = await this.lerCredenciais();
    } catch {
      return "desconhecida";
    }
    const p = c?.platform;
    return typeof p === "string" && /^[A-Za-z0-9_-]{1,20}$/.test(p) ? p.toLowerCase() : "desconhecida";
  }

  async dono(): Promise<DonoDaConta> {
    const c = await this.lerCredenciais();
    const id = c?.me?.id;
    const numero = id ? id.split("@")[0]!.split(":")[0]! : undefined;
    return { numero: numero && /^\d{7,15}$/.test(numero) ? numero : undefined, nome: c?.me?.name?.slice(0, 200) };
  }
}
