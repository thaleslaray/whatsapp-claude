// 0.7.5: o aparelho declara que está pronto para histórico sob demanda (hipótese, src/registro-do-aparelho.ts).
// O embrulho de `proto.DeviceProps.encode` força `historySyncConfig.onDemandReady = true` sem mexer no resto, sem mutar
// o objeto recebido, uma vez só; `WA_SEM_ON_DEMAND_READY=1` desliga; o registro do pareamento da própria Baileys
// (`generateRegistrationNode`) sai com o campo. Rede bloqueada (test/setup.ts): nada aqui abre conexão.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { Browsers, DEFAULT_CONNECTION_CONFIG, generateRegistrationNode, initAuthCreds, proto } from "@whiskeysockets/baileys";
import { semOnDemandReady } from "../src/config.ts";
import { declararProntoParaHistoricoSobDemanda, declarouProntoParaHistorico, restaurarEncodeOriginal } from "../src/registro-do-aparelho.ts";

const encodeDaBaileys = proto.DeviceProps.encode;

/** Como a Baileys monta (validate-connection.js), com os campos que o teste confere. */
const propriedades = (): proto.IDeviceProps => ({
  os: "Mac OS",
  platformType: proto.DeviceProps.PlatformType.DESKTOP,
  requireFullSync: true,
  historySyncConfig: { storageQuotaMb: 10240, supportGroupHistory: false, onDemandReady: undefined },
  version: { primary: 10, secondary: 15, tertiary: 7 },
});

const idaEVolta = (p: proto.IDeviceProps): proto.DeviceProps => proto.DeviceProps.decode(proto.DeviceProps.encode(p).finish());

afterEach(() => {
  restaurarEncodeOriginal();
  assert.equal(proto.DeviceProps.encode, encodeDaBaileys, "o encode original volta depois de cada teste");
});

describe("0.7.5: registro do aparelho pronto para histórico sob demanda", () => {
  it("sem o embrulho, a Baileys não manda onDemandReady (o ponto de partida da hipótese)", () => {
    assert.equal(declarouProntoParaHistorico(), false);
    const d = idaEVolta(propriedades());
    assert.equal(d.historySyncConfig?.onDemandReady ?? null, null);
  });

  it("com o embrulho, onDemandReady sai true e os outros campos ficam", () => {
    assert.equal(declararProntoParaHistoricoSobDemanda(false), true);
    assert.equal(declarouProntoParaHistorico(), true);
    const d = idaEVolta(propriedades());
    assert.equal(d.historySyncConfig?.onDemandReady, true);
    assert.equal(d.historySyncConfig?.storageQuotaMb, 10240);
    assert.equal(d.historySyncConfig?.supportGroupHistory, false);
    assert.equal(d.historySyncConfig?.completeOnDemandReady ?? null, null, "completeOnDemandReady não é tocado");
    assert.equal(d.os, "Mac OS");
    assert.equal(d.platformType, proto.DeviceProps.PlatformType.DESKTOP);
    assert.equal(d.requireFullSync, true);
    assert.equal(d.version?.primary, 10);
  });

  it("sem historySyncConfig, cria só com onDemandReady", () => {
    declararProntoParaHistoricoSobDemanda(false);
    const d = idaEVolta({ os: "Mac OS" });
    assert.equal(d.historySyncConfig?.onDemandReady, true);
    assert.equal(d.historySyncConfig?.storageQuotaMb ?? null, null);
    assert.equal(d.os, "Mac OS");
  });

  it("não altera o objeto recebido", () => {
    declararProntoParaHistoricoSobDemanda(false);
    const p = propriedades();
    const config = p.historySyncConfig;
    const antes = structuredClone(p);
    proto.DeviceProps.encode(p).finish();
    assert.deepEqual(p, antes);
    assert.equal(p.historySyncConfig, config, "o mesmo objeto interno, sem troca");
    assert.equal(p.historySyncConfig?.onDemandReady, undefined);
    const sem = { os: "Mac OS" } as proto.IDeviceProps;
    proto.DeviceProps.encode(sem).finish();
    assert.equal("historySyncConfig" in sem, false);
  });

  it("chamar duas vezes não embrulha duas vezes", () => {
    declararProntoParaHistoricoSobDemanda(false);
    const primeiro = proto.DeviceProps.encode;
    assert.equal(declararProntoParaHistoricoSobDemanda(false), true);
    assert.equal(proto.DeviceProps.encode, primeiro);
    restaurarEncodeOriginal();
    assert.equal(proto.DeviceProps.encode, encodeDaBaileys, "uma restauração basta: havia uma camada só");
  });

  it("WA_SEM_ON_DEMAND_READY=1 desliga: o campo não é forçado", () => {
    assert.equal(semOnDemandReady({ WA_SEM_ON_DEMAND_READY: "1" }), true);
    assert.equal(semOnDemandReady({ WA_SEM_ON_DEMAND_READY: " 1 " }), true);
    assert.equal(semOnDemandReady({}), false);
    assert.equal(semOnDemandReady({ WA_SEM_ON_DEMAND_READY: "0" }), false);
    assert.equal(semOnDemandReady({ WA_SEM_ON_DEMAND_READY: "${user_config.WA_SEM_ON_DEMAND_READY}" }), false);
    assert.equal(declararProntoParaHistoricoSobDemanda(true), false);
    assert.equal(declarouProntoParaHistorico(), false);
    assert.equal(proto.DeviceProps.encode, encodeDaBaileys);
    assert.equal(idaEVolta(propriedades()).historySyncConfig?.onDemandReady ?? null, null);
  });

  it("generateRegistrationNode da Baileys (o registro do pareamento) sai com onDemandReady true", () => {
    declararProntoParaHistoricoSobDemanda(false);
    const creds = initAuthCreds();
    const config = { ...DEFAULT_CONNECTION_CONFIG, browser: Browsers.macOS("Desktop"), syncFullHistory: true };
    const payload = generateRegistrationNode(creds, config);
    const bytes = payload.devicePairingData?.deviceProps;
    assert.ok(bytes && bytes.length > 0);
    const d = proto.DeviceProps.decode(bytes);
    assert.equal(d.historySyncConfig?.onDemandReady, true);
    assert.equal(d.historySyncConfig?.storageQuotaMb, 10240);
    assert.equal(d.historySyncConfig?.supportGroupHistory, false);
    assert.equal(d.requireFullSync, true);
    assert.equal(d.os, "Mac OS");
  });

  it("generateRegistrationNode sem o embrulho não manda o campo", () => {
    const payload = generateRegistrationNode(initAuthCreds(), { ...DEFAULT_CONNECTION_CONFIG, browser: Browsers.macOS("Desktop") });
    const d = proto.DeviceProps.decode(payload.devicePairingData!.deviceProps!);
    assert.equal(d.historySyncConfig?.onDemandReady ?? null, null);
  });
});
