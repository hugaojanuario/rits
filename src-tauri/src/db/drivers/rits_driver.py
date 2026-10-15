"""Rits database driver host.

Runs inside the drivers venv created by Rits (src-tauri/src/db/ext.rs). Reads one JSON request per
line on stdin ({"id", "op", ...}) and writes one JSON reply per line on stdout
({"id", "ok": true, "result"} or {"id", "ok": false, "error"}). One process serves one session.
"""

import datetime
import decimal
import json
import re
import sys
import time
import traceback
import uuid

MAX_ROWS = 50000


def text(v):
    if v is None:
        return None
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (bytes, bytearray, memoryview)):
        return "\\x" + bytes(v).hex()
    if isinstance(v, datetime.datetime):
        return v.isoformat(sep=" ")
    if isinstance(v, (datetime.date, datetime.time)):
        return v.isoformat()
    if isinstance(v, (decimal.Decimal, uuid.UUID)):
        return str(v)
    if isinstance(v, (dict, list, tuple)):
        return json.dumps(v, default=str, ensure_ascii=False)
    if hasattr(v, "read"):  # LOBs
        return text(v.read())
    return str(v)


def result(columns, rows, affected, has_rows, truncated, t0):
    return {
        "columns": columns,
        "rows": rows,
        "affected": affected,
        "hasRows": has_rows,
        "truncated": truncated,
        "elapsedMs": int((time.time() - t0) * 1000),
    }


def col(name, data_type, nullable=True, default=None, pk=False, comment=None):
    return {"name": name, "dataType": data_type or "", "nullable": bool(nullable), "default": text(default), "pk": bool(pk), "comment": text(comment)}


def group_completion(rows):
    out = {}
    for schema, table, column in rows:
        out.setdefault((schema or "", table), []).append(column)
    return [{"schema": s, "table": t, "columns": c} for (s, t), c in out.items()]


def group_fks(rows):
    """rows: (name, table, ref_schema, ref_table, column, ref_column) ordered by fk + position."""
    fks = []
    for name, table, ref_schema, ref_table, c, rc in rows:
        name, table = (name or "").strip(), (table or "").strip()
        if fks and fks[-1]["name"] == name and fks[-1]["table"] == table:
            fks[-1]["columns"].append(c.strip())
            fks[-1]["refColumns"].append(rc.strip())
        else:
            fks.append({"name": name, "table": table, "refSchema": (ref_schema or "").strip(), "refTable": ref_table.strip(), "columns": [c.strip()], "refColumns": [rc.strip()]})
    return fks


class Unsupported(Exception):
    pass


# ---------------------------------------------------------------------------------------------
# DB-API based drivers
# ---------------------------------------------------------------------------------------------


class SqlDriver:
    param = "%s"

    def __init__(self, cfg, db):
        self.cfg = cfg
        self.db = db or cfg.get("database") or ""
        self.conn = None

    def rows(self, sql, params=()):
        cur = self.conn.cursor()
        cur.execute(sql, params) if params else cur.execute(sql)
        out = cur.fetchall()
        try:
            cur.close()
        except Exception:
            pass
        return out

    def commit(self):
        try:
            self.conn.commit()
        except Exception:
            pass

    def prepare(self, sql):
        return sql

    def execute(self, sql):
        t0 = time.time()
        cur = self.conn.cursor()
        try:
            cur.execute(self.prepare(sql))
            results = []
            while True:
                if cur.description:
                    cols = [d[0] for d in cur.description]
                    rows = cur.fetchmany(MAX_ROWS + 1)
                    truncated = len(rows) > MAX_ROWS
                    results.append(result(cols, [[text(v) for v in r] for r in rows[:MAX_ROWS]], None, True, truncated, t0))
                else:
                    rc = getattr(cur, "rowcount", -1)
                    results.append(result([], [], rc if rc is not None and rc >= 0 else 0, False, False, t0))
                nextset = getattr(cur, "nextset", None)
                try:
                    if not (nextset and nextset()):
                        break
                except Exception:
                    break
            self.commit()
            return results
        except Exception:
            try:
                self.conn.rollback()
            except Exception:
                pass
            raise
        finally:
            try:
                cur.close()
            except Exception:
                pass

    # defaults
    def schemas(self):
        # Databases without schemas: the database itself plays the role (like MySQL in the explorer).
        return [self.db]

    def indexes(self, schema, table):
        return []

    def foreign_keys(self, schema):
        return []

    def diagram(self, schema):
        tables = []
        for name, kind, cols in self.table_columns(schema):
            tables.append({"name": name, "kind": kind, "columns": cols})
        return {"tables": tables, "fks": self.foreign_keys(schema)}

    def table_columns(self, schema):
        out = []
        for o in self.objects(schema):
            if o["kind"] in ("table", "view", "matview"):
                out.append((o["name"], o["kind"], self.columns(schema, o["name"])))
        return out

    def generated_ddl(self, schema, name):
        cols = self.columns(schema, name)
        q = self.quote
        lines = []
        for c in cols:
            line = f"    {q(c['name'])} {c['dataType']}"
            if c["default"]:
                line += f" DEFAULT {c['default']}"
            if not c["nullable"]:
                line += " NOT NULL"
            lines.append(line)
        pk = [q(c["name"]) for c in cols if c["pk"]]
        if pk:
            lines.append(f"    PRIMARY KEY ({', '.join(pk)})")
        full = f"{q(schema)}.{q(name)}" if schema else q(name)
        return f"CREATE TABLE {full} (\n" + ",\n".join(lines) + "\n);"

    @staticmethod
    def quote(n):
        return '"' + n.replace('"', '""') + '"'


