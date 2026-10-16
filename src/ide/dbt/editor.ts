// Editor integration of the dbt plugin: Jinja highlighting in models, navigation from ref() and
// source() to their files, and file templates compatible with dbt Core 1.10–1.12.
import { Decoration, MatchDecorator, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import type { DbtNode } from "./api";

const jinjaDeco = new MatchDecorator({
  regexp: /\{#[\s\S]*?#\}|\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/g,
  decoration: (m) => Decoration.mark({ class: m[0].startsWith("{#") ? "cm-jinja-comment" : "cm-jinja" }),
});

export const jinjaHighlight: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = jinjaDeco.createDeco(view);
    }
    update(u: ViewUpdate) {
      this.decorations = jinjaDeco.updateDeco(u, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

export interface RefAt {
  kind: "ref" | "source";
  /** ref: [name] or [package, name]; source: [source, table] */
  args: string[];
}

/** ref()/source() call around an offset (quotes, versions as keyword args ignored). */
export function refAt(text: string, pos: number): RefAt | null {
  const re = /\b(ref|source)\s*\(\s*((?:['"][^'"]*['"]\s*,?\s*)+)(?:[^)]*)\)/g;
  for (const m of text.matchAll(re)) {
    const start = m.index!;
    if (pos < start || pos > start + m[0].length) continue;
    const args = [...m[2].matchAll(/['"]([^'"]*)['"]/g)].map((a) => a[1]);
    if (!args.length) continue;
    return { kind: m[1] as "ref" | "source", args };
  }
  return null;
}

export function resolveRef(r: RefAt, nodes: DbtNode[]): DbtNode | null {
  if (r.kind === "ref") {
    const name = r.args[r.args.length - 1];
    const pkg = r.args.length > 1 ? r.args[0] : null;
    return nodes.find((n) => ["model", "seed", "snapshot"].includes(n.resourceType) && n.name === name && (!pkg || n.package === pkg)) ?? null;
  }
  const [src, table] = r.args;
  return nodes.find((n) => n.resourceType === "source" && n.sourceName === src && n.name === table) ?? null;
}

export interface Template {
  id: string;
  label: string;
  dir: string;
  name: string;
  ext: string;
  body: (name: string) => string;
}

export const TEMPLATES: Template[] = [
  {
    id: "model",
    label: "Modelo SQL",
    dir: "models",
    name: "stg_exemplo",
    ext: ".sql",
    body: () => `{{ config(materialized='view') }}

with origem as (

    select * from {{ source('minha_origem', 'minha_tabela') }}

)

select
    id,
    nome,
    criado_em
from origem
`,
  },
  {
    id: "sources",
    label: "Sources (YAML)",
    dir: "models",
    name: "_sources",
    ext: ".yml",
    body: () => `version: 2

sources:
  - name: minha_origem
    schema: public
    tables:
      - name: minha_tabela
        description: "Tabela bruta carregada pela ingestão"
        columns:
          - name: id
            data_tests:
              - unique
              - not_null
`,
  },
  {
    id: "tests",
    label: "Testes de modelo (YAML)",
    dir: "models",
    name: "_schema",
    ext: ".yml",
    body: () => `version: 2

models:
  - name: stg_exemplo
    description: "Descreva o modelo"
    columns:
      - name: id
        data_tests:
          - unique
          - not_null
      - name: status
        data_tests:
          - accepted_values:
              arguments:
                values: ['ativo', 'inativo']
`,
  },
  {
    id: "singular",
    label: "Teste singular (SQL)",
    dir: "tests",
    name: "assert_sem_valores_negativos",
    ext: ".sql",
    body: () => `-- O teste falha se esta consulta retornar linhas.
select *
from {{ ref('stg_exemplo') }}
where valor < 0
`,
  },
  {
    id: "unit",
    label: "Teste unitário (YAML)",
    dir: "models",
    name: "_unit_tests",
    ext: ".yml",
    body: () => `unit_tests:
  - name: test_stg_exemplo_filtra_inativos
    model: stg_exemplo
    given:
      - input: source('minha_origem', 'minha_tabela')
        rows:
          - {id: 1, nome: "ana", status: "ativo"}
          - {id: 2, nome: "bia", status: "inativo"}
    expect:
      rows:
        - {id: 1, nome: "ana"}
`,
  },
  {
    id: "seed",
    label: "Seed (CSV)",
    dir: "seeds",
    name: "de_para_status",
    ext: ".csv",
    body: () => `codigo,descricao\n1,ativo\n2,inativo\n`,
  },
  {
    id: "snapshot",
    label: "Snapshot (YAML)",
    dir: "snapshots",
    name: "clientes_snapshot",
    ext: ".yml",
    body: () => `snapshots:
  - name: clientes_snapshot
    relation: source('minha_origem', 'minha_tabela')
    config:
      schema: snapshots
      unique_key: id
      strategy: timestamp
      updated_at: atualizado_em
`,
  },
];
