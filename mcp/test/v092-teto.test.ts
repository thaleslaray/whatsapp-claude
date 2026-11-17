// 0.9.2: o teto de mensagens guardadas por conversa subiu de 500 para 5.000 (decisão do dono). Os outros testes montam
// com `maxMensagens: 500` explícito (ajuda.ts) e continuam valendo; aqui, só o padrão e o texto que sai dele.
// A medição do custo (500 x 5.000) fica em test/medir-teto.ts, rodada à mão.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Banco } from "../src/banco.ts";
import { MAXIMO_DE_MENSAGENS_POR_CONVERSA } from "../src/config.ts";
import { INSTRUCOES } from "../src/servidor.ts";

describe("0.9.2: teto de 5.000 mensagens por conversa", () => {
  it("o padrão é 5.000 e as instruções do servidor dizem o número da constante", () => {
    assert.equal(MAXIMO_DE_MENSAGENS_POR_CONVERSA, 5000);
    assert.match(INSTRUCOES, /no máximo 5\.000 mensagens por conversa/);
    assert.ok(!/no máximo 500 mensagens/.test(INSTRUCOES));
    const dir = mkdtempSync(join(tmpdir(), "wa-teto-"));
    try {
      assert.equal(new Banco({ dir, chave: Buffer.alloc(32, 7) }).maxMensagens, 5000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