class SqlServer(SqlDriver):
    def __init__(self, cfg, db):
        super().__init__(cfg, db)
        import pytds

        kw = dict(server=cfg["host"], port=int(cfg.get("port") or 1433), user=cfg.get("user") or None, password=cfg.get("password") or None, database=self.db or None, autocommit=True, login_timeout=15, as_dict=False)
        if cfg.get("ssl"):
            import certifi

            kw.update(cafile=certifi.where(), validate_host=False)
        self.conn = pytds.connect(**kw)

    @staticmethod
    def quote(n):
        return "[" + n.replace("]", "]]") + "]"

    def obj(self, schema, name):
        return f"{self.quote(schema)}.{self.quote(name)}"

    def server_info(self):
        v, u = self.rows("SELECT @@VERSION, SUSER_SNAME()")[0]
        return {"version": v.split("\n")[0].strip(), "currentUser": u or ""}

    def databases(self):
        return [r[0] for r in self.rows("SELECT name FROM sys.databases WHERE state = 0 ORDER BY CASE WHEN database_id <= 4 THEN 1 ELSE 0 END, name")]

    def schemas(self):
        return [r[0] for r in self.rows("SELECT name FROM sys.schemas WHERE name NOT IN ('sys','INFORMATION_SCHEMA','guest') AND name NOT LIKE 'db[_]%' ORDER BY CASE name WHEN 'dbo' THEN 0 ELSE 1 END, name")]

    def objects(self, schema):
        r = self.rows(
            """SELECT o.name, CASE o.type WHEN 'U' THEN 'table' WHEN 'V' THEN 'view' WHEN 'P' THEN 'procedure'
                      WHEN 'SO' THEN 'sequence' WHEN 'TR' THEN 'trigger' ELSE 'function' END,
                      CAST(ep.value AS nvarchar(4000))
               FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
               LEFT JOIN sys.extended_properties ep ON ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.name = 'MS_Description'
               WHERE s.name = %s AND o.type IN ('U','V','P','FN','IF','TF','TR','SO') AND o.is_ms_shipped = 0 ORDER BY o.name""",
            (schema,),
        )
        return [{"name": n, "kind": k, "comment": c} for n, k, c in r]

    COLS = """SELECT o.name, c.name,
                 TYPE_NAME(c.user_type_id) +
                 CASE WHEN TYPE_NAME(c.user_type_id) IN ('varchar','char','varbinary','binary') THEN '(' + CASE c.max_length WHEN -1 THEN 'max' ELSE CAST(c.max_length AS varchar) END + ')'
                      WHEN TYPE_NAME(c.user_type_id) IN ('nvarchar','nchar') THEN '(' + CASE c.max_length WHEN -1 THEN 'max' ELSE CAST(c.max_length / 2 AS varchar) END + ')'
                      WHEN TYPE_NAME(c.user_type_id) IN ('decimal','numeric') THEN '(' + CAST(c.precision AS varchar) + ',' + CAST(c.scale AS varchar) + ')'
                      ELSE '' END + CASE WHEN c.is_identity = 1 THEN ' identity' ELSE '' END,
                 c.is_nullable, OBJECT_DEFINITION(c.default_object_id),
                 CASE WHEN EXISTS (SELECT 1 FROM sys.index_columns ic JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
                                   WHERE i.is_primary_key = 1 AND ic.object_id = c.object_id AND ic.column_id = c.column_id) THEN 1 ELSE 0 END,
                 CAST(ep.value AS nvarchar(4000)),
                 CASE o.type WHEN 'V' THEN 'view' ELSE 'table' END
              FROM sys.columns c JOIN sys.objects o ON o.object_id = c.object_id JOIN sys.schemas s ON s.schema_id = o.schema_id
              LEFT JOIN sys.extended_properties ep ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = 'MS_Description'"""

    def columns(self, schema, table):
        r = self.rows(self.COLS + " WHERE c.object_id = OBJECT_ID(%s) ORDER BY c.column_id", (self.obj(schema, table),))
        return [col(n, t, nl, d, pk, cm) for _, n, t, nl, d, pk, cm, _k in r]

    def table_columns(self, schema):
        r = self.rows(self.COLS + " WHERE s.name = %s AND o.type IN ('U','V') ORDER BY o.name, c.column_id", (schema,))
        out = []
        for tname, n, t, nl, d, pk, cm, kind in r:
            if not out or out[-1][0] != tname:
                out.append((tname, kind, []))
            out[-1][2].append(col(n, t, nl, d, pk, cm))
        return out

    def indexes(self, schema, table):
        r = self.rows(
            """SELECT i.name, STRING_AGG(c.name, ', ') WITHIN GROUP (ORDER BY ic.key_ordinal), i.is_unique, i.is_primary_key
               FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
               JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
               WHERE i.object_id = OBJECT_ID(%s) AND i.name IS NOT NULL
               GROUP BY i.name, i.is_unique, i.is_primary_key ORDER BY i.is_primary_key DESC, i.name""",
            (self.obj(schema, table),),
        )
        return [{"name": n, "columns": c, "unique": bool(u), "primary": bool(p)} for n, c, u, p in r]

    def foreign_keys(self, schema):
        return group_fks(
            self.rows(
                """SELECT fk.name, tp.name, rs.name, tr.name, cp.name, cr.name
                   FROM sys.foreign_keys fk JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
                   JOIN sys.tables tp ON tp.object_id = fk.parent_object_id JOIN sys.schemas ps ON ps.schema_id = tp.schema_id
                   JOIN sys.tables tr ON tr.object_id = fk.referenced_object_id JOIN sys.schemas rs ON rs.schema_id = tr.schema_id
                   JOIN sys.columns cp ON cp.object_id = fkc.parent_object_id AND cp.column_id = fkc.parent_column_id
                   JOIN sys.columns cr ON cr.object_id = fkc.referenced_object_id AND cr.column_id = fkc.referenced_column_id
                   WHERE ps.name = %s ORDER BY tp.name, fk.name, fkc.constraint_column_id""",
                (schema,),
            )
        )

    def completion(self, schema):
        return group_completion(
            self.rows(
                """SELECT s.name, o.name, c.name FROM sys.columns c JOIN sys.objects o ON o.object_id = c.object_id
                   JOIN sys.schemas s ON s.schema_id = o.schema_id WHERE o.type IN ('U','V') AND o.is_ms_shipped = 0
                   ORDER BY s.name, o.name, c.column_id"""
            )
        )

    def ddl(self, schema, name, kind):
        if kind == "table":
            return self.generated_ddl(schema, name)
        r = self.rows("SELECT OBJECT_DEFINITION(OBJECT_ID(%s))", (self.obj(schema, name),))
        return (r[0][0] if r and r[0][0] else "-- definição indisponível").strip()


