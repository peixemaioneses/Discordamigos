// Armazenamento em Postgres. Usado quando DATABASE_URL está definida.
// Funciona com Neon, Supabase, Render Postgres ou qualquer Postgres padrão.
// Mensagens, canais E os arquivos enviados ficam no banco: nada se perde quando o servidor reinicia.
const { Pool } = require("pg");

const PADRAO = [
  { id: "geral", nome: "geral", tipo: "texto" },
  { id: "arquivos", nome: "arquivos", tipo: "texto" },
  { id: "voz1", nome: "Sala 1", tipo: "voz" },
  { id: "voz2", nome: "Sala 2", tipo: "voz" },
];
const MAX_MSGS = 500;

function linha(r) {
  const m = { id: r.id, uid: r.uid, nome: r.nome, texto: r.texto, hora: Number(r.hora) };
  if (r.anexo) m.anexo = r.anexo;
  if (r.editado) m.editado = true;
  return m;
}

module.exports = function criar() {
  let url = process.env.DATABASE_URL;
  const local = /@(localhost|127\.0\.0\.1)|sslmode=disable/.test(url);
  const semVerificar = process.env.DATABASE_SSL === "no-verify";
  let ssl = false;
  if (!local) {
    ssl = semVerificar ? { rejectUnauthorized: false } : { rejectUnauthorized: true };
    // com "no-verify", o sslmode da URL sobrescreveria a opção acima
    if (semVerificar) url = url.replace(/([?&])sslmode=[^&]*&?/, "$1").replace(/[?&]$/, "");
  }

  const pool = new Pool({ connectionString: url, ssl: local ? undefined : ssl, max: 5, idleTimeoutMillis: 30000 });
  pool.on("error", (err) => console.error("Erro no banco:", err.message));
  const q = (sql, params) => pool.query(sql, params);

  async function limpeza() {
    // apaga arquivos enviados há mais de 1 dia que nenhuma mensagem usa mais
    try {
      await q(`delete from arquivos a
               where a.criado < now() - interval '1 day'
                 and not exists (select 1 from mensagens m where m.anexo->>'url' = '/arquivos/' || a.nome)`);
    } catch (e) { console.error("Limpeza falhou:", e.message); }
  }

  async function canais(servidor) {
    let r = await q("select id, nome, tipo from canais where servidor = $1 order by ordem", [servidor]);
    if (!r.rows.length) {
      for (const c of PADRAO) {
        await q("insert into canais (servidor, id, nome, tipo) values ($1, $2, $3, $4) on conflict do nothing",
          [servidor, c.id, c.nome, c.tipo]);
      }
      r = await q("select id, nome, tipo from canais where servidor = $1 order by ordem", [servidor]);
    }
    return r.rows;
  }

  return {
    nome: "postgres",
    // arquivos ficam no banco; o plano gratuito tem pouco espaço, então o limite padrão é menor
    limiteMB: Number(process.env.MAX_UPLOAD_MB) || 10,

    async iniciar() {
      await q(`create table if not exists canais (
        servidor text not null, id text not null, nome text not null, tipo text not null,
        ordem serial, primary key (servidor, id))`);
      await q(`create table if not exists mensagens (
        id text primary key, servidor text not null, canal text not null,
        uid text not null, nome text not null, texto text not null default '',
        anexo jsonb, hora bigint not null, editado boolean not null default false)`);
      await q("create index if not exists mensagens_canal_idx on mensagens (servidor, canal, hora)");
      await q(`create table if not exists arquivos (
        nome text primary key, dados bytea not null, criado timestamptz not null default now())`);
      limpeza();
      setInterval(limpeza, 6 * 60 * 60 * 1000).unref();
    },

    canais,

    async criarCanal(servidor, canal) {
      const n = (await q("select count(*)::int as n from canais where servidor = $1", [servidor])).rows[0].n;
      if (n >= 30) return null;
      await q("insert into canais (servidor, id, nome, tipo) values ($1, $2, $3, $4)",
        [servidor, canal.id, canal.nome, canal.tipo]);
      return canais(servidor);
    },

    async canalExiste(servidor, id) {
      await canais(servidor); // garante os canais padrão
      return (await q("select 1 from canais where servidor = $1 and id = $2", [servidor, id])).rowCount > 0;
    },

    async historico(servidor, canal) {
      const r = await q(
        `select id, uid, nome, texto, anexo, hora, editado from (
           select * from mensagens where servidor = $1 and canal = $2 order by hora desc limit 100
         ) t order by hora asc`, [servidor, canal]);
      return r.rows.map(linha);
    },

    async adicionarMsg(servidor, canal, m) {
      await q(`insert into mensagens (id, servidor, canal, uid, nome, texto, anexo, hora)
               values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [m.id, servidor, canal, m.uid, m.nome, m.texto, m.anexo ? JSON.stringify(m.anexo) : null, m.hora]);
      await q(`delete from mensagens where id in (
                 select id from mensagens where servidor = $1 and canal = $2
                 order by hora desc offset ${MAX_MSGS})`, [servidor, canal]);
    },

    async editarMsg(servidor, canal, id, uid, texto) {
      const r = await q(
        `update mensagens set texto = $1, editado = true
         where id = $2 and servidor = $3 and canal = $4 and uid = $5
         returning id, uid, nome, texto, anexo, hora, editado`, [texto, id, servidor, canal, uid]);
      return r.rows[0] ? linha(r.rows[0]) : null;
    },

    async apagarMsg(servidor, canal, id, uid) {
      const r = await q("delete from mensagens where id = $1 and servidor = $2 and canal = $3 and uid = $4",
        [id, servidor, canal, uid]);
      return r.rowCount > 0;
    },

    async salvarArquivo(nome, buffer) {
      await q("insert into arquivos (nome, dados) values ($1, $2)", [nome, buffer]);
    },

    async lerArquivo(nome) {
      const r = await q("select dados from arquivos where nome = $1", [nome]);
      return r.rows[0] ? r.rows[0].dados : null;
    },
  };
};
