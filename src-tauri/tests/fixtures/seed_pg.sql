-- Test data for tests/db_integration.rs and tests/tools_docker.rs (container rits-pg).
-- docker exec -i rits-pg psql -U postgres -v ON_ERROR_STOP=1 < src-tauri/tests/fixtures/seed_pg.sql
CREATE DATABASE loja;
\c loja
CREATE SCHEMA vendas;
CREATE TABLE vendas.clientes (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, nome text NOT NULL, email text UNIQUE, criado_em timestamptz DEFAULT now());
COMMENT ON TABLE vendas.clientes IS 'Cadastro de clientes';
CREATE TABLE vendas.pedidos (id serial PRIMARY KEY, cliente_id bigint REFERENCES vendas.clientes(id), total numeric(12,2), status text DEFAULT 'novo');
CREATE INDEX ON vendas.pedidos(status);
INSERT INTO vendas.clientes(nome, email) SELECT 'Cliente ' || g, 'c' || g || '@ex.com' FROM generate_series(1, 1500) g;
INSERT INTO vendas.pedidos(cliente_id, total, status)
  SELECT (random() * 1499 + 1)::int, round((random() * 1000)::numeric, 2), (ARRAY['novo','pago','enviado'])[1 + (g % 3)] FROM generate_series(1, 5000) g;
CREATE VIEW vendas.resumo AS SELECT status, count(*) qtd, sum(total) soma FROM vendas.pedidos GROUP BY status;
CREATE FUNCTION vendas.total_cliente(cid bigint) RETURNS numeric LANGUAGE sql AS $$ SELECT coalesce(sum(total), 0) FROM vendas.pedidos WHERE cliente_id = cid $$;
CREATE TABLE public.log_sem_pk (msg text, nivel int);
INSERT INTO public.log_sem_pk VALUES ('a', 1), ('b', 2), ('b', 2);
