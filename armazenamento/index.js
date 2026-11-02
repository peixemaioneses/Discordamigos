// Com DATABASE_URL definida usa Postgres; sem ela, usa arquivos locais.
module.exports = function criarArmazenamento() {
  return process.env.DATABASE_URL ? require("./postgres")() : require("./arquivo")();
};
