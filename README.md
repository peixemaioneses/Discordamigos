# Sala de voz

Salas com voz, chat de texto e transmissão de tela, feitas com Node.js, Socket.IO e WebRTC.

## Rodar no seu computador

```bash
npm install
npm start
```

Abra http://localhost:3000, escolha um nome e uma sala. Abra uma segunda aba para testar.

## Colocar para os amigos usarem

O navegador só libera microfone e compartilhamento de tela em **HTTPS** (ou localhost). Duas opções:

**Teste rápido, direto do seu PC**
```bash
npx cloudflared tunnel --url http://localhost:3000
```
Ele gera um link `https://...trycloudflare.com`. Mande esse link para seus amigos.

**Hospedagem fixa**
Suba a pasta no Render, Railway ou Fly.io (todos têm plano gratuito ou barato, e já entregam HTTPS). Comando de start: `npm start`.

## Como funciona

- `server.js` é só o servidor de sinalização: apresenta os participantes uns aos outros.
- O áudio e o vídeo vão **direto entre os navegadores** (WebRTC, modo malha).
- Limite de 8 pessoas por sala (`MAX_POR_SALA`). Em malha, quem transmite envia um vídeo para cada espectador, então o upload dele é o gargalo.

## Limitações conhecidas

- Algumas redes (4G, empresas, CGNAT) bloqueiam conexão direta. Para isso você precisa de um servidor **TURN** (ex.: coturn, ou serviços como Metered e Twilio). Adicione em `ICE` no `index.html`.
- Para salas grandes ou transmissões com muita gente assistindo, troque a malha por um **SFU** (LiveKit, mediasoup).
- Compartilhar áudio do sistema só funciona no Chrome/Edge no Windows, ou ao compartilhar uma aba.
- Não há contas nem senha: quem souber o nome da sala entra. Use nomes difíceis de adivinhar.

## Próximos passos sugeridos

1. Login (por exemplo, com Supabase ou Firebase Auth) e salas persistentes
2. Vários canais por servidor, como no Discord
3. Histórico de chat em banco de dados
4. Indicador visual de quem está falando
