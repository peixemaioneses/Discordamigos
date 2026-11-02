// Servidor: canais, histórico de chat, upload de arquivos e sinalização WebRTC.
// Áudio e vídeo NÃO passam por aqui: vão direto entre os navegadores.
const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");
const criarArmazenamento = require("./armazenamento");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });
const loja = criarArmazenamento();

const MAX_UPLOAD = loja.limiteMB * 1024 * 1024;
const MAX_POR_VOZ = 8; // pessoas por canal de voz (malha P2P)

const novoId = () => crypto.randomBytes(6).toString("hex");
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
// evita que um erro de banco derrube o servidor inteiro
const seguro = (fn) => async (...args) => {
  try { await fn(...args); } catch (e) { console.error("Erro:", e.message); }
};

// ---------- arquivos enviados ----------
const MIMES = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".avif": "image/avif",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".ogv": "video/ogg",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4",
  ".weba": "audio/webm", ".opus": "audio/ogg",
};
const IMG = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif"]);
const VID = new Set([".mp4", ".m4v", ".webm", ".mov", ".ogv"]);
const AUD = new Set([".mp3", ".wav", ".ogg", ".m4a", ".weba", ".opus"]);
const categoria = (ext) => (IMG.has(ext) ? "imagem" : VID.has(ext) ? "video" : AUD.has(ext) ? "audio" : "arquivo");
const NOME_ARQ = /^[a-f0-9]{24}(\.[a-z0-9]{1,8})?$/;

app.post("/upload", express.raw({ type: () => true, limit: MAX_UPLOAD }), seguro(async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ erro: "Arquivo vazio" });
  let nome = "arquivo";
  try { nome = decodeURIComponent(req.get("x-nome") || "arquivo"); } catch {}
  nome = nome.replace(/[\\/\0]/g, "_").slice(0, 120);
  let ext = path.extname(nome).toLowerCase().replace(/[^a-z0-9.]/g, "");
  if (!/^\.[a-z0-9]{1,8}$/.test(ext)) ext = "";
  const arq = crypto.randomBytes(12).toString("hex") + ext;
  try {
    await loja.salvarArquivo(arq, req.body);
    res.json({ url: "/arquivos/" + arq, nome, tamanho: req.body.length, tipo: categoria(ext) });
  } catch (e) {
    console.error("Upload falhou:", e.message);
    res.status(500).json({ erro: "Falha ao salvar" });
  }
}));

// Só imagens, vídeos e áudios abrem no navegador; o resto sempre baixa.
// Isso impede que um .html enviado por alguém rode código no seu site.
app.get("/arquivos/:arq", seguro(async (req, res) => {
  const arq = req.params.arq;
  if (!NOME_ARQ.test(arq)) return res.sendStatus(404);
  const buf = await loja.lerArquivo(arq);
  if (!buf) return res.sendStatus(404);

  const ext = path.extname(arq).toLowerCase();
  const tipo = MIMES[ext];
  res.set({
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self'; media-src 'self'",
    "Cache-Control": "public, max-age=31536000, immutable",
    "Accept-Ranges": "bytes",
    "Content-Type": tipo || "application/octet-stream",
  });
  if (!tipo) res.set("Content-Disposition", "attachment");

  // suporte a "Range", necessário para avançar/voltar em vídeos
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (m && (m[1] || m[2])) {
    let ini = m[1] === "" ? buf.length - Number(m[2]) : Number(m[1]);
    let fim = m[1] === "" || m[2] === "" ? buf.length - 1 : Math.min(Number(m[2]), buf.length - 1);
    if (ini < 0) ini = 0;
    if (ini > fim || ini >= buf.length) {
      return res.status(416).set("Content-Range", `bytes */${buf.length}`).end();
    }
    res.status(206).set({ "Content-Range": `bytes ${ini}-${fim}/${buf.length}`, "Content-Length": fim - ini + 1 });
    return res.end(buf.subarray(ini, fim + 1));
  }
  res.set("Content-Length", buf.length);
  res.end(buf);
}));

app.use(express.static(path.join(__dirname, "public")));

function validarAnexo(a) {
  if (!a || typeof a !== "object") return null;
  if (typeof a.url !== "string" || !a.url.startsWith("/arquivos/") || !NOME_ARQ.test(a.url.slice(10))) return null;
  const tipo = ["imagem", "video", "audio", "arquivo"].includes(a.tipo) ? a.tipo : "arquivo";
  return { url: a.url, nome: str(a.nome, 120) || "arquivo", tamanho: Number(a.tamanho) || 0, tipo };
}

// ---------- presença e socket ----------
const online = new Map(); // socket.id -> { id, uid, nome, servidor, voz, estado }
const salaServ = (s) => "s:" + s;
const salaVoz = (s, c) => "v:" + s + ":" + c;

function listaMembros(servidor) {
  return [...online.values()]
    .filter((u) => u.servidor === servidor)
    .map(({ id, uid, nome, voz, estado }) => ({ id, uid, nome, voz, estado }));
}
const avisarMembros = (servidor) => io.to(salaServ(servidor)).emit("membros", listaMembros(servidor));

function sairDaVoz(socket) {
  const u = online.get(socket.id);
  if (!u || !u.voz) return;
  const sala = salaVoz(u.servidor, u.voz);
  socket.leave(sala);
  io.to(sala).emit("voz-saiu", { id: socket.id });
  u.voz = null;
  u.estado.camera = false;
  u.estado.tela = false;
}