class Oracle(SqlDriver):
    def __init__(self, cfg, db):
        super().__init__(cfg, db)
        import oracledb

        oracledb.defaults.fetch_lobs = False
        service = cfg.get("database") or "FREEPDB1"
        proto = "tcps://" if cfg.get("ssl") else ""
        self.conn = oracledb.connect(user=cfg.get("user"), password=cfg.get("password"), dsn=f"{proto}{cfg['host']}:{int(cfg.get('port') or 1521)}/{service}")
        self.conn.autocommit = True
        self.service = service

    def prepare(self, sql):
        if re.match(r"^\s*(BEGIN|DECLARE|CREATE\s+(OR\s+REPLACE\s+)?(PROCEDURE|FUNCTION|PACKAGE|TRIGGER|TYPE))\b", sql, re.I):
            return sql
        return sql.rstrip().rstrip(";")

    def server_info(self):
        return {"version": f"Oracle {self.conn.version}", "currentUser": self.rows("SELECT USER FROM dual")[0][0]}

    def databases(self):
        return [self.service]

    def schemas(self):
        me = self.rows("SELECT USER FROM dual")[0][0]
        try:
            r = [x[0] for x in self.rows("SELECT username FROM all_users WHERE oracle_maintained = 'N' ORDER BY username")]
        except Exception:
            r = [x[0] for x in self.rows("SELECT username FROM all_users ORDER BY username")]
        return [me] + [x for x in r if x != me]

    def objects(self, schema):
        kinds = {"TABLE": "table", "VIEW": "view", "MATERIALIZED VIEW": "matview", "FUNCTION": "function", "PROCEDURE": "procedure", "PACKAGE": "procedure", "SEQUENCE": "sequence", "TRIGGER": "trigger"}
        r = self.rows(
            "SELECT object_name, object_type FROM all_objects WHERE owner = :o AND object_type IN ('TABLE','VIEW','MATERIALIZED VIEW','FUNCTION','PROCEDURE','PACKAGE','SEQUENCE','TRIGGER') AND object_name NOT LIKE 'BIN$%' ORDER BY object_name",
            {"o": schema},
        )
        return [{"name": n, "kind": kinds[t], "comment": None} for n, t in r]

    COLS = """SELECT c.table_name, c.column_name,
                     c.data_type || CASE WHEN c.data_type IN ('VARCHAR2','NVARCHAR2','CHAR','NCHAR','RAW') THEN '(' || c.char_length || ')'
                                         WHEN c.data_type = 'NUMBER' AND c.data_precision IS NOT NULL THEN '(' || c.data_precision || ',' || c.data_scale || ')' END,
                     c.nullable, c.data_default, CASE WHEN pk.column_name IS NULL THEN 0 ELSE 1 END, cm.comments
              FROM all_tab_columns c
              LEFT JOIN (SELECT cc.table_name, cc.column_name FROM all_constraints k JOIN all_cons_columns cc ON cc.owner = k.owner AND cc.constraint_name = k.constraint_name
                         WHERE k.constraint_type = 'P' AND k.owner = :o) pk ON pk.table_name = c.table_name AND pk.column_name = c.column_name
              LEFT JOIN all_col_comments cm ON cm.owner = c.owner AND cm.table_name = c.table_name AND cm.column_name = c.column_name
              WHERE c.owner = :o"""

    def columns(self, schema, table):
        r = self.rows(self.COLS + " AND c.table_name = :t ORDER BY c.column_id", {"o": schema, "t": table})
        return [col(n, t, nl == "Y", (d or "").strip() or None, pk, cm) for _, n, t, nl, d, pk, cm in r]

    def table_columns(self, schema):
        kinds = {o["name"]: o["kind"] for o in self.objects(schema)}
        r = self.rows(self.COLS + " ORDER BY c.table_name, c.column_id", {"o": schema})
        out = []
        for tname, n, t, nl, d, pk, cm in r:
            if tname not in kinds:
                continue
            if not out or out[-1][0] != tname:
                out.append((tname, kinds[tname], []))
            out[-1][2].append(col(n, t, nl == "Y", (d or "").strip() or None, pk, cm))
        return out

    def indexes(self, schema, table):
        r = self.rows(
            """SELECT i.index_name, LISTAGG(ic.column_name, ', ') WITHIN GROUP (ORDER BY ic.column_position),
                      CASE i.uniqueness WHEN 'UNIQUE' THEN 1 ELSE 0 END, CASE WHEN MAX(k.constraint_name) IS NULL THEN 0 ELSE 1 END
               FROM all_indexes i JOIN all_ind_columns ic ON ic.index_owner = i.owner AND ic.index_name = i.index_name
               LEFT JOIN all_constraints k ON k.owner = i.owner AND k.index_name = i.index_name AND k.constraint_type = 'P'
               WHERE i.table_owner = :o AND i.table_name = :t GROUP BY i.index_name, i.uniqueness ORDER BY 4 DESC, 1""",
            {"o": schema, "t": table},
        )
        return [{"name": n, "columns": c, "unique": bool(u), "primary": bool(p)} for n, c, u, p in r]

    def foreign_keys(self, schema):
        return group_fks(
            self.rows(
                """SELECT c.constraint_name, c.table_name, r.owner, r.table_name, cc.column_name, rc.column_name
                   FROM all_constraints c JOIN all_constraints r ON r.owner = c.r_owner AND r.constraint_name = c.r_constraint_name
                   JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
                   JOIN all_cons_columns rc ON rc.owner = r.owner AND rc.constraint_name = r.constraint_name AND rc.position = cc.position
                   WHERE c.constraint_type = 'R' AND c.owner = :o ORDER BY c.table_name, c.constraint_name, cc.position""",
                {"o": schema},
            )
        )

    def completion(self, schema):
        owner = schema or self.rows("SELECT USER FROM dual")[0][0]
        return group_completion(self.rows("SELECT owner, table_name, column_name FROM all_tab_columns WHERE owner = :o ORDER BY table_name, column_id", {"o": owner}))

    def ddl(self, schema, name, kind):
        ty = {"matview": "MATERIALIZED_VIEW"}.get(kind, kind.upper())
        try:
            r = self.rows("SELECT DBMS_METADATA.GET_DDL(:ty, :n, :o) FROM dual", {"ty": ty, "n": name, "o": schema})
            return text(r[0][0]).strip()
        except Exception:
            return self.generated_ddl(schema, name) if kind == "table" else "-- definição indisponível"


