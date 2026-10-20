# Pocket Bard

## Executar localmente

Requer Node.js 20.6 ou superior. Copie `.env.example` para `.env`, preencha as credenciais das APIs oficiais e execute:

```powershell
npm.cmd start
```

Abra `http://127.0.0.1:4173`. O servidor atende somente em `127.0.0.1`; não abra `index.html` diretamente pelo sistema de arquivos.
Os perfis e arquivos locais ficam isolados pela origem do navegador; se antes o app era aberto por `file://` ou outro endereço, essa origem mantém um armazenamento separado.

### Credenciais das plataformas

- `YOUTUBE_API_KEY`: chave de um projeto com YouTube Data API v3 habilitada.
- `SPOTIFY_CLIENT_ID` e `SPOTIFY_CLIENT_SECRET`: credenciais de um aplicativo Spotify Developer.
- `PORT`: opcional; padrão `4173`.

As credenciais ficam somente no servidor e em `.env`, que é ignorado pelo Git. Não as coloque em `app.js` nem publique o servidor sem adicionar autenticação e proteção apropriadas.

## Links externos

Na Biblioteca, use **Link externo** e cole um link por linha. Vídeos/músicas são indexados como referências individuais; playlists são expandidas pela API oficial em um registro por item. O app guarda URLs e metadados no armazenamento local do navegador. Ele não baixa nem armazena áudio ou vídeo e links externos não podem ser reproduzidos pelos decks locais.

Playlists são limitadas aos primeiros 500 itens por consulta. Links duplicados na biblioteca são ignorados. A indexação depende de permissões, disponibilidade pública do conteúdo e limites das APIs do YouTube e Spotify.

## Testes

```powershell
npm.cmd test
```
