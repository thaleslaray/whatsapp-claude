// 0.7.6: o aparelho se registra como navegador (hipótese, src/transporte.ts, `navegadorDoRegistro`).
// Por padrão a config do socket leva `Browsers.macOS("Chrome")`; `WA_APARELHO_DESKTOP=1` volta a `Browsers.macOS("Desktop")`;
// o registro do pareamento da própria Baileys (`generateRegistrationNode`) sai com `platformType` CHROME.
// Rede bloqueada (test/setup.ts): nada aqui abre conexão.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { DEFAULT_CONNECTION_CONFIG, generateRegistrationNode, initAuthCreds, proto } from "@whiskeysockets/baileys";
import { aparelhoDesktop } from "../src/config.ts";
import { navegadorDoRegistro } from "../src/transporte.ts";
import { montar, type Montagem } from "./ajuda.ts";

let m: Montagem | undefined;
const antes = process.env.WA_APARELHO_DESKTOP;
afterEach(async () => {
  await m?.fechar();
  m = undefined;
  if (antes === undefined) delete process.env.WA_APARELHO_DESKTOP;
  else process.env.WA_APARELHO_DESKTOP = antes;
});

describe("0.7.6: registro do aparelho como navegador", () => {
  it("WA_APARELHO_DESKTOP=1 liga o desktop; o resto não", () => {
    assert.equal(aparelhoDesktop({ WA_APARELHO_DESKTOP: "1" }), true);
    assert.equal(aparelhoDesktop({ WA_APARELHO_DESKTOP: " 1 " }), true);
    assert.equal(aparelhoDesktop({}), false);
    assert.equal(aparelhoDesktop({ WA_APARELHO_DESKTOP: "0" }), false);
    assert.equal(aparelhoDesktop({ WA_APARELHO_DESKTOP: "${user_config.WA_APARELHO_DESKTOP}" }), false);
  });

  it("por padrão a config passada ao criarSocket leva browser[1] === \"Chrome\"", async () => {
    delete process.env.WA_APARELHO_DESKTOP;
    m = await montar();
    await m.ctx.partida();
    const browser = m.socket().config.browser;
    assert.equal(browser?.[1], "Chrome");
    assert.deepEqual(browser, ["Mac OS", "Chrome", "14.4.1"]);
  });

  it("com WA_APARELHO_DESKTOP=1 a config volta a browser[1] === \"Desktop\"", async () => {
    process.env.WA_APARELHO_DESKTOP = "1";
    m = await montar();
    await m.ctx.partida();
    assert.equal(m.socket().config.browser?.[1], "Desktop");
  });

  it("generateRegistrationNode com o browser padrão novo sai com platformType CHROME", () => {
    const payload = generateRegistrationNode(initAuthCreds(), { ...DEFAULT_CONNECTION_CONFIG, browser: navegadorDoRegistro(false) });
    const d = proto.DeviceProps.decode(payload.devicePairingData!.deviceProps!);
    assert.equal(d.platformType, proto.DeviceProps.PlatformType.CHROME);
    assert.equal(d.os, "Mac OS");
  });

  it("com o desligamento, generateRegistrationNode volta a DESKTOP", () => {
    const payload = generateRegistrationNode(initAuthCreds(), {
      ...DEFAULT_CONNECTION_CONFIG,
      browser: navegadorDoRegistro(aparelhoDesktop({ WA_APARELHO_DESKTOP: "1" })),
    });
    const d = proto.DeviceProps.decode(payload.devicePairingData!.deviceProps!);
    assert.equal(d.platformType, proto.DeviceProps.PlatformType.DESKTOP);
  });
});