class Firebird(SqlDriver):
    param = "?"
    TYPES = {7: "SMALLINT", 8: "INTEGER", 10: "FLOAT", 12: "DATE", 13: "TIME", 14: "CHAR", 16: "BIGINT", 23: "BOOLEAN", 24: "DECFLOAT(16)", 25: "DECFLOAT(34)", 26: "INT128", 27: "DOUBLE PRECISION", 28: "TIME WITH TIME ZONE", 29: "TIMESTAMP WITH TIME ZONE", 35: "TIMESTAMP", 37: "VARCHAR", 261: "BLOB"}

    def __init__(self, cfg, db):
        super().__init__(cfg, db)
        import firebirdsql

        self.conn = firebirdsql.connect(host=cfg["host"], port=int(cfg.get("port") or 3050), database=cfg.get("database"), user=cfg.get("user") or "SYSDBA", password=cfg.get("password") or "", charset="UTF8")
        try:
            self.conn.set_autocommit(True)
        except Exception:
            pass

    def server_info(self):
        v, u = self.rows("SELECT rdb$get_context('SYSTEM', 'ENGINE_VERSION'), CURRENT_USER FROM rdb$database")[0]
        return {"version": f"Firebird {v}", "currentUser": (u or "").strip()}

    def databases(self):
        return [self.cfg.get("database") or "default"]

    def objects(self, schema):
        out = [{"name": n.strip(), "kind": k.strip(), "comment": text(c)} for n, k, c in self.rows(
            "SELECT r.rdb$relation_name, CASE WHEN r.rdb$view_blr IS NULL THEN 'table' ELSE 'view' END, r.rdb$description FROM rdb$relations r WHERE COALESCE(r.rdb$system_flag, 0) = 0 ORDER BY 1")]
        for sql, kind in (
            ("SELECT rdb$procedure_name FROM rdb$procedures WHERE COALESCE(rdb$system_flag, 0) = 0 ORDER BY 1", "procedure"),
            ("SELECT rdb$function_name FROM rdb$functions WHERE COALESCE(rdb$system_flag, 0) = 0 ORDER BY 1", "function"),
            ("SELECT rdb$generator_name FROM rdb$generators WHERE COALESCE(rdb$system_flag, 0) = 0 ORDER BY 1", "sequence"),
            ("SELECT rdb$trigger_name FROM rdb$triggers WHERE COALESCE(rdb$system_flag, 0) = 0 ORDER BY 1", "trigger"),
        ):
            try:
                out += [{"name": r[0].strip(), "kind": kind, "comment": None} for r in self.rows(sql)]
            except Exception:
                pass
        return out

    def type_name(self, ftype, sub, length, prec, scale, clen):
        if ftype in (7, 8, 16) and scale and scale < 0:
            return f"NUMERIC({prec or 18},{-scale})"
        if ftype in (14, 37):
            return f"{self.TYPES[ftype]}({clen or length})"
        if ftype == 261:
            return "BLOB SUB_TYPE TEXT" if sub == 1 else "BLOB"
        return self.TYPES.get(ftype, str(ftype))

    COLS = """SELECT rf.rdb$relation_name, rf.rdb$field_name, f.rdb$field_type, f.rdb$field_sub_type, f.rdb$field_length, f.rdb$field_precision,
                     f.rdb$field_scale, f.rdb$character_length, rf.rdb$null_flag, rf.rdb$default_source, rf.rdb$description,
                     (SELECT COUNT(*) FROM rdb$relation_constraints rc JOIN rdb$index_segments s ON s.rdb$index_name = rc.rdb$index_name
                      WHERE rc.rdb$relation_name = rf.rdb$relation_name AND rc.rdb$constraint_type = 'PRIMARY KEY' AND s.rdb$field_name = rf.rdb$field_name)
              FROM rdb$relation_fields rf JOIN rdb$fields f ON f.rdb$field_name = rf.rdb$field_source"""

    def _col(self, r):
        _, n, ft, sub, ln, pr, sc, cl, nf, d, cm, pk = r
        default = (text(d) or "").strip()
        default = re.sub(r"^DEFAULT\s+", "", default, flags=re.I) or None
        return col(n.strip(), self.type_name(ft, sub, ln, pr, sc, cl), not nf, default, pk, cm)

    def columns(self, schema, table):
        return [self._col(r) for r in self.rows(self.COLS + " WHERE rf.rdb$relation_name = ? ORDER BY rf.rdb$field_position", (table,))]

    def table_columns(self, schema):
        kinds = {o["name"]: o["kind"] for o in self.objects(schema) if o["kind"] in ("table", "view")}
        out = []
        for r in self.rows(self.COLS + " JOIN rdb$relations rel ON rel.rdb$relation_name = rf.rdb$relation_name WHERE COALESCE(rel.rdb$system_flag, 0) = 0 ORDER BY rf.rdb$relation_name, rf.rdb$field_position"):
            t = r[0].strip()
            if t not in kinds:
                continue
            if not out or out[-1][0] != t:
                out.append((t, kinds[t], []))
            out[-1][2].append(self._col(r))
        return out

    def indexes(self, schema, table):
        r = self.rows(
            """SELECT i.rdb$index_name, LIST(TRIM(s.rdb$field_name), ', '), COALESCE(i.rdb$unique_flag, 0),
                      (SELECT COUNT(*) FROM rdb$relation_constraints rc WHERE rc.rdb$index_name = i.rdb$index_name AND rc.rdb$constraint_type = 'PRIMARY KEY')
               FROM rdb$indices i JOIN rdb$index_segments s ON s.rdb$index_name = i.rdb$index_name
               WHERE i.rdb$relation_name = ? GROUP BY i.rdb$index_name, i.rdb$unique_flag""",
            (table,),
        )
        return [{"name": n.strip(), "columns": text(c), "unique": bool(u), "primary": bool(p)} for n, c, u, p in r]

    def foreign_keys(self, schema):
        return group_fks(
            [(n, t, "", rt, c, rc) for n, t, rt, c, rc in self.rows(
                """SELECT rc.rdb$constraint_name, rc.rdb$relation_name, rc2.rdb$relation_name, s.rdb$field_name, s2.rdb$field_name
                   FROM rdb$relation_constraints rc
                   JOIN rdb$ref_constraints ref ON ref.rdb$constraint_name = rc.rdb$constraint_name
                   JOIN rdb$relation_constraints rc2 ON rc2.rdb$constraint_name = ref.rdb$const_name_uq
                   JOIN rdb$index_segments s ON s.rdb$index_name = rc.rdb$index_name
                   JOIN rdb$index_segments s2 ON s2.rdb$index_name = rc2.rdb$index_name AND s2.rdb$field_position = s.rdb$field_position
                   WHERE rc.rdb$constraint_type = 'FOREIGN KEY' ORDER BY 2, 1, s.rdb$field_position""")]
        )

    def completion(self, schema):
        return group_completion([("", t.strip(), c.strip()) for t, c in self.rows(
            "SELECT rf.rdb$relation_name, rf.rdb$field_name FROM rdb$relation_fields rf JOIN rdb$relations r ON r.rdb$relation_name = rf.rdb$relation_name WHERE COALESCE(r.rdb$system_flag, 0) = 0 ORDER BY 1, rf.rdb$field_position")])

    def ddl(self, schema, name, kind):
        q = {
            "view": "SELECT rdb$view_source FROM rdb$relations WHERE rdb$relation_name = ?",
            "procedure": "SELECT rdb$procedure_source FROM rdb$procedures WHERE rdb$procedure_name = ?",
            "trigger": "SELECT rdb$trigger_source FROM rdb$triggers WHERE rdb$trigger_name = ?",
        }.get(kind)
        if kind == "table":
            return self.generated_ddl("", name)
        if not q:
            return "-- definição indisponível"
        r = self.rows(q, (name,))
        src = (text(r[0][0]) if r else "") or ""
        return f"CREATE VIEW {self.quote(name)} AS\n{src.strip()};" if kind == "view" else src.strip()


