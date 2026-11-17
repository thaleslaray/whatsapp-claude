// O QR desenhado no próprio cartão, a partir da matriz que o servidor manda no `_meta` (sem DOM, para testar no Node).
// Como o Nod (QRCodeSVG do qrcode.react): nada de imagem em data URL; o cartão monta um <svg> com um <path> só.
// A matriz vem de fora do cartão: é validada antes (tamanho plausível de QR e só "0"/"1").

/** Menor e maior QR que existem: versão 1 (21 módulos) e versão 40 (177). Cada versão soma 4. */
export const TAMANHO_MINIMO = 21;
export const TAMANHO_MAXIMO = 177;
/** Margem clara em volta (a "zona quieta" que a câmera precisa), em módulos. */
export const MARGEM_PADRAO = 4;

/** A matriz `{ tamanho, linhas }` validada (cópia), ou null se não parece um QR. */
export function validarMatriz(m) {
  if (!m || typeof m !== "object") return null;
  const { tamanho, linhas } = m;
  if (!Number.isInteger(tamanho) || tamanho < TAMANHO_MINIMO || tamanho > TAMANHO_MAXIMO || (tamanho - TAMANHO_MINIMO) % 4 !== 0) return null;
  if (!Array.isArray(linhas) || linhas.length !== tamanho) return null;
  const formato = new RegExp("^[01]{" + tamanho + "}$");
  for (const linha of linhas) if (typeof linha !== "string" || !formato.test(linha)) return null;
  return { tamanho, linhas: linhas.slice() };
}

/**
 * O `d` do <path> com os módulos escuros, já com a margem, e o lado do quadrado (viewBox "0 0 lado lado").
 * Cada sequência de módulos escuros numa linha vira um retângulo: "M<x> <y>h<n>v1h-<n>z".
 */
export function caminhoDoQr(matriz, margem = MARGEM_PADRAO) {
  const m = validarMatriz(matriz);
  if (!m) throw new Error("Matriz de QR inválida.");
  const partes = [];
  m.linhas.forEach((linha, y) => {
    let x = 0;
    while (x < m.tamanho) {
      if (linha[x] !== "1") {
        x++;
        continue;
      }
      let fim = x;
      while (fim < m.tamanho && linha[fim] === "1") fim++;
      const n = fim - x;
      partes.push("M" + (x + margem) + " " + (y + margem) + "h" + n + "v1h-" + n + "z");
      x = fim;
    }
  });
  return { lado: m.tamanho + 2 * margem, d: partes.join("") };
}
