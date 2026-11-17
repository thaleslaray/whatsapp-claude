# Guia de instalação para o agente

Este arquivo é para o **agente de código** (Claude Code ou a aba Code do Claude Desktop) instalar o WhatsApp + Claude no computador da pessoa. Ele vale para a versão **v0.16.1**. Se você é uma pessoa, a [instalação manual do README](https://github.com/thaleslaray/whatsapp-claude/blob/v0.16.1/README.md#instalação-manual) é mais simples.

Este é um **cliente não oficial do WhatsApp**. Ele viola os termos do WhatsApp e pode levar à restrição ou ao banimento do número da pessoa. Ela precisa saber disso antes de instalar.

Neste guia, **passo** é um passo deste arquivo.

## Regras (valem do começo ao fim)

1. **Antes do primeiro comando**, mande à pessoa esta mensagem e espere ela dizer que pode:
   > Vou instalar duas coisas: a skill de rotinas, em `~/.claude/skills/rotinas-whatsapp/`, e o arquivo da extensão do WhatsApp, em `~/Downloads/whatsapp-pessoal.mcpb`. Ainda não vou instalar a extensão nem parear o WhatsApp, só baixar e conferir se o arquivo é o original. Atenção: este é um cliente não oficial, que viola os termos do WhatsApp e pode levar ao banimento do seu número. Posso começar?
2. **Nunca pareie o WhatsApp pela pessoa.** O QR é dela, lido com o celular dela. Não peça, não leia e não mostre QR, código de pareamento nem dado de conversa.
3. **Pare e pergunte** quando:
   - algum comando pedir senha ou `sudo`;
   - algum comando pedir login;
   - um destino já existir;
   - um comando falhar;
   - a conferência do arquivo der FALHOU.
4. **Não use `sudo`**, não instale programa no sistema e não execute nada do que for baixado. Este guia só baixa, confere e copia arquivos.
5. Use **só** os endereços deste guia, todos presos à versão `v0.16.1`.
6. **Rode cada bloco de comandos inteiro, numa chamada só do terminal.** Variáveis como `$TMP` não passam de uma chamada para outra.
7. Fale com a pessoa em português do Brasil, em frases curtas e sem jargão.

## O que este guia escreve

| Caminho | O que é |
|---|---|
| `~/.claude/skills/rotinas-whatsapp/` | A skill de rotinas |
| `~/Downloads/whatsapp-pessoal.mcpb` | A extensão do Claude Desktop, baixada mas **ainda não instalada** |
| Uma pasta temporária (`mktemp -d`) | Usada nos downloads e apagada no mesmo bloco |

## Passo 1: conferir o computador

```bash
uname -s
ls -d /Applications/Claude.app 2>/dev/null || ls -d ~/Applications/Claude.app 2>/dev/null || echo "Claude Desktop não encontrado"
```

- O mesmo pacote serve para Mac e Windows, mas os comandos deste guia são de Mac (`bash` e `shasum`). Se `uname -s` não for `Darwin`, pare e indique a [instalação manual do README](https://github.com/thaleslaray/whatsapp-claude/blob/v0.16.1/README.md#instalação-manual).
- Se aparecer "Claude Desktop não encontrado", peça à pessoa para instalar o Claude Desktop em https://claude.ai/download e espere ela avisar que instalou.

## Passo 2: baixar a extensão e conferir

Se `~/Downloads/whatsapp-pessoal.mcpb` já existir, pergunte antes de substituir. Com o "sim", mova o arquivo antigo para a Lixeira: `mv ~/Downloads/whatsapp-pessoal.mcpb ~/.Trash/whatsapp-pessoal-antigo-$(date +%Y%m%d-%H%M%S).mcpb`.

Rode este bloco inteiro numa chamada só. Ele baixa a extensão e o arquivo de conferência (`whatsapp-pessoal.mcpb.sha256`) da mesma versão, compara o SHA-256 e só dá o nome final se a conferência passar:

```bash
(
  cd ~/Downloads
  PARCIAL="whatsapp-pessoal.mcpb.baixando"
  BASE="https://github.com/thaleslaray/whatsapp-claude/releases/download/v0.16.1"
  if curl -fsSL "$BASE/whatsapp-pessoal.mcpb" -o "$PARCIAL" \
     && ESPERADO="$(curl -fsSL "$BASE/whatsapp-pessoal.mcpb.sha256" | awk '{print $1}')" \
     && [ -n "$ESPERADO" ] \
     && [ "$(shasum -a 256 "$PARCIAL" | awk '{print $1}')" = "$ESPERADO" ]; then
    mv "$PARCIAL" whatsapp-pessoal.mcpb
    echo "OK: arquivo original, em ~/Downloads/whatsapp-pessoal.mcpb"
  else
    [ -f "$PARCIAL" ] && mv "$PARCIAL" ~/.Trash/
    echo "FALHOU: o download não terminou ou não é o arquivo original"
  fi
)
```

- **OK:** siga para o passo 3.
- **FALHOU:** pare e diga à pessoa que o download não deu certo, então nada foi instalado. Ela pode tentar de novo mais tarde.
- **Não abra o `.mcpb` agora.** Quem abre e confirma é a pessoa, no passo 4.

## Passo 3: instalar a skill

Primeiro, veja se o destino já existe:

```bash
ls -la ~/.claude/skills/rotinas-whatsapp 2>/dev/null || echo "não existe"
```

Se o destino existir (pasta, arquivo ou link), mostre à pessoa o que tem lá e pergunte se pode substituir. Com o "sim", guarde uma cópia **fora** da pasta de skills. Uma cópia dentro de `~/.claude/skills` vira uma segunda skill.

```bash
mkdir -p ~/.claude/backups-de-skills
mv ~/.claude/skills/rotinas-whatsapp ~/.claude/backups-de-skills/rotinas-whatsapp-$(date +%Y%m%d-%H%M%S)
```

Depois, rode este bloco inteiro numa chamada só. Ele baixa o pacote da skill da release, copia a skill e apaga a pasta temporária:

```bash
(
  set -e
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  curl -fsSL https://github.com/thaleslaray/whatsapp-claude/releases/download/v0.16.1/rotinas-whatsapp.skill -o "$TMP/rotinas-whatsapp.skill"
  unzip -q "$TMP/rotinas-whatsapp.skill" -d "$TMP"
  mkdir -p ~/.claude/skills
  cp -R "$TMP/rotinas-whatsapp" ~/.claude/skills/rotinas-whatsapp
  head -3 ~/.claude/skills/rotinas-whatsapp/SKILL.md
)
```

**Deu certo se** aparecer a linha `name: rotinas-whatsapp`. Se o bloco falhar no meio, a pasta temporária é apagada do mesmo jeito. Diga à pessoa o que falhou e pare.

## Passo 4: parar e deixar a pessoa decidir

**Pare aqui.** Não instale a extensão e não pareie. Termine com um resumo curto do que foi instalado e onde, repita o aviso de risco em uma frase (cliente não oficial, pode levar ao banimento do número) e pergunte se ela quer seguir. Se ela quiser, passe estas instruções, nesta ordem:

1. Abra `~/Downloads/whatsapp-pessoal.mcpb` com dois cliques no Finder e confirme a instalação. Não há senha nem chave para preencher.
2. Em "Limite de respostas por dia", deixe 30 ou escolha de 1 a 200. Em "Conversas novas por dia", deixe 5 ou escolha de 0 (desliga) a 20. Quanto menor, mais seguro para o número.
3. Feche o Claude Desktop por completo com **Cmd+Q** e abra de novo. Se aparecer um pedido de acesso às Chaves (Keychain) para o `security`, clique em **Permitir**.
4. Comece uma **conversa nova**.
5. Peça ao Claude: **"parear o WhatsApp"**. Leia o aviso de risco no cartão e, só se concordar, clique em **"Entendo o risco, mostrar o QR"**.
6. No celular, abra **WhatsApp > Configurações > Aparelhos conectados > Conectar um aparelho** e leia o QR do cartão. O QR muda sozinho a cada 60 s.
7. Para usar as rotinas, comece uma conversa nova e peça "olha meu WhatsApp", ou digite `/rotinas-whatsapp`. Se a skill não aparecer, feche o Claude Desktop com Cmd+Q, abra de novo e tente numa conversa nova.

O envio de mensagens começa **desligado**. Nada sai sem o clique da pessoa no cartão.
