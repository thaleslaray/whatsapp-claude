export const INTERVALO_PAREAMENTO_MS: number;
export const LIMITE_PAREAMENTO_MS: number;
export const MAX_FALHAS_SEGUIDAS_PAREAMENTO: number;
export const INSTRUCAO_DO_CELULAR: string;
import type { Matriz } from "./qr.js";
export interface EtapaLida {
  etapa: string;
  matriz: Matriz | null;
  segundos: number;
  conectadoComo: string;
  mensagem: string;
}
export function lerEtapa(r: unknown): EtapaLida | null;
export function etapaFinal(etapa: string): boolean;
export function segundosQueFaltam(segundosNaResposta: number, recebidoEm: number, agora: number): number;
export function rotuloDaContagem(segundos: number): string;
export function rotuloDaContagemSemServidor(segundos: number): string;
export function mensagemNovoQr(id: string): string;
export function mensagemJaEscaneei(id: string): string;
export function fraseDaEtapa(e: EtapaLida): string;
export interface OpcoesDoAcompanhamento {
  consultar: () => Promise<unknown>;
  mostrar: (e: EtapaLida) => void;
  esperar: (ms: number) => Promise<void>;
  agora: () => number;
  cancelado?: () => boolean;
}
export function acompanharPareamento(o: OpcoesDoAcompanhamento): Promise<EtapaLida | null>;
