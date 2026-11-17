// Conferência inofensiva do WASM da Baileys (pacote `whatsapp-rust-bridge`), sem rede.
// A Baileys 7 reexporta `md5` e `hkdf` direto da ponte em Rust/WASM (lib/Utils/crypto.js:4). A ponte traz o WASM
// embutido no próprio JavaScript (base64, com e sem SIMD) e o instancia ao ser importada (dist/index.js:1948-1971),
// então o esbuild o leva para o build sem arquivo .wasm separado. Aqui o resultado da ponte é comparado com o do
// node:crypto: se o WASM não tivesse carregado, a importação ou a chamada falharia.

import { createHash, hkdfSync } from "node:crypto";
import { hkdf, md5 } from "@whiskeysockets/baileys";

export interface ConferenciaDoWasm {
  md5: boolean;
  hkdf: boolean;
}

export function conferirWasm(): ConferenciaDoWasm {
  const entrada = Buffer.from("whatsapp-claude autoteste");
  const sal = Buffer.from("sal-do-autoteste");
  const info = "info-do-autoteste";
  const doWasm = Buffer.from(hkdf(entrada, 32, { salt: sal, info }));
  const doNode = Buffer.from(hkdfSync("sha256", entrada, sal, Buffer.from(info), 32));
  return {
    md5: Buffer.from(md5(entrada)).equals(createHash("md5").update(entrada).digest()),
    hkdf: doWasm.equals(doNode),
  };
}
