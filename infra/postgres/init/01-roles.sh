#!/bin/sh
# Creates the least-privilege roles Daliz uses. Runs once, on first container start.
#  - platform role: owns the central platform database only
#  - provisioner role: may create tenant databases and tenant roles, but is NOT a superuser
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
CREATE ROLE "${DALIZ_PLATFORM_DB_USER}" LOGIN PASSWORD '${DALIZ_PLATFORM_DB_PASSWORD}';
CREATE ROLE "${DALIZ_PROVISIONER_USER}" LOGIN CREATEDB CREATEROLE PASSWORD '${DALIZ_PROVISIONER_PASSWORD}';
CREATE DATABASE "${DALIZ_PLATFORM_DB}" OWNER "${DALIZ_PLATFORM_DB_USER}";
REVOKE CONNECT ON DATABASE "${DALIZ_PLATFORM_DB}" FROM PUBLIC;
GRANT CONNECT ON DATABASE "${DALIZ_PLATFORM_DB}" TO "${DALIZ_PLATFORM_DB_USER}";
-- Separate platform database for the automated test suite.
CREATE DATABASE "${DALIZ_PLATFORM_DB}_test" OWNER "${DALIZ_PLATFORM_DB_USER}";
REVOKE CONNECT ON DATABASE "${DALIZ_PLATFORM_DB}_test" FROM PUBLIC;
GRANT CONNECT ON DATABASE "${DALIZ_PLATFORM_DB}_test" TO "${DALIZ_PLATFORM_DB_USER}";
-- New databases must not be connectable by arbitrary roles.
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
GRANT CONNECT ON DATABASE postgres TO "${DALIZ_PROVISIONER_USER}";
SQL
