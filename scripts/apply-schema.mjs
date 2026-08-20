#!/usr/bin/env node
/**
 * Applies supabase/schema.sql over a direct Postgres connection, for when the
 * dashboard SQL editor is unavailable.
 *
 * Reads DATABASE_URL from .env.local, which is gitignored -- the password
 * never enters the repo or a shell history.
 *
 *   npm run schema
 */
import { readFileSync } from 'node:fs'
import pg from 'pg'

function readEnv(file) {
  const out = {}
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line)
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    }
  } catch {
    // Missing file is reported below with a usable message.
  }
  return out
}

const env = readEnv(new URL('../.env.local', import.meta.url).pathname)
const url = process.env.DATABASE_URL || env.DATABASE_URL

if (!url) {
  console.error(
    'DATABASE_URL not found in .env.local.\n\n' +
      'Supabase dashboard > Project Settings > Database > Connection string >\n' +
      'URI. Copy it, substitute your database password for [YOUR-PASSWORD],\n' +
      'and add it to .env.local as:\n\n' +
      '  DATABASE_URL=postgresql://...\n',
  )
  process.exit(1)
}

const sql = readFileSync(new URL('../supabase/schema.sql', import.meta.url).pathname, 'utf8')

const client = new pg.Client({
  connectionString: url,
  // Supabase terminates TLS with its own chain; verifying it would need the
  // CA bundle shipped alongside. The connection is still encrypted.
  ssl: { rejectUnauthorized: false },
})

try {
  await client.connect()
  console.log('connected')
  await client.query(sql)
  console.log('schema applied')

  const { rows } = await client.query(`
    select c.relname as table,
           c.relrowsecurity as rls,
           (select count(*) from pg_policies p
             where p.schemaname = 'public' and p.tablename = c.relname) as policies
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in ('sessions', 'solves')
    order by c.relname
  `)
  for (const r of rows) {
    console.log(`  ${r.table}: rls=${r.rls} policies=${r.policies}`)
  }
} catch (e) {
  console.error('failed:', e.message)
  process.exitCode = 1
} finally {
  await client.end()
}
