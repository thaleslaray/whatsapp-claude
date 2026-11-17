// Registro local de ações: uma linha JSON por evento em acoes.jsonl, na pasta de logs do sistema
// (Mac: ~/Library/Logs/whatsapp-claude; Windows: %LOCALAPPDATA%\whatsapp-claude\logs; ver config.ts).
// Tudo passa por `linhaDeRegistro` (limpeza de segredos e de números). NUNCA entra o texto das mensagens recebidas.
// Se o registro falhar, a operação já feita não falha: o aviso vai para o stderr.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { pastasDesteComputador } from "./config.ts";
import { log } from "./log.ts";
import { protegerPermissao } from "./pasta.ts";
import { linhaDeRegistro } from "./segredos.ts";

export const caminhoDoRegistroPadrao = (): string => join(pastasDesteComputador().logs, "acoes.jsonl");

export class RegistroAcoes {
  readonly caminho: string;
  readonly #avisar: (linha: string) => void;

  constructor(caminho: string = caminhoDoRegistroPadrao(), avisar: (linha: string) => void = log) {
    this.caminho = caminho;
    this.#avisar = avisar;
  }

  gravar(evento: Record<string, unknown>): void {
    try {
      mkdirSync(dirname(this.caminho), { recursive: true, mode: 0o700 });
      appendFileSync(this.caminho, `${linhaDeRegistro({ quando: new Date().toISOString(), ...evento })}\n`, { mode: 0o600 });
      protegerPermissao(this.caminho, 0o600);
    } catch (erro) {
      this.#avisar(`[whatsapp-claude] não consegui gravar o registro de ações: ${erro instanceof Error ? erro.message : String(erro)}`);
    }
  }
}
