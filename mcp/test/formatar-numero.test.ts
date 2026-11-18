// formatarNumero: o número sai INTEIRO e formatado (a regra mudou em 18/11/2026 a pedido do dono; antes saía mascarado).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatarNumero } from "../src/jid.ts";

describe("formatarNumero", () => {
  it("Brasil com 13 dígitos (celular com 9)", () => {
    assert.equal(formatarNumero("5511999991234"), "+55 11 99999-1234");
  });

  it("Brasil com 12 dígitos (8 depois do DDD)", () => {
    assert.equal(formatarNumero("551199991234"), "+55 11 9999-1234");
  });

  it("EUA/Canadá (1 + 10 dígitos)", () => {
    assert.equal(formatarNumero("14155551234"), "+1 415 555-1234");
  });

  it("outros países: + e todos os dígitos", () => {
    assert.equal(formatarNumero("447911123456"), "+447911123456");
  });

  it("sem número ou inválido: número oculto", () => {
    for (const d of [undefined, "", "123456", "1234567890123456", "55 11 99999-1234", "abc"]) assert.equal(formatarNumero(d), "número oculto", String(d));
  });
});
