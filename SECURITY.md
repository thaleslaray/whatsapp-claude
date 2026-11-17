# Segurança

## Como avisar de uma falha

**Não abra issue pública.** Use o botão **Report a vulnerability**, na aba [Security](https://github.com/thaleslaray/whatsapp-claude/security) deste repositório. A mensagem chega só para o mantenedor.

Diga o que acontece, como reproduzir e qual versão você usa. A versão aparece na tela de extensões do Claude Desktop.

**Nunca mande conversa, print de conversa, QR de pareamento, chave ou dado de outra pessoa.** Se você acha que a sessão do WhatsApp vazou, peça "desconectar o WhatsApp" e, no celular, remova o aparelho em **WhatsApp > Configurações > Aparelhos conectados**.

## O que conta como falha

- O Claude enviar, editar, apagar, começar conversa ou ligar o envio sem o clique no cartão.
- O Claude ler grupo que você não escolheu, ou conversa da lista "nunca ler".
- Ampliar o que o Claude lê (escolher grupo, tirar alguém da lista "nunca ler") sem o seu clique.
- Mensagem, conversa, QR, chave ou sessão aparecerem em log, arquivo sem cifra fora de `Downloads/WhatsApp Claude`, endereço ou mensagem de erro.
- Texto de terceiro (mensagem, nome, nome de grupo, nome de arquivo, texto dentro de foto) conseguir dar ordem ao Claude.
- Enviar arquivo de fora das pastas permitidas, ou arquivo de segredo (chave, `.env`, credencial, dado de navegador).
- Outro programa ou outra sessão conseguir usar o canal local entre as cópias da extensão sem conhecer a chave.

## O que não conta

- O banimento ou a restrição do número. A extensão é um cliente não oficial, que viola os termos do WhatsApp, e isso está no [aviso de risco](README.md#aviso-de-risco).
- Programa malicioso rodando na sua própria conta ler a chave do cofre do sistema. É um limite conhecido, descrito em [Onde fica a chave](README.md#onde-fica-a-chave).
- Arquivos que você pediu para abrir ficarem sem cifra em `Downloads/WhatsApp Claude`.

## Versões cobertas

Só a [versão mais recente](https://github.com/thaleslaray/whatsapp-claude/releases/latest).