class Sqlite(SqlDriver):
    def __init__(self, cfg, db):
        super().__init__(cfg, db)
        import sqlite3

        path = cfg.get("database") or cfg.get("host")
        if not path:
            raise Exception("Informe o arquivo do banco SQLite.")
        self.conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.sqlite3 = sqlite3

    def execute(self, sql):
        try:
            return super().execute(sql)
        except self.sqlite3.ProgrammingError as e:
            if "one statement" not in str(e):
                raise
            t0 = time.time()
            self.conn.executescript(sql)
            return [result([], [], 0, False, False, t0)]

    def server_info(self):
        return {"version": "SQLite " + self.rows("SELECT sqlite_version()")[0][0], "currentUser": ""}

    def databases(self):
        return [r[1] for r in self.rows("PRAGMA database_list")]

    def objects(self, schema):
        s = self.quote(schema or "main")
        r = self.rows(f"SELECT name, type FROM {s}.sqlite_master WHERE type IN ('table','view','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY type <> 'table', name")
        return [{"name": n, "kind": k, "comment": None} for n, k in r]

    def columns(self, schema, table):
        r = self.rows(f"PRAGMA {self.quote(schema or 'main')}.table_info({self.quote(table)})")
        return [col(n, t, not nn, d, pk) for _, n, t, nn, d, pk in r]

    def indexes(self, schema, table):
        s = self.quote(schema or "main")
        out = []
        for _, name, unique, origin, *_ in self.rows(f"PRAGMA {s}.index_list({self.quote(table)})"):
            cols = [r[2] for r in self.rows(f"PRAGMA {s}.index_info({self.quote(name)})")]
            out.append({"name": name, "columns": ", ".join(c for c in cols if c), "unique": bool(unique), "primary": origin == "pk"})
        return out

    def foreign_keys(self, schema):
        rows = []
        for o in self.objects(schema):
            if o["kind"] != "table":
                continue
            for fid, _seq, rt, c, rc, *_ in self.rows(f"PRAGMA {self.quote(schema or 'main')}.foreign_key_list({self.quote(o['name'])})"):
                rows.append((f"fk_{o['name']}_{fid}", o["name"], schema, rt, c, rc or "rowid"))
        return group_fks(rows)

    def completion(self, schema):
        out = []
        for o in self.objects(schema or "main"):
            if o["kind"] in ("table", "view"):
                out.append({"schema": "", "table": o["name"], "columns": [c["name"] for c in self.columns(schema or "main", o["name"])]})
        return out

    def ddl(self, schema, name, kind):
        r = self.rows(f"SELECT sql FROM {self.quote(schema or 'main')}.sqlite_master WHERE name = ?", (name,))
        return ((r[0][0] or "") + ";") if r else "-- definição indisponível"


class DuckDb(SqlDriver):
    param = "?"

    def __init__(self, cfg, db):
        super().__init__(cfg, db)
        import duckdb

        self.conn = duckdb.connect(cfg.get("database") or cfg.get("host") or ":memory:")
        self.catalog = db if db and db != (cfg.get("database") or "") else self.rows("SELECT current_database()")[0][0]

    def commit(self):
        pass

    def server_info(self):
        return {"version": "DuckDB " + self.rows("SELECT version()")[0][0], "currentUser": ""}

    def databases(self):
        return [r[0] for r in self.rows("SELECT database_name FROM duckdb_databases() WHERE NOT internal ORDER BY 1")]

    def schemas(self):
        return [r[0] for r in self.rows("SELECT schema_name FROM information_schema.schemata WHERE catalog_name = ? AND schema_name NOT IN ('information_schema','pg_catalog') ORDER BY schema_name <> 'main', 1", (self.catalog,))]

    def objects(self, schema):
        r = self.rows("SELECT table_name, CASE table_type WHEN 'VIEW' THEN 'view' ELSE 'table' END FROM information_schema.tables WHERE table_catalog = ? AND table_schema = ? ORDER BY 1", (self.catalog, schema))
        out = [{"name": n, "kind": k, "comment": None} for n, k in r]
        try:
            out += [{"name": n, "kind": "sequence", "comment": None} for (n,) in self.rows("SELECT sequence_name FROM duckdb_sequences() WHERE database_name = ? AND schema_name = ?", (self.catalog, schema))]
        except Exception:
            pass
        return out

    def _pks(self, schema):
        pks = {}
        for t, cols in self.rows("SELECT table_name, constraint_column_names FROM duckdb_constraints() WHERE constraint_type = 'PRIMARY KEY' AND database_name = ? AND schema_name = ?", (self.catalog, schema)):
            pks[t] = set(cols or [])
        return pks

    def columns(self, schema, table):
        pk = self._pks(schema).get(table, set())
        r = self.rows("SELECT column_name, data_type, is_nullable = 'YES', column_default FROM information_schema.columns WHERE table_catalog = ? AND table_schema = ? AND table_name = ? ORDER BY ordinal_position", (self.catalog, schema, table))
        return [col(n, t, nl, d, n in pk) for n, t, nl, d in r]

    def indexes(self, schema, table):
        out = []
        for t, cols in [(t, c) for t, c in self.rows("SELECT table_name, constraint_column_names FROM duckdb_constraints() WHERE constraint_type = 'PRIMARY KEY' AND database_name = ? AND schema_name = ? AND table_name = ?", (self.catalog, schema, table))]:
            out.append({"name": f"{t}_pkey", "columns": ", ".join(cols or []), "unique": True, "primary": True})
        try:
            for n, e, u in self.rows("SELECT index_name, expressions, is_unique FROM duckdb_indexes() WHERE database_name = ? AND schema_name = ? AND table_name = ?", (self.catalog, schema, table)):
                out.append({"name": n, "columns": text(e), "unique": bool(u), "primary": False})
        except Exception:
            pass
        return out

    def foreign_keys(self, schema):
        try:
            r = self.rows("SELECT constraint_name, table_name, referenced_table, constraint_column_names, referenced_column_names FROM duckdb_constraints() WHERE constraint_type = 'FOREIGN KEY' AND database_name = ? AND schema_name = ?", (self.catalog, schema))
        except Exception:
            return []
        rows = []
        for name, t, rt, cols, rcols in r:
            for c, rc in zip(cols or [], rcols or []):
                rows.append((name or f"fk_{t}_{rt}", t, schema, rt, c, rc))
        return group_fks(rows)

    def completion(self, schema):
        return group_completion(self.rows("SELECT table_schema, table_name, column_name FROM information_schema.columns WHERE table_catalog = ? ORDER BY table_schema, table_name, ordinal_position", (self.catalog,)))

    def ddl(self, schema, name, kind):
        q = "SELECT sql FROM duckdb_views() WHERE database_name = ? AND schema_name = ? AND view_name = ?" if kind == "view" else "SELECT sql FROM duckdb_tables() WHERE database_name = ? AND schema_name = ? AND table_name = ?"
        r = self.rows(q, (self.catalog, schema, name))
        return (r[0][0] or "") if r else "-- definição indisponível"


