export const INTERVALO_ENVIANDO_MS: number;
export const LIMITE_ENVIANDO_MS: number;
export const MAX_FALHAS_SEGUIDAS_ENVIANDO: number;
export function estadoDoPedido(r: unknown): string | null;
export function fraseDeFeito(tipo: string | undefined, resultado: unknown): string;
export interface PlanoDaSituacao {
  acao: "nada" | "travar" | "feito" | "enviando" | "parear";
  mensagem: string;
  tipo: "" | "ok" | "erro";
}
export function planoDaSituacao(r: unknown, tipoDoCartao?: string): PlanoDaSituacao;
export interface OpcoesDeEspera {
  consultar: () => Promise<unknown>;
  esperar: (ms: number) => Promise<void>;
  agora: () => number;
  cancelado?: () => boolean;
}
export function aguardarEnvio(o: OpcoesDeEspera): Promise<unknown | null>;
