import pg from "pg";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// Prisma runs on the WASM query compiler with the node-postgres driver adapter,
// so no native query engine is needed at runtime.
//
// The Postgres schema comes from the `schema` parameter of DATABASE_URL
// (e.g. ...?schema=wearduds), the same parameter `prisma migrate deploy` reads.
// That lets the app share a database with other tables without touching them.
export function parseDatabaseUrl(raw) {
  if (!raw) return { connectionString: raw, schema: "public" };
  const url = new URL(raw);
  const schema = url.searchParams.get("schema") || "public";
  url.searchParams.delete("schema");
  return { connectionString: url.toString(), schema };
}

function createClient() {
  const { connectionString, schema } = parseDatabaseUrl(process.env.DATABASE_URL);
  const pool = new pg.Pool({
    connectionString,
    max: Number(process.env.DATABASE_POOL_SIZE || 10),
  });
  if (schema !== "public") {
    // Raw SQL (the member row lock) uses unqualified table names.
    const setPath = `SET search_path TO "${schema.replace(/"/g, '""')}"`;
    pool.on("connect", (client) => {
      client.query(setPath).catch((err) => console.error("search_path failed", err.message));
    });
  }
  const adapter = new PrismaPg(pool, { schema });
  return new PrismaClient({ adapter });
}

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = createClient();
  }
}

const prisma = global.prismaGlobal ?? createClient();

export default prisma;