io.on("connection", (socket) => {
  const usuario = () => online.get(socket.id);

  socket.on("entrar", seguro(async (d) => {
    const servidor = str(d && d.servidor, 40);
    const nome = str(d && d.nome, 24) || "Anônimo";
    const segredo = str(d && d.segredo, 64);
    if (!servidor || segredo.length < 16) return;

    // o uid público é derivado de um segredo que só o dono do navegador conhece
    const uid = crypto.createHash("sha256").update(segredo).digest("hex").slice(0, 16);
    const canais = await loja.canais(servidor);

    online.set(socket.id, {
      id: socket.id, uid, nome, servidor, voz: null,
      estado: { mic: true, fone: false, camera: false, tela: false },
    });
    socket.join(salaServ(servidor));
    socket.emit("pronto", {
      eu: socket.id, uid, canais, membros: listaMembros(servidor),
      limiteMB: loja.limiteMB, armazenamento: loja.nome,
    });
    avisarMembros(servidor);
  }));

  // ----- chat -----
  socket.on("historico", seguro(async ({ canal } = {}) => {
    const u = usuario(); if (!u) return;
    if (!(await loja.canalExiste(u.servidor, canal))) return;
    socket.emit("historico", { canal, mensagens: await loja.historico(u.servidor, canal) });
  }));

  socket.on("msg", seguro(async ({ canal, texto, anexo } = {}) => {
    const u = usuario(); if (!u) return;
    if (!(await loja.canalExiste(u.servidor, canal))) return;
    texto = str(texto, 2000);
    const ax = validarAnexo(anexo);
    if (!texto && !ax) return;
    const msg = { id: novoId(), uid: u.uid, nome: u.nome, texto, hora: Date.now() };
    if (ax) msg.anexo = ax;
    await loja.adicionarMsg(u.servidor, canal, msg);
    io.to(salaServ(u.servidor)).emit("msg", { canal, msg });
  }));

  socket.on("editar", seguro(async ({ canal, id, texto } = {}) => {
    const u = usuario(); if (!u) return;
    texto = str(texto, 2000);
    if (!texto || typeof id !== "string") return;
    const msg = await loja.editarMsg(u.servidor, canal, id, u.uid, texto);
    if (msg) io.to(salaServ(u.servidor)).emit("msg-editada", { canal, msg });
  }));

  socket.on("apagar", seguro(async ({ canal, id } = {}) => {
    const u = usuario(); if (!u || typeof id !== "string") return;
    if (await loja.apagarMsg(u.servidor, canal, id, u.uid)) {
      io.to(salaServ(u.servidor)).emit("msg-apagada", { canal, id });
    }
  }));

  // ----- canais -----
  socket.on("criar-canal", seguro(async ({ nome, tipo } = {}) => {
    const u = usuario(); if (!u) return;
    nome = str(nome, 24);
    if (!nome || !["texto", "voz"].includes(tipo)) return;
    const canais = await loja.criarCanal(u.servidor, { id: novoId(), nome, tipo });
    if (canais) io.to(salaServ(u.servidor)).emit("canais", canais);
  }));

  // ----- voz -----
  socket.on("voz-entrar", seguro(async ({ canal } = {}) => {
    const u = usuario(); if (!u) return;
    const canais = await loja.canais(u.servidor);
    if (!canais.some((c) => c.id === canal && c.tipo === "voz")) return;

    sairDaVoz(socket);
    const outros = [...online.values()].filter(
      (x) => x.servidor === u.servidor && x.voz === canal && x.id !== socket.id
    );
    if (outros.length >= MAX_POR_VOZ - 1) {
      socket.emit("voz-cheia");
      avisarMembros(u.servidor);
      return;
    }
    u.voz = canal;
    const sala = salaVoz(u.servidor, canal);
    socket.join(sala);
    socket.emit("voz-participantes", outros.map((x) => x.id));
    socket.to(sala).emit("voz-entrou", { id: socket.id });
    avisarMembros(u.servidor);
  }));

  socket.on("voz-sair", () => {
    const u = usuario(); if (!u) return;
    sairDaVoz(socket);
    avisarMembros(u.servidor);
  });

  socket.on("estado", (e = {}) => {
    const u = usuario(); if (!u) return;
    u.estado = { mic: !!e.mic, fone: !!e.fone, camera: !!e.camera, tela: !!e.tela };
    avisarMembros(u.servidor);
  });

  // repassa ofertas, respostas, candidatos ICE e a descrição das mídias
  socket.on("sinal", ({ para, dados } = {}) => {
    const de = usuario();
    const alvo = online.get(para);
    if (!de || !alvo || !de.voz || de.voz !== alvo.voz || de.servidor !== alvo.servidor) return;
    io.to(para).emit("sinal", { de: socket.id, dados });
  });

  socket.on("disconnect", () => {
    const u = usuario();
    if (!u) return;
    sairDaVoz(socket);
    online.delete(socket.id);
    avisarMembros(u.servidor);
  });
});

const PORT = process.env.PORT || 3000;
loja.iniciar()
  .then(() => server.listen(PORT, () => console.log(`Rodando em http://localhost:${PORT} (armazenamento: ${loja.nome})`)))
  .catch((e) => { console.error("Falha ao iniciar o armazenamento:", e.message); process.exit(1); });