class ClickHouse(SqlDriver):
    def __init__(self, cfg, db):
        super().__init__(cfg, db)
        import clickhouse_connect

        self.client = clickhouse_connect.get_client(host=cfg["host"], port=int(cfg.get("port") or 8123), username=cfg.get("user") or "default", password=cfg.get("password") or "", database=self.db or None, secure=bool(cfg.get("ssl")))

    @staticmethod
    def quote(n):
        return "`" + n.replace("`", "\\`") + "`"

    def rows(self, sql, params=None):
        return self.client.query(sql, parameters=params or None).result_rows

    def execute(self, sql):
        t0 = time.time()
        if re.match(r"^\s*(SELECT|WITH|SHOW|DESCRIBE|DESC|EXPLAIN|EXISTS)\b", sql, re.I):
            r = self.client.query(sql)
            rows = r.result_rows
            return [result(list(r.column_names), [[text(v) for v in x] for x in rows[:MAX_ROWS]], None, True, len(rows) > MAX_ROWS, t0)]
        s = self.client.command(sql)
        written = getattr(s, "written_rows", None)
        return [result([], [], int(written or 0), False, False, t0)]

    def server_info(self):
        v, u = self.rows("SELECT version(), currentUser()")[0]
        return {"version": f"ClickHouse {v}", "currentUser": u}

    def databases(self):
        return [r[0] for r in self.rows("SELECT name FROM system.databases WHERE name NOT IN ('system','INFORMATION_SCHEMA','information_schema') ORDER BY name")]

    def objects(self, schema):
        r = self.rows("SELECT name, multiIf(engine = 'View', 'view', engine = 'MaterializedView', 'matview', 'table'), comment FROM system.tables WHERE database = {d:String} ORDER BY name", {"d": schema})
        return [{"name": n, "kind": k, "comment": c or None} for n, k, c in r]

    def columns(self, schema, table):
        r = self.rows("SELECT name, type, startsWith(type, 'Nullable'), default_expression, is_in_primary_key, comment FROM system.columns WHERE database = {d:String} AND table = {t:String} ORDER BY position", {"d": schema, "t": table})
        return [col(n, t, nl, d or None, pk, c or None) for n, t, nl, d, pk, c in r]

    def indexes(self, schema, table):
        r = self.rows("SELECT primary_key, sorting_key FROM system.tables WHERE database = {d:String} AND name = {t:String}", {"d": schema, "t": table})
        out = []
        if r and r[0][0]:
            out.append({"name": "PRIMARY KEY", "columns": r[0][0], "unique": False, "primary": True})
        if r and r[0][1] and r[0][1] != r[0][0]:
            out.append({"name": "ORDER BY", "columns": r[0][1], "unique": False, "primary": False})
        return out

    def completion(self, schema):
        return group_completion(self.rows("SELECT database, table, name FROM system.columns WHERE database = {d:String} ORDER BY table, position", {"d": schema or self.db or "default"}))

    def ddl(self, schema, name, kind):
        return self.rows(f"SHOW CREATE TABLE {self.quote(schema)}.{self.quote(name)}")[0][0]


# ---------------------------------------------------------------------------------------------
# MongoDB (mongosh-style commands in the console)
# ---------------------------------------------------------------------------------------------


