#!/usr/bin/env bash
# Bring the acceptance stack up, idempotently: PostgreSQL, real PostgREST, and
# the one origin that looks like a Supabase project. Safe to run repeatedly —
# a run that cannot start its own stack is a run nobody else can reproduce.
set -euo pipefail
export PATH=/usr/lib/postgresql/16/bin:$PATH
cd "$(dirname "$0")/../.."

PGDATA_DIR=${PGDATA_DIR:-/var/tmp/pgdata-acceptance}
PGRST_BIN=${PGRST_BIN:-/var/tmp/postgrest}
PG_PORT=${LOCAL_PG_PORT:-54999}
RUNAS=$(id -u postgres >/dev/null 2>&1 && echo postgres || echo pgrunner)

if ! pg_isready -h localhost -p "$PG_PORT" >/dev/null 2>&1; then
  if [ ! -s "$PGDATA_DIR/PG_VERSION" ]; then
    id -u "$RUNAS" >/dev/null 2>&1 || useradd -r -s /bin/false "$RUNAS"
    rm -rf "$PGDATA_DIR"; mkdir -p "$PGDATA_DIR"
    chown -R "$RUNAS" "$PGDATA_DIR"; chmod 700 "$PGDATA_DIR"
    su -s /bin/bash "$RUNAS" -c \
      "PATH=/usr/lib/postgresql/16/bin:\$PATH initdb -D $PGDATA_DIR -U postgres --auth=trust -E UTF8" >/dev/null
  fi
  su -s /bin/bash "$RUNAS" -c \
    "PATH=/usr/lib/postgresql/16/bin:\$PATH pg_ctl -D $PGDATA_DIR \
      -o '-p $PG_PORT -c listen_addresses=localhost -c fsync=off' -l $PGDATA_DIR/log start" >/dev/null
  for _ in $(seq 1 30); do pg_isready -h localhost -p "$PG_PORT" >/dev/null 2>&1 && break; sleep 1; done
fi
echo "postgres ready on :$PG_PORT"

if ! curl -sf -o /dev/null "http://localhost:54998/"; then
  # The database must exist before PostgREST can load a catalogue from it.
  psql -h localhost -p "$PG_PORT" -U postgres -Atc \
    "select 1 from pg_database where datname='stock_acceptance'" | grep -q 1 \
    || node scripts/stock-acceptance/build-database.mjs
  ( cd /var/tmp && setsid "$PGRST_BIN" pgrst.conf < /dev/null > pgrst.log 2>&1 & )
  for _ in $(seq 1 30); do curl -sf -o /dev/null "http://localhost:54998/" && break; sleep 1; done
fi
echo "postgrest ready on :54998"

if ! curl -s -o /dev/null -w "%{http_code}" "http://localhost:54997/" | grep -q 501; then
  setsid node scripts/stock-acceptance/supabase-gateway.mjs < /dev/null > /var/tmp/gateway.log 2>&1 &
  for _ in $(seq 1 20); do curl -s -o /dev/null "http://localhost:54997/" && break; sleep 1; done
fi
echo "gateway ready on :54997"

[ -s /var/tmp/service-role.jwt ] || node -e "
const c=require('crypto');
const b64=(o)=>Buffer.from(JSON.stringify(o)).toString('base64url');
const secret='acceptance-corpus-local-jwt-secret-which-is-at-least-32-bytes';
const h=b64({alg:'HS256',typ:'JWT'});
const now=Math.floor(Date.now()/1000);
const p=b64({role:'service_role',iss:'supabase',iat:now,exp:now+86400*30});
const s=c.createHmac('sha256',secret).update(h+'.'+p).digest('base64url');
require('fs').writeFileSync('/var/tmp/service-role.jwt', h+'.'+p+'.'+s);
"
echo "service_role key ready"
