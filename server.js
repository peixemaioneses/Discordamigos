// Servidor de sinalização: não transporta vídeo nem áudio.
// Só apresenta os participantes uns aos outros; a mídia vai direto entre os navegadores (WebRTC).
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const MAX_POR_SALA = 8; // malha P2P: acima disso o upload de quem transmite sofre

io.on("connection", (socket) => {
  socket.on("entrar", ({ sala, nome }) => {
    sala = String(sala || "geral").slice(0, 40);
    nome = String(nome || "Anônimo").slice(0, 24);

    const room = io.sockets.adapter.rooms.get(sala);
    if (room && room.size >= MAX_POR_SALA) {
      socket.emit("sala-cheia");
      return;
    }

    socket.data.sala = sala;
    socket.data.nome = nome;

    // lista de quem já está na sala
    const existentes = [];
    if (room) {
      for (const id of room) {
        const s = io.sockets.sockets.get(id);
        if (s) existentes.push({ id, nome: s.data.nome });
      }
    }

    socket.join(sala);
    socket.emit("participantes", existentes);
    socket.to(sala).emit("entrou", { id: socket.id, nome });
  });

  // repassa ofertas, respostas e candidatos ICE para o destinatário
  socket.on("sinal", ({ para, dados }) => {
    io.to(para).emit("sinal", { de: socket.id, dados });
  });

  socket.on("chat", (texto) => {
    const sala = socket.data.sala;
    if (!sala) return;
    io.to(sala).emit("chat", {
      nome: socket.data.nome,
      texto: String(texto).slice(0, 500),
    });
  });

  socket.on("disconnect", () => {
    const sala = socket.data.sala;
    if (sala) socket.to(sala).emit("saiu", { id: socket.id });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Rodando em http://localhost:${PORT}`));
