export const TAMANHO_MINIMO: number;
export const TAMANHO_MAXIMO: number;
export const MARGEM_PADRAO: number;
export interface Matriz {
  tamanho: number;
  linhas: string[];
}
export function validarMatriz(m: unknown): Matriz | null;
export function caminhoDoQr(matriz: unknown, margem?: number): { lado: number; d: string };
