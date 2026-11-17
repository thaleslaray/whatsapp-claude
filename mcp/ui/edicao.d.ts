export type Unidade = "bytes" | "caracteres";
export function medir(texto: string, unidade: Unidade): number;
export function rotuloDoContador(texto: string, limite: number, unidade: Unidade): string;
export function podeEnviar(texto: string, limite: number, unidade: Unidade, vazioPode?: boolean): boolean;
export function codigoEditado(codigo: string, texto: string): string;
export function codigoDeConversa(codigo: string): string;
export function mensagemDeConfirmacao(id: string, codigo: string, texto: string | null): string;
export function confirmacaoPeloChat(id: string, codigo: string, texto: string | null): string;
export interface AlvoETerceiros {
  alvo?: string;
  conteudo_de_terceiros?: { nome?: string; ultimas_recebidas?: unknown; [campo: string]: unknown };
}
export function destinatario(sc: AlvoETerceiros): string;
export function ultimasParaMostrar(sc: AlvoETerceiros): Array<{ data: string; texto: string }>;
export function itensParaMostrar(sc: AlvoETerceiros): Array<{ id: string; nome: string }>;
export function dataCurta(iso: string): string;
export function separarDetalhes(linhas: unknown): { aVista: string[]; recolhidas: string[] };
export function destaqueParaMostrar(sc: { destaque?: unknown } | null | undefined): string;
export function mensagemAtualParaMostrar(sc: { mensagem_atual?: unknown } | null | undefined): { texto: string; data: string } | null;
export function rotuloDoTextoEditavel(tipo: string): string;
export function rotuloDaMensagemAtual(tipo: string): string;
export function arquivoParaMostrar(sc: unknown): { nome: string; tipo: string; tamanho: string; caminho: string; imagem?: string } | null;
export function serializarLote(enviar: boolean[], mensagens: string[][]): string;
export function lerLote(texto: string): { enviar: boolean[]; mensagens: string[][] };
export function contarMarcados(enviar: boolean[]): number;
export function rotuloDoBotaoDoLote(n: number): string;
export function itensDoLoteParaMostrar(sc: unknown): Array<{ alvo: string; destaque: string; nome: string; ultima: { data: string; texto: string } | null; citada: string }>;
export function resultadoDoLoteParaMostrar(resultado: unknown): Array<{ conversa: string; estado: string; texto: string }>;