class Mongo:
    def __init__(self, cfg, db):
        import pymongo

        host = cfg.get("host") or "localhost"
        kw = dict(serverSelectionTimeoutMS=8000)
        if cfg.get("user"):
            kw.update(username=cfg["user"], password=cfg.get("password") or "", authSource="admin")
        if cfg.get("ssl"):
            kw["tls"] = True
        uri = host if host.startswith("mongodb") else f"mongodb://{host}:{int(cfg.get('port') or 27017)}/"
        self.client = pymongo.MongoClient(uri, **kw)
        self.client.admin.command("ping")
        self.db = db or cfg.get("database") or "test"
        from bson import json_util

        self.json_util = json_util

    def server_info(self):
        return {"version": "MongoDB " + self.client.server_info().get("version", ""), "currentUser": ""}

    def databases(self):
        return self.client.list_database_names()

    def schemas(self):
        return [self.db]

    def objects(self, schema):
        out = []
        for c in self.client[schema or self.db].list_collections():
            if c["name"].startswith("system."):
                continue
            out.append({"name": c["name"], "kind": "view" if c.get("type") == "view" else "table", "comment": None})
        return sorted(out, key=lambda o: o["name"])

    @staticmethod
    def bson_type(v):
        n = type(v).__name__
        return {"str": "string", "int": "int", "float": "double", "bool": "bool", "dict": "object", "list": "array", "datetime": "date", "NoneType": "null", "Int64": "long", "Decimal128": "decimal", "ObjectId": "objectId"}.get(n, n)

    def sample_fields(self, db, coll, n=100):
        fields = {}
        try:
            docs = list(self.client[db][coll].aggregate([{"$sample": {"size": n}}]))
        except Exception:
            docs = list(self.client[db][coll].find().limit(n))
        for d in docs:
            for k, v in d.items():
                fields.setdefault(k, set()).add(self.bson_type(v))
        if "_id" not in fields:
            fields["_id"] = {"objectId"}
        keys = ["_id"] + [k for k in fields if k != "_id"]
        return [col(k, " | ".join(sorted(fields[k])), "null" in fields[k] or len(fields[k]) == 0, None, k == "_id") for k in keys]

    def columns(self, schema, table):
        return self.sample_fields(schema or self.db, table)

    def indexes(self, schema, table):
        out = []
        for name, info in self.client[schema or self.db][table].index_information().items():
            out.append({"name": name, "columns": ", ".join(f"{k} {v}" for k, v in info.get("key", [])), "unique": bool(info.get("unique")) or name == "_id_", "primary": name == "_id_"})
        return out

    def completion(self, schema):
        db = schema or self.db
        out = []
        for o in self.objects(db)[:200]:
            try:
                cols = [c["name"] for c in self.sample_fields(db, o["name"], 20)]
            except Exception:
                cols = []
            out.append({"schema": db, "table": o["name"], "columns": cols})
        return out

    def ddl(self, schema, name, kind):
        db = self.client[schema or self.db]
        opts = db[name].options()
        lines = [f"db.createCollection({json.dumps(name)}, {self.json_util.dumps(opts, indent=2)});"]
        for iname, info in db[name].index_information().items():
            if iname == "_id_":
                continue
            keys = {k: v for k, v in info.get("key", [])}
            extra = {k: v for k, v in info.items() if k not in ("key", "v", "ns")}
            extra["name"] = iname
            lines.append(f"db.getCollection({json.dumps(name)}).createIndex({json.dumps(keys)}, {json.dumps(extra, default=str)});")
        return "\n".join(lines)

    def diagram(self, schema):
        db = schema or self.db
        tables = []
        names = [o["name"] for o in self.objects(db)]
        for n in names[:150]:
            tables.append({"name": n, "kind": "table", "columns": self.sample_fields(db, n, 50)})
        # Relations are not declared in MongoDB: infer them from "<collection>Id" / "<collection>_id" fields.
        lower = {n.lower(): n for n in names}
        fks = []
        for t in tables:
            for c in t["columns"]:
                f = c["name"]
                if f == "_id" or "objectId" not in c["dataType"]:
                    continue
                base = f[:-3] if f.lower().endswith("_id") else f[:-2] if f.endswith("Id") else None
                if not base:
                    continue
                for cand in (base, base + "s", base + "es", base[:-1] + "ies" if base.endswith("y") else None):
                    if cand and cand.lower() in lower:
                        fks.append({"name": f"{t['name']}.{f} (inferido)", "table": t["name"], "refSchema": db, "refTable": lower[cand.lower()], "columns": [f], "refColumns": ["_id"]})
                        break
        return {"tables": tables, "fks": fks}

    # ---- console ----

    def to_cell(self, v):
        if v is None:
            return None
        n = type(v).__name__
        if n in ("ObjectId", "Decimal128", "Int64"):
            return str(v)
        if isinstance(v, (dict, list)):
            return self.json_util.dumps(v, ensure_ascii=False)
        return text(v)

    def docs_result(self, docs, t0):
        docs = list(docs[: MAX_ROWS + 1]) if isinstance(docs, list) else []
        truncated = len(docs) > MAX_ROWS
        docs = docs[:MAX_ROWS]
        cols = []
        for d in docs:
            for k in (d.keys() if isinstance(d, dict) else ["value"]):
                if k not in cols:
                    cols.append(k)
        if "_id" in cols:
            cols.remove("_id")
            cols.insert(0, "_id")
        rows = [[self.to_cell(d.get(c)) if isinstance(d, dict) else self.to_cell(d) for c in cols] for d in docs]
        return result(cols, rows, None, True, truncated, t0)

    def value_result(self, v, t0, label="resultado"):
        if isinstance(v, list):
            return self.docs_result([x if isinstance(x, dict) else {label: x} for x in v], t0)
        if isinstance(v, dict):
            return self.docs_result([v], t0)
        return result([label], [[self.to_cell(v)]], None, True, False, t0)

    def parse_args(self, s):
        s = s.strip()
        if not s:
            return []
        s = re.sub(r"ObjectId\(\s*([\"'])([0-9a-fA-F]{24})\1\s*\)", r'{"$oid": "\2"}', s)
        s = re.sub(r"(?:ISODate|new\s+Date)\(\s*([\"'])([^\"']+)\1\s*\)", r'{"$date": "\2"}', s)
        s = re.sub(r"NumberLong\(\s*[\"']?(-?\d+)[\"']?\s*\)", r'{"$numberLong": "\1"}', s)
        s = re.sub(r"NumberDecimal\(\s*[\"']([^\"']+)[\"']\s*\)", r'{"$numberDecimal": "\1"}', s)
        import json5

        args = json5.loads("[" + s + "]")
        return self.json_util.loads(json.dumps(args))

    @staticmethod
    def chain(s):
        """'getCollection("x").find({a:1}).limit(5)' -> [("getCollection", '"x"'), ("find", "{a:1}"), ("limit", "5")]."""
        out, i, n = [], 0, len(s)
        while i < n:
            while i < n and s[i] in ". \n\t":
                i += 1
            m = re.match(r"[A-Za-z_$][\w$]*", s[i:])
            if not m:
                if i < n:
                    raise Exception(f"Sintaxe não reconhecida perto de: {s[i:i + 30]}")
                break
            name = m.group(0)
            i += len(name)
            while i < n and s[i] in " \t\n":
                i += 1
            if i < n and s[i] == "(":
                depth, j, quote = 0, i, None
                while j < n:
                    ch = s[j]
                    if quote:
                        if ch == "\\":
                            j += 1
                        elif ch == quote:
                            quote = None
                    elif ch in "\"'`":
                        quote = ch
                    elif ch in "([{":
                        depth += 1
                    elif ch in ")]}":
                        depth -= 1
                        if depth == 0:
                            break
                    j += 1
                out.append((name, s[i + 1 : j]))
                i = j + 1
            else:
                out.append((name, None))
        return out

    def execute(self, src):
        t0 = time.time()
        s = src.strip().rstrip(";").strip()
        if not s:
            return []
        m = re.match(r"^use\s+(\S+)$", s)
        if m:
            self.db = m.group(1)
            return [result(["resultado"], [[f"banco atual: {self.db}"]], None, True, False, t0)]
        if re.match(r"^show\s+(dbs|databases)$", s):
            return [self.value_result([{"name": n} for n in self.client.list_database_names()], t0)]
        if re.match(r"^show\s+collections$", s):
            return [self.value_result([{"name": n} for n in self.client[self.db].list_collection_names()], t0)]
        if s.startswith("{"):
            return [self.value_result(self.client[self.db].command(self.parse_args(s)[0]), t0)]
        if not s.startswith("db."):
            raise Exception("Use comandos no estilo mongosh, por exemplo: db.usuarios.find({ ativo: true }).limit(10)")
        parts = self.chain(s[3:])
        db = self.client[self.db]
        name, args = parts[0]
        rest = parts[1:]
        if name == "getCollection" and args is not None:
            coll = db[self.parse_args(args)[0]]
        elif args is None:
            coll = db[name]
        else:
            return [self.db_method(db, name, self.parse_args(args), t0)]
        if not rest:
            raise Exception("Informe um método da coleção, por exemplo .find()")
        method, margs = rest[0]
        a = self.parse_args(margs or "")
        mods = rest[1:]
        if method == "find":
            cur = coll.find(a[0] if a else {}, a[1] if len(a) > 1 else None)
            limit = 200
            for mname, marg in mods:
                v = self.parse_args(marg or "")
                if mname == "sort":
                    cur = cur.sort(list(v[0].items()))
                elif mname == "skip":
                    cur = cur.skip(int(v[0]))
                elif mname == "limit":
                    limit = int(v[0])
                elif mname in ("project", "projection"):
                    pass
                elif mname in ("toArray", "pretty"):
                    pass
                elif mname == "count" or mname == "itcount":
                    return [self.value_result(coll.count_documents(a[0] if a else {}), t0, "count")]
                else:
                    raise Exception(f"Modificador não suportado: {mname}")
            return [self.docs_result(list(cur.limit(min(limit, MAX_ROWS + 1) if limit else MAX_ROWS + 1)), t0)]
        if method == "findOne":
            d = coll.find_one(a[0] if a else {}, a[1] if len(a) > 1 else None)
            return [self.docs_result([d] if d else [], t0)]
        if method == "aggregate":
            return [self.docs_result(list(coll.aggregate(a[0] if a else [])), t0)]
        if method in ("countDocuments", "count"):
            return [self.value_result(coll.count_documents(a[0] if a else {}), t0, "count")]
        if method == "estimatedDocumentCount":
            return [self.value_result(coll.estimated_document_count(), t0, "count")]
        if method == "distinct":
            return [self.value_result([{a[0]: v} for v in coll.distinct(a[0], a[1] if len(a) > 1 else None)], t0)]
        if method == "insertOne":
            r = coll.insert_one(a[0])
            return [self.value_result({"insertedId": r.inserted_id}, t0)]
        if method == "insertMany":
            r = coll.insert_many(a[0])
            return [result([], [], len(r.inserted_ids), False, False, t0)]
        if method in ("updateOne", "updateMany", "replaceOne"):
            fn = {"updateOne": coll.update_one, "updateMany": coll.update_many, "replaceOne": coll.replace_one}[method]
            r = fn(a[0], a[1], **(a[2] if len(a) > 2 else {}))
            return [result([], [], r.modified_count, False, False, t0)]
        if method in ("deleteOne", "deleteMany"):
            r = (coll.delete_one if method == "deleteOne" else coll.delete_many)(a[0] if a else {})
            return [result([], [], r.deleted_count, False, False, t0)]
        if method == "drop":
            coll.drop()
            return [result([], [], 0, False, False, t0)]
        if method == "createIndex":
            name = coll.create_index(list(a[0].items()), **(a[1] if len(a) > 1 else {}))
            return [self.value_result({"index": name}, t0)]
        if method == "dropIndex":
            coll.drop_index(a[0])
            return [result([], [], 0, False, False, t0)]
        if method in ("getIndexes", "indexes"):
            return [self.value_result([dict(v, name=k) for k, v in coll.index_information().items()], t0)]
        raise Exception(f"Método não suportado: {method}")

    def db_method(self, db, name, a, t0):
        if name in ("runCommand", "command", "adminCommand"):
            target = self.client.admin if name == "adminCommand" else db
            return self.value_result(target.command(a[0]), t0)
        if name == "getCollectionNames":
            return self.value_result([{"name": n} for n in db.list_collection_names()], t0)
        if name == "createCollection":
            db.create_collection(a[0], **(a[1] if len(a) > 1 else {}))
            return result([], [], 0, False, False, t0)
        if name == "dropDatabase":
            self.client.drop_database(db.name)
            return result([], [], 0, False, False, t0)
        if name == "stats":
            return self.value_result(db.command("dbstats"), t0)
        raise Exception(f"Comando não suportado: db.{name}()")


