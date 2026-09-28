#!/bin/sh
# Creates the database used by `npm run test:e2e` alongside the main one.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE DATABASE kidzone_test OWNER $POSTGRES_USER;
EOSQL
