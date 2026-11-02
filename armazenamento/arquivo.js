// Armazenamento local: histórico em dados/dados.json e arquivos em dados/uploads.
// Usado quando a variável DATABASE_URL não está definida.
const fs = require("fs");
const path = require("path");

const PADRAO = [
  { id: "geral", nome: "geral", tipo: "texto" },
  { id: "arquivos", nome: "arquivos", tipo: "texto" },
  { id: "voz1", nome: "Sala 1", tipo: "voz" },
  { id: "voz2", nome: "Sala 2", tipo: "voz" },
];
const MAX_MSGS = 500;

module.exports = function criar() {
  const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "dados");
  const UP_DIR = path.join(DATA_DIR, "uploads");
  const DB_FILE = path.join(DATA_DIR, "dados.json");
  fs.mkdirSync(UP_DIR, { recursive: true });

  const servidores = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    for (const [k, v] of Object.entries(raw.servidores || {})) servidores.set(k, v);
  } catch {}

  let timer = null;
  function salvar() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const tmp = DB_FILE + ".tmp";
      const dados = JSON.stringify({ servidores: Object.fromEntries(servidores) });
      fs.writeFile(tmp, dados, (err) => { if (!err) fs.rename(tmp, DB_FILE, () => {}); });
    }, 400);
  }

  function srv(nome) {
    if (!servidores.has(nome)) {
      servidores.set(nome, { canais: PADRAO.map((c) => ({ ...c })), mensagens: {} });
      salvar();
    }
    return servidores.get(nome);
  }

  return {
    nome: "arquivo",
    limiteMB: Number(process.env.MAX_UPLOAD_MB) || 25,
    async iniciar() {},

    async canais(servidor) { return srv(servidor).canais; },

    async criarCanal(servidor, canal) {
      const s = srv(servidor);
      if (s.canais.length >= 30) return null;
      s.canais.push(canal);
      salvar();
      return s.canais;
    },

    async canalExiste(servidor, id) { return srv(servidor).canais.some((c) => c.id === id); },

    async historico(servidor, canal) { return (srv(servidor).mensagens[canal] || []).slice(-100); },

    async adicionarMsg(servidor, canal, msg) {
      const lista = (srv(servidor).mensagens[canal] ||= []);
      lista.push(msg);
      if (lista.length > MAX_MSGS) lista.splice(0, lista.length - MAX_MSGS);
      salvar();
    },

    async editarMsg(servidor, canal, id, uid, texto) {
      const msg = (srv(servidor).mensagens[canal] || []).find((m) => m.id === id);
      if (!msg || msg.uid !== uid) return null;
      msg.texto = texto;
      msg.editado = true;
      salvar();
      return msg;
    },

    async apagarMsg(servidor, canal, id, uid) {
      const lista = srv(servidor).mensagens[canal] || [];
      const i = lista.findIndex((m) => m.id === id);
      if (i < 0 || lista[i].uid !== uid) return false;
      lista.splice(i, 1);
      salvar();
      return true;
    },

    async salvarArquivo(nome, buffer) { await fs.promises.writeFile(path.join(UP_DIR, nome), buffer); },

    async lerArquivo(nome) {
      try { return await fs.promises.readFile(path.join(UP_DIR, nome)); }
      catch { return null; }
    },
  };
};