DRIVERS = {"sqlserver": SqlServer, "oracle": Oracle, "firebird": Firebird, "sqlite": Sqlite, "duckdb": DuckDb, "clickhouse": ClickHouse, "mongodb": Mongo}


def main():
    drv = None
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        rid = req.get("id")
        try:
            op = req.get("op")
            if op == "open":
                cfg = req["cfg"]
                cls = DRIVERS.get(cfg.get("kind"))
                if not cls:
                    raise Exception(f"Banco não suportado: {cfg.get('kind')}")
                drv = cls(cfg, req.get("db") or "")
                res = True
            elif drv is None:
                raise Exception("conexão não aberta")
            elif op == "execute":
                res = drv.execute(req["sql"])
            elif op in ("objects", "completion", "diagram"):
                res = getattr(drv, op)(req.get("schema") or "")
            elif op in ("columns", "indexes"):
                res = getattr(drv, op)(req.get("schema") or "", req["table"])
            elif op == "ddl":
                res = drv.ddl(req.get("schema") or "", req["name"], req.get("kind") or "table")
            elif op in ("server_info", "databases", "schemas"):
                res = getattr(drv, op)()
            else:
                raise Exception(f"operação desconhecida: {op}")
            out = {"id": rid, "ok": True, "result": res}
        except Unsupported:
            out = {"id": rid, "ok": False, "error": "Operação não suportada por este banco"}
        except Exception as e:
            msg = str(e).strip() or type(e).__name__
            if not isinstance(e, (ValueError, KeyError)) and "Traceback" not in msg and len(msg) < 4:
                msg += "\n" + traceback.format_exc(limit=2)
            out = {"id": rid, "ok": False, "error": msg}
        sys.stdout.write(json.dumps(out, default=str, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
