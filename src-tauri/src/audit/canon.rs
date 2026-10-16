//! Deterministic canonical values for the Migration Audit.
//!
//! Every value read from a database (as text, see the adapters) is turned into a typed canonical
//! value according to its logical type and to the explicit rules of the field. Nothing semantic is
//! changed by default: no trimming, no case folding, no accent removal, NULL is never 0 or "",
//! leading zeros are kept, decimals never go through floating point. Values that cannot be read as
//! their type become `Invalid` (reported, never silently converted).
//!
//! The binary encoding is `tag | u32 length (BE) | bytes`, so concatenating values can never make
//! two different tuples collide ("ab"+"c" vs "a"+"bc"), and NULL has its own tag.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

/// Logical type (normalized from each database's native type).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum LType {
    Int,
    Decimal,
    Float,
    Text,
    /// Fixed-length CHAR(n): trailing pad spaces are not part of the value.
    Char,
    Bool,
    Date,
    Time,
    Timestamp,
    Timestamptz,
    Uuid,
    Json,
    Binary,
    Other,
}

impl LType {
    pub fn label(&self) -> &'static str {
        match self {
            LType::Int => "inteiro",
            LType::Decimal => "decimal",
            LType::Float => "ponto flutuante",
            LType::Text => "texto",
            LType::Char => "texto fixo",
            LType::Bool => "booleano",
            LType::Date => "data",
            LType::Time => "hora",
            LType::Timestamp => "data/hora",
            LType::Timestamptz => "data/hora com fuso",
            LType::Uuid => "uuid",
            LType::Json => "json",
            LType::Binary => "binário",
            LType::Other => "outro",
        }
    }
    pub fn is_textual(&self) -> bool {
        matches!(self, LType::Text | LType::Char)
    }
    pub fn is_numeric(&self) -> bool {
        matches!(self, LType::Int | LType::Decimal | LType::Float)
    }
    pub fn is_temporal(&self) -> bool {
        matches!(self, LType::Date | LType::Timestamp | LType::Timestamptz | LType::Time)
    }
}

/// Maps a native type name to a logical type. `dialect`: postgres | mysql | sqlserver | firebird.
pub fn logical_type(dialect: &str, native: &str) -> LType {
    let t = native.trim().to_lowercase();
    let base = t.split(['(', ' ']).next().unwrap_or("").to_string();
    let has = |s: &str| t.contains(s);
    if dialect == "mysql" && (t.starts_with("tinyint(1)") || base == "bit" && has("(1)")) {
        return LType::Bool;
    }
    match base.as_str() {
        "smallint" | "integer" | "int" | "int2" | "int4" | "int8" | "bigint" | "tinyint" | "mediumint" | "serial" | "bigserial" | "smallserial" | "int128" => LType::Int,
        "numeric" | "decimal" | "money" | "smallmoney" | "number" | "dec" | "decfloat" => LType::Decimal,
        "real" | "float" | "float4" | "float8" | "double" => LType::Float,
        "boolean" | "bool" => LType::Bool,
        "bit" if dialect == "sqlserver" => LType::Bool,
        "char" | "character" | "nchar" | "bpchar" if !has("varying") => LType::Char,
        "varchar" | "character" | "text" | "nvarchar" | "ntext" | "tinytext" | "mediumtext" | "longtext" | "citext" | "name" | "string" | "enum" | "set" | "xml" | "sysname" | "varchar2" | "nvarchar2" | "clob" => LType::Text,
        "blob" if dialect == "firebird" && has("text") => LType::Text,
        "date" => LType::Date,
        "time" if has("with time zone") => LType::Other,
        "time" | "timetz" => LType::Time,
        "timestamp" if has("with time zone") => LType::Timestamptz,
        "timestamptz" | "datetimeoffset" => LType::Timestamptz,
        // MySQL TIMESTAMP is stored in UTC and read in the session time zone (the adapter sets UTC)
        "timestamp" | "datetime" | "datetime2" | "smalldatetime" => LType::Timestamp,
        "uuid" | "uniqueidentifier" => LType::Uuid,
        "json" | "jsonb" => LType::Json,
        "bytea" | "binary" | "varbinary" | "blob" | "tinyblob" | "mediumblob" | "longblob" | "image" | "rowversion" => LType::Binary,
        _ if t.starts_with("double precision") => LType::Float,
        _ if t.starts_with("character varying") => LType::Text,
        _ => LType::Other,
    }
}

/// Explicit, versioned normalization rules of one field (or key column). Defaults change nothing.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Rules {
    pub trim: bool,
    pub case_insensitive: bool,
    pub unicode_nfc: bool,
    pub remove_accents: bool,
    /// Remove punctuation/spaces (document numbers, codes). Leading zeros are kept.
    pub strip_punct: bool,
    pub empty_is_null: bool,
    /// Raw values treated as NULL on the given side (sentinels such as "1900-01-01").
    pub null_sentinels: Vec<String>,
    pub sentinel_side: Side,
    /// Value mapping applied to the source side (enumerations, codes).
    pub enum_map: Vec<(String, String)>,
    /// Boolean spellings (e.g. ["S","1"] / ["N","0"]), applied to both sides.
    pub true_values: Vec<String>,
    pub false_values: Vec<String>,
    /// Parse text as a date/timestamp with a format (YYYY MM DD HH mm ss f) on a side.
    pub date_format: String,
    pub date_format_side: Side,
    /// Compare only the date part (must be explicitly authorized).
    pub date_only: bool,
    /// Fractional second digits kept (0..9); truncation, recorded as a rule.
    pub ts_precision: Option<u8>,
    /// Offset (e.g. "-03:00") of naive timestamps on a side, to compare with zoned values in UTC.
    pub naive_offset_source: String,
    pub naive_offset_target: String,
    /// Round decimals to this scale (half up) before comparing.
    pub decimal_scale: Option<u8>,
    /// Tolerances (decimal strings); need stored values to be applied.
    pub tol_abs: String,
    pub tol_rel: String,
    pub json_canonical: bool,
    /// Compare the value as another type: "text" or "number".
    pub compare_as: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    #[default]
    Both,
    Source,
    Target,
}

impl Side {
    fn applies(&self, s: Side) -> bool {
        *self == Side::Both || *self == s
    }
}

impl Rules {
    pub fn is_default(&self) -> bool {
        *self == Rules::default()
    }
    /// Short description for reports.
    pub fn describe(&self) -> Vec<String> {
        let mut v = vec![];
        if self.trim {
            v.push("remover espaços nas pontas".into());
        }
        if self.case_insensitive {
            v.push("ignorar maiúsculas/minúsculas".into());
        }
        if self.unicode_nfc {
            v.push("normalização Unicode NFC".into());
        }
        if self.remove_accents {
            v.push("ignorar acentos".into());
        }
        if self.strip_punct {
            v.push("remover pontuação".into());
        }
        if self.empty_is_null {
            v.push("texto vazio = nulo".into());
        }
        if !self.null_sentinels.is_empty() {
            v.push(format!("sentinelas como nulo: {}", self.null_sentinels.join(", ")));
        }
        if !self.enum_map.is_empty() {
            v.push(format!("mapa de valores ({} entradas)", self.enum_map.len()));
        }
        if !self.true_values.is_empty() || !self.false_values.is_empty() {
            v.push("conversão de booleanos".into());
        }
        if !self.date_format.is_empty() {
            v.push(format!("data em texto no formato {}", self.date_format));
        }
        if self.date_only {
            v.push("comparar somente a data".into());
        }
        if let Some(p) = self.ts_precision {
            v.push(format!("precisão de {p} dígitos de segundo"));
        }
        if !self.naive_offset_source.is_empty() {
            v.push(format!("data/hora sem fuso da origem em {}", self.naive_offset_source));
        }
        if !self.naive_offset_target.is_empty() {
            v.push(format!("data/hora sem fuso do destino em {}", self.naive_offset_target));
        }
        if let Some(s) = self.decimal_scale {
            v.push(format!("arredondar para {s} casas"));
        }
        if !self.tol_abs.is_empty() {
            v.push(format!("tolerância absoluta {}", self.tol_abs));
        }
        if !self.tol_rel.is_empty() {
            v.push(format!("tolerância relativa {}", self.tol_rel));
        }
        if self.json_canonical {
            v.push("JSON canônico".into());
        }
        if !self.compare_as.is_empty() {
            v.push(format!("comparar como {}", self.compare_as));
        }
        v
    }
}

/// Canonical value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum CVal {
    Null,
    Text(String),
    /// Normalized decimal string (no exponent, no trailing fractional zeros, no "-0").
    Num(String),
    Float(String),
    Bool(bool),
    Date(String),
    Time(String),
    Ts(String),
    /// UTC instant, "...Z".
    TsTz(String),
    Uuid(String),
    Json(String),
    Bin(String),
    /// Value that could not be read as its type (reason, raw).
    Invalid(String, String),
}

impl CVal {
    pub fn tag(&self) -> u8 {
        match self {
            CVal::Null => b'N',
            CVal::Text(_) => b't',
            CVal::Num(_) => b'n',
            CVal::Float(_) => b'f',
            CVal::Bool(_) => b'b',
            CVal::Date(_) => b'd',
            CVal::Time(_) => b'h',
            CVal::Ts(_) => b's',
            CVal::TsTz(_) => b'z',
            CVal::Uuid(_) => b'u',
            CVal::Json(_) => b'j',
            CVal::Bin(_) => b'x',
            CVal::Invalid(..) => b'!',
        }
    }
    pub fn text(&self) -> String {
        match self {
            CVal::Null => String::new(),
            CVal::Bool(b) => if *b { "true".into() } else { "false".into() },
            CVal::Invalid(_, raw) => raw.clone(),
            CVal::Text(s) | CVal::Num(s) | CVal::Float(s) | CVal::Date(s) | CVal::Time(s) | CVal::Ts(s) | CVal::TsTz(s) | CVal::Uuid(s) | CVal::Json(s) | CVal::Bin(s) => s.clone(),
        }
    }
    pub fn is_null(&self) -> bool {
        matches!(self, CVal::Null)
    }
    pub fn encode(&self, out: &mut Vec<u8>) {
        out.push(self.tag());
        let s = match self {
            CVal::Invalid(reason, raw) => format!("{reason}\u{0}{raw}"),
            other => other.text(),
        };
        out.extend_from_slice(&(s.len() as u32).to_be_bytes());
        out.extend_from_slice(s.as_bytes());
    }
    pub fn decode(b: &[u8]) -> Result<(CVal, usize), String> {
        if b.len() < 5 {
            return Err("valor canônico truncado".into());
        }
        let n = u32::from_be_bytes([b[1], b[2], b[3], b[4]]) as usize;
        let s = std::str::from_utf8(b.get(5..5 + n).ok_or("valor canônico truncado")?).map_err(|e| e.to_string())?.to_string();
        let v = match b[0] {
            b'N' => CVal::Null,
            b't' => CVal::Text(s),
            b'n' => CVal::Num(s),
            b'f' => CVal::Float(s),
            b'b' => CVal::Bool(s == "true"),
            b'd' => CVal::Date(s),
            b'h' => CVal::Time(s),
            b's' => CVal::Ts(s),
            b'z' => CVal::TsTz(s),
            b'u' => CVal::Uuid(s),
            b'j' => CVal::Json(s),
            b'x' => CVal::Bin(s),
            b'!' => {
                let (r, raw) = s.split_once('\u{0}').unwrap_or((&s, ""));
                CVal::Invalid(r.into(), raw.into())
            }
            t => return Err(format!("marcador desconhecido {t}")),
        };
        Ok((v, 5 + n))
    }
}

pub fn encode_all(vals: &[CVal]) -> Vec<u8> {
    let mut out = Vec::with_capacity(vals.len() * 12);
    for v in vals {
        v.encode(&mut out);
    }
    out
}

pub fn decode_all(mut b: &[u8]) -> Result<Vec<CVal>, String> {
    let mut v = vec![];
    while !b.is_empty() {
        let (x, n) = CVal::decode(b)?;
        v.push(x);
        b = &b[n..];
    }
    Ok(v)
}

/// 128-bit truncated SHA-256 (hex) of bytes. Detects differences; it is not proof of identity and
/// not anonymization (low-entropy values can be guessed).
pub fn digest(bytes: &[u8]) -> String {
    let h = Sha256::digest(bytes);
    h[..16].iter().map(|b| format!("{b:02x}")).collect()
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn unhex(s: &str) -> Result<Vec<u8>, String> {
    if s.len() % 2 != 0 {
        return Err("hex inválido".into());
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|e| e.to_string())).collect()
}

// ---------------- decimals (exact, no floating point) ----------------

/// Normalizes a decimal literal: "+001.2300" -> "1.23", "-0.0" -> "0", "1.5E+3" -> "1500".
pub fn norm_decimal(s: &str) -> Option<String> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let (neg, rest) = match s.as_bytes()[0] {
        b'-' => (true, &s[1..]),
        b'+' => (false, &s[1..]),
        _ => (false, s),
    };
    let (mant, exp) = match rest.find(['e', 'E']) {
        Some(i) => (&rest[..i], rest[i + 1..].parse::<i64>().ok()?),
        None => (rest, 0),
    };
    let (ip, fp) = mant.split_once('.').unwrap_or((mant, ""));
    if ip.is_empty() && fp.is_empty() || !ip.bytes().all(|c| c.is_ascii_digit()) || !fp.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    if exp.abs() > 400 {
        return None;
    }
    let mut digits: String = format!("{ip}{fp}");
    let mut point = ip.len() as i64 + exp;
    if point < 0 {
        digits = "0".repeat((-point) as usize) + &digits;
        point = 0;
    }
    while (digits.len() as i64) < point {
        digits.push('0');
    }
    let (i, f) = digits.split_at(point as usize);
    let i = i.trim_start_matches('0');
    let f = f.trim_end_matches('0');
    let i = if i.is_empty() { "0" } else { i };
    let out = if f.is_empty() { i.to_string() } else { format!("{i}.{f}") };
    Some(if neg && out != "0" { format!("-{out}") } else { out })
}

/// Rounds a normalized decimal to `scale` digits (half up, away from zero).
pub fn round_decimal(n: &str, scale: u8) -> String {
    let (neg, abs) = n.strip_prefix('-').map(|a| (true, a)).unwrap_or((false, n));
    let (ip, fp) = abs.split_once('.').unwrap_or((abs, ""));
    if fp.len() <= scale as usize {
        return n.to_string();
    }
    let keep = &fp[..scale as usize];
    let next = fp.as_bytes()[scale as usize];
    let mut digits: Vec<u8> = format!("{ip}{keep}").into_bytes();
    if next >= b'5' {
        let mut i = digits.len();
        loop {
            if i == 0 {
                digits.insert(0, b'1');
                break;
            }
            i -= 1;
            if digits[i] == b'9' {
                digits[i] = b'0';
            } else {
                digits[i] += 1;
                break;
            }
        }
    }
    let s = String::from_utf8(digits).unwrap_or_default();
    let (i, f) = s.split_at(s.len() - scale as usize);
    let lit = if f.is_empty() { i.to_string() } else { format!("{i}.{f}") };
    norm_decimal(&format!("{}{lit}", if neg { "-" } else { "" })).unwrap_or(lit)
}

/// (scaled integer, scale) when it fits in i128 (up to 36 significant digits).
fn to_scaled(n: &str, scale: usize) -> Option<i128> {
    let (neg, abs) = n.strip_prefix('-').map(|a| (true, a)).unwrap_or((false, n));
    let (ip, fp) = abs.split_once('.').unwrap_or((abs, ""));
    if fp.len() > scale || ip.len() + scale > 36 {
        return None;
    }
    let s = format!("{ip}{fp}{}", "0".repeat(scale - fp.len()));
    let v: i128 = s.parse().ok()?;
    Some(if neg { -v } else { v })
}

fn frac_len(n: &str) -> usize {
    n.split_once('.').map(|(_, f)| f.len()).unwrap_or(0)
}

/// Whether |a-b| <= abs or |a-b| <= rel*|a|, computed exactly. None = cannot be computed exactly.
pub fn within_tolerance(a: &str, b: &str, abs: &str, rel: &str) -> Option<bool> {
    let abs = if abs.is_empty() { None } else { Some(norm_decimal(abs)?) };
    let rel = if rel.is_empty() { None } else { Some(norm_decimal(rel)?) };
    let scale = [a, b, abs.as_deref().unwrap_or("0")].iter().map(|x| frac_len(x)).max()?;
    let (x, y) = (to_scaled(a, scale)?, to_scaled(b, scale)?);
    let diff = (x - y).abs();
    if let Some(t) = abs {
        if diff <= to_scaled(&t, scale)? {
            return Some(true);
        }
    }
    if let Some(r) = rel {
        let rs = frac_len(&r);
        // diff <= r * |x|  <=>  diff * 10^rs <= r_scaled * |x|
        let rv = to_scaled(&r, rs)?;
        let lhs = diff.checked_mul(10i128.checked_pow(rs as u32)?)?;
        let rhs = rv.checked_mul(x.abs())?;
        if lhs <= rhs {
            return Some(true);
        }
    }
    Some(false)
}

// ---------------- dates and times ----------------

pub fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn days_in_month(y: i64, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        2 => 28,
        _ => 0,
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Dt {
    pub y: i64,
    pub mo: u32,
    pub d: u32,
    pub h: u32,
    pub mi: u32,
    pub s: u32,
    pub nanos: u32,
    /// Offset east of UTC in seconds, when the text had one.
    pub off: Option<i32>,
    pub has_time: bool,
}

fn num(s: &str, min: usize, max: usize) -> Option<u32> {
    if s.len() < min || s.len() > max || !s.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

fn parse_offset(s: &str) -> Option<i32> {
    if s == "Z" || s == "z" {
        return Some(0);
    }
    let (sign, rest) = match s.as_bytes().first()? {
        b'+' => (1, &s[1..]),
        b'-' => (-1, &s[1..]),
        _ => return None,
    };
    let (h, m) = if let Some((h, m)) = rest.split_once(':') {
        (num(h, 1, 2)?, num(m, 2, 2)?)
    } else if rest.len() == 4 {
        (num(&rest[..2], 2, 2)?, num(&rest[2..], 2, 2)?)
    } else {
        (num(rest, 1, 2)?, 0)
    };
    if h > 15 || m > 59 {
        return None;
    }
    Some(sign * (h as i32 * 3600 + m as i32 * 60))
}

fn valid(dt: &Dt) -> bool {
    (1..=12).contains(&dt.mo) && dt.d >= 1 && dt.d <= days_in_month(dt.y, dt.mo) && dt.h < 24 && dt.mi < 60 && dt.s < 61 && dt.y >= 1 && dt.y <= 9999
}

fn parse_time_part(t: &str, dt: &mut Dt) -> Option<()> {
    // HH:MM[:SS[.fffffffff]] followed by an optional offset
    let off_at = t.char_indices().skip(5).find(|(_, c)| *c == '+' || *c == '-' || *c == 'Z' || *c == 'z').map(|(i, _)| i);
    let (clock, off) = match off_at {
        Some(i) => (&t[..i], Some(t[i..].trim())),
        None => (t, None),
    };
    let clock = clock.trim();
    let mut parts = clock.splitn(3, ':');
    dt.h = num(parts.next()?, 1, 2)?;
    dt.mi = num(parts.next()?, 2, 2)?;
    if let Some(sec) = parts.next() {
        let (s, f) = sec.split_once(['.', ',']).unwrap_or((sec, ""));
        dt.s = num(s, 2, 2)?;
        if !f.is_empty() {
            if f.len() > 9 || !f.bytes().all(|c| c.is_ascii_digit()) {
                return None;
            }
            dt.nanos = format!("{f:0<9}").parse().ok()?;
        }
    }
    if let Some(o) = off {
        dt.off = Some(parse_offset(o)?);
    }
    dt.has_time = true;
    Some(())
}

/// ISO-like text: "YYYY-MM-DD", "YYYY-MM-DD HH:MM:SS.ffffff", "...T...", with optional offset.
pub fn parse_iso(s: &str) -> Option<Dt> {
    let s = s.trim();
    let (date, time) = match s.find(['T', ' ']) {
        Some(i) if i == 10 => (&s[..10], Some(&s[11..])),
        _ => (s, None),
    };
    let mut p = date.splitn(3, '-');
    let mut dt = Dt { y: num(p.next()?, 4, 4)? as i64, mo: num(p.next()?, 2, 2)?, d: num(p.next()?, 2, 2)?, h: 0, mi: 0, s: 0, nanos: 0, off: None, has_time: false };
    if let Some(t) = time {
        parse_time_part(t.trim(), &mut dt)?;
    }
    valid(&dt).then_some(dt)
}

/// Text with an explicit format: tokens YYYY, MM, DD, HH, mm, ss, f (fraction); others literal.
pub fn parse_with_format(s: &str, fmt: &str) -> Option<Dt> {
    let s = s.trim();
    let mut dt = Dt { y: 0, mo: 1, d: 1, h: 0, mi: 0, s: 0, nanos: 0, off: None, has_time: false };
    let (mut i, mut j) = (0usize, 0usize);
    let fb = fmt.as_bytes();
    let sb = s.as_bytes();
    let take = |j: &mut usize, n: usize| -> Option<u32> {
        let v = num(s.get(*j..*j + n)?, n, n)?;
        *j += n;
        Some(v)
    };
    while i < fb.len() {
        let rest = &fmt[i..];
        if rest.starts_with("YYYY") {
            dt.y = take(&mut j, 4)? as i64;
            i += 4;
        } else if rest.starts_with("MM") {
            dt.mo = take(&mut j, 2)?;
            i += 2;
        } else if rest.starts_with("DD") {
            dt.d = take(&mut j, 2)?;
            i += 2;
        } else if rest.starts_with("HH") {
            dt.h = take(&mut j, 2)?;
            dt.has_time = true;
            i += 2;
        } else if rest.starts_with("mm") {
            dt.mi = take(&mut j, 2)?;
            i += 2;
        } else if rest.starts_with("ss") {
            dt.s = take(&mut j, 2)?;
            i += 2;
        } else if rest.starts_with('f') {
            let start = j;
            while j < sb.len() && sb[j].is_ascii_digit() && j - start < 9 {
                j += 1;
            }
            if j == start {
                return None;
            }
            dt.nanos = format!("{:0<9}", &s[start..j]).parse().ok()?;
            i += 1;
        } else {
            if sb.get(j) != Some(&fb[i]) {
                return None;
            }
            i += 1;
            j += 1;
        }
    }
    (j == sb.len() && valid(&dt)).then_some(dt)
}

fn fmt_date(dt: &Dt) -> String {
    format!("{:04}-{:02}-{:02}", dt.y, dt.mo, dt.d)
}

fn fmt_ts(dt: &Dt, digits: u8) -> String {
    let base = format!("{}T{:02}:{:02}:{:02}", fmt_date(dt), dt.h, dt.mi, dt.s);
    if digits == 0 {
        return base;
    }
    let f = format!("{:09}", dt.nanos);
    format!("{base}.{}", &f[..digits as usize])
}

/// Shifts to UTC using the offset.
fn to_utc(dt: &Dt, off: i32) -> Dt {
    let days = days_from_civil(dt.y, dt.mo, dt.d);
    let secs = days * 86_400 + dt.h as i64 * 3600 + dt.mi as i64 * 60 + dt.s as i64 - off as i64;
    let (d2, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let (y, mo, d) = crate::jupyter::proto::civil_from_days(d2);
    Dt { y, mo, d, h: (rem / 3600) as u32, mi: ((rem % 3600) / 60) as u32, s: (rem % 60) as u32, nanos: dt.nanos, off: Some(0), has_time: true }
}

fn truncate_nanos(n: u32, digits: u8) -> u32 {
    let p = 10u32.pow(9 - digits.min(9) as u32);
    n / p * p
}

// ---------------- text helpers ----------------

fn strip_accents(s: &str) -> String {
    s.nfd().filter(|c| !unicode_normalization::char::is_combining_mark(*c)).collect()
}

fn text_rules(mut s: String, r: &Rules) -> String {
    if r.unicode_nfc {
        s = s.nfc().collect();
    }
    if r.remove_accents {
        s = strip_accents(&s).nfc().collect();
    }
    if r.trim {
        s = s.trim().to_string();
    }
    if r.strip_punct {
        s = s.chars().filter(|c| c.is_alphanumeric()).collect();
    }
    if r.case_insensitive {
        s = s.to_lowercase();
    }
    s
}

/// Minimal JSON canonicalizer: objects with sorted keys, no whitespace, numbers kept exact
/// (normalized as decimals), strings re-escaped consistently.
pub fn canonical_json(s: &str) -> Option<String> {
    struct P<'a> {
        b: &'a [u8],
        i: usize,
    }
    impl P<'_> {
        fn ws(&mut self) {
            while self.i < self.b.len() && (self.b[self.i] as char).is_ascii_whitespace() {
                self.i += 1;
            }
        }
        fn val(&mut self, out: &mut String, depth: u32) -> Option<()> {
            if depth > 200 {
                return None;
            }
            self.ws();
            match *self.b.get(self.i)? {
                b'{' => {
                    self.i += 1;
                    let mut items: Vec<(String, String)> = vec![];
                    loop {
                        self.ws();
                        if self.b.get(self.i) == Some(&b'}') {
                            self.i += 1;
                            break;
                        }
                        let k = self.string()?;
                        self.ws();
                        if self.b.get(self.i) != Some(&b':') {
                            return None;
                        }
                        self.i += 1;
                        let mut v = String::new();
                        self.val(&mut v, depth + 1)?;
                        items.push((k, v));
                        self.ws();
                        match self.b.get(self.i)? {
                            b',' => self.i += 1,
                            b'}' => {
                                self.i += 1;
                                break;
                            }
                            _ => return None,
                        }
                    }
                    items.sort_by(|a, b| a.0.cmp(&b.0));
                    out.push('{');
                    for (n, (k, v)) in items.iter().enumerate() {
                        if n > 0 {
                            out.push(',');
                        }
                        out.push_str(&serde_json::to_string(k).ok()?);
                        out.push(':');
                        out.push_str(v);
                    }
                    out.push('}');
                }
                b'[' => {
                    self.i += 1;
                    out.push('[');
                    let mut first = true;
                    loop {
                        self.ws();
                        if self.b.get(self.i) == Some(&b']') {
                            self.i += 1;
                            break;
                        }
                        if !first {
                            out.push(',');
                        }
                        first = false;
                        self.val(out, depth + 1)?;
                        self.ws();
                        match self.b.get(self.i)? {
                            b',' => self.i += 1,
                            b']' => {
                                self.i += 1;
                                break;
                            }
                            _ => return None,
                        }
                    }
                    out.push(']');
                }
                b'"' => {
                    let s = self.string()?;
                    out.push_str(&serde_json::to_string(&s).ok()?);
                }
                b't' if self.b[self.i..].starts_with(b"true") => {
                    self.i += 4;
                    out.push_str("true");
                }
                b'f' if self.b[self.i..].starts_with(b"false") => {
                    self.i += 5;
                    out.push_str("false");
                }
                b'n' if self.b[self.i..].starts_with(b"null") => {
                    self.i += 4;
                    out.push_str("null");
                }
                _ => {
                    let st = self.i;
                    while self.i < self.b.len() && (self.b[self.i].is_ascii_digit() || b"+-.eE".contains(&self.b[self.i])) {
                        self.i += 1;
                    }
                    out.push_str(&norm_decimal(std::str::from_utf8(&self.b[st..self.i]).ok()?)?);
                }
            }
            Some(())
        }
        fn string(&mut self) -> Option<String> {
            if self.b.get(self.i) != Some(&b'"') {
                return None;
            }
            let st = self.i;
            self.i += 1;
            while self.i < self.b.len() {
                match self.b[self.i] {
                    b'\\' => self.i += 2,
                    b'"' => {
                        self.i += 1;
                        return serde_json::from_slice::<String>(&self.b[st..self.i]).ok();
                    }
                    _ => self.i += 1,
                }
            }
            None
        }
    }
    let mut p = P { b: s.as_bytes(), i: 0 };
    let mut out = String::new();
    p.val(&mut out, 0)?;
    p.ws();
    (p.i == p.b.len()).then_some(out)
}

/// Canonical value of a raw text value read from a column of logical type `lt` on `side`.
pub fn canon(lt: LType, raw: Option<&str>, r: &Rules, side: Side) -> CVal {
    let Some(raw) = raw else { return CVal::Null };
    if r.sentinel_side.applies(side) && r.null_sentinels.iter().any(|s| s == raw) {
        return CVal::Null;
    }
    let mut lt = lt;
    let mut raw: String = raw.to_string();
    if lt == LType::Char {
        raw = raw.trim_end_matches(' ').to_string();
    }
    if side == Side::Source && !r.enum_map.is_empty() {
        if let Some((_, to)) = r.enum_map.iter().find(|(f, _)| *f == raw) {
            raw = to.clone();
        }
    }
    if !r.true_values.is_empty() || !r.false_values.is_empty() {
        let t = raw.trim();
        if r.true_values.iter().any(|x| x == t) {
            return CVal::Bool(true);
        }
        if r.false_values.iter().any(|x| x == t) {
            return CVal::Bool(false);
        }
        if lt.is_textual() {
            return CVal::Invalid("valor booleano não reconhecido".into(), raw);
        }
    }
    match r.compare_as.as_str() {
        "text" => lt = LType::Text,
        "number" => lt = LType::Decimal,
        _ => {}
    }
    // explicit date format on textual values
    if !r.date_format.is_empty() && r.date_format_side.applies(side) && (lt.is_textual() || lt == LType::Other) {
        if raw.trim().is_empty() && r.empty_is_null {
            return CVal::Null;
        }
        return match parse_with_format(&raw, &r.date_format) {
            Some(dt) => temporal(dt, if dt.has_time { LType::Timestamp } else { LType::Date }, r, side),
            None => CVal::Invalid(format!("data fora do formato {}", r.date_format), raw),
        };
    }
    match lt {
        LType::Text | LType::Char | LType::Other => {
            let s = text_rules(raw, r);
            if r.empty_is_null && s.trim().is_empty() {
                return CVal::Null;
            }
            CVal::Text(s)
        }
        LType::Int | LType::Decimal => {
            let t = if r.strip_punct { raw.chars().filter(|c| c.is_ascii_digit() || *c == '.' || *c == '-').collect() } else { raw.trim().to_string() };
            if t.is_empty() && r.empty_is_null {
                return CVal::Null;
            }
            match norm_decimal(&t) {
                Some(n) => CVal::Num(match r.decimal_scale {
                    Some(sc) => round_decimal(&n, sc),
                    None => n,
                }),
                None => CVal::Invalid("número inválido".into(), raw),
            }
        }
        LType::Float => match raw.trim().parse::<f64>() {
            Ok(f) if f.is_nan() => CVal::Float("NaN".into()),
            Ok(f) => {
                let f = if f == 0.0 { 0.0 } else { f };
                CVal::Float(format!("{f}"))
            }
            Err(_) => CVal::Invalid("número inválido".into(), raw),
        },
        LType::Bool => match raw.trim().to_lowercase().as_str() {
            "t" | "true" | "1" | "y" | "yes" | "on" => CVal::Bool(true),
            "f" | "false" | "0" | "n" | "no" | "off" => CVal::Bool(false),
            _ => CVal::Invalid("booleano inválido".into(), raw),
        },
        LType::Date | LType::Timestamp | LType::Timestamptz => {
            let t = raw.trim();
            if t.starts_with("0000-00-00") {
                return CVal::Invalid("data zero (0000-00-00)".into(), raw);
            }
            match parse_iso(t) {
                Some(dt) => temporal(dt, lt, r, side),
                None => CVal::Invalid("data/hora inválida ou fora do intervalo 0001–9999".into(), raw),
            }
        }
        LType::Time => {
            let mut dt = Dt { y: 2000, mo: 1, d: 1, h: 0, mi: 0, s: 0, nanos: 0, off: None, has_time: false };
            if parse_time_part(raw.trim(), &mut dt).is_none() || dt.h > 23 {
                return CVal::Invalid("hora inválida".into(), raw);
            }
            let n = r.ts_precision.map(|p| truncate_nanos(dt.nanos, p)).unwrap_or(dt.nanos);
            CVal::Time(format!("{:02}:{:02}:{:02}.{:09}", dt.h, dt.mi, dt.s, n))
        }
        LType::Uuid => {
            let h: String = raw.chars().filter(|c| *c != '-' && *c != '{' && *c != '}').collect::<String>().to_lowercase();
            if h.len() != 32 || !h.chars().all(|c| c.is_ascii_hexdigit()) {
                return CVal::Invalid("uuid inválido".into(), raw);
            }
            CVal::Uuid(format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32]))
        }
        LType::Json => {
            if r.json_canonical {
                match canonical_json(&raw) {
                    Some(j) => CVal::Json(j),
                    None => CVal::Invalid("JSON inválido".into(), raw),
                }
            } else {
                CVal::Json(raw)
            }
        }
        LType::Binary => {
            let t = raw.trim();
            let h = t.strip_prefix("\\x").or_else(|| t.strip_prefix("0x")).unwrap_or(t).to_lowercase();
            if h.len() % 2 != 0 || !h.chars().all(|c| c.is_ascii_hexdigit()) {
                return CVal::Invalid("binário inválido".into(), raw);
            }
            CVal::Bin(h)
        }
    }
}

fn temporal(mut dt: Dt, lt: LType, r: &Rules, side: Side) -> CVal {
    // naive timestamps placed in an explicit offset (to compare with zoned values)
    if dt.off.is_none() {
        let o = if side == Side::Source { &r.naive_offset_source } else { &r.naive_offset_target };
        if !o.is_empty() && dt.has_time {
            match parse_offset(o) {
                Some(off) => dt.off = Some(off),
                None => return CVal::Invalid(format!("fuso inválido na regra: {o}"), fmt_ts(&dt, 9)),
            }
        }
    }
    if let Some(p) = r.ts_precision {
        dt.nanos = truncate_nanos(dt.nanos, p);
    }
    let zoned = dt.off.is_some() || lt == LType::Timestamptz;
    if let Some(off) = dt.off {
        dt = to_utc(&dt, off);
    }
    if r.date_only || (lt == LType::Date && !dt.has_time) {
        return CVal::Date(fmt_date(&dt));
    }
    let digits = r.ts_precision.unwrap_or(9);
    if zoned {
        CVal::TsTz(format!("{}Z", fmt_ts(&dt, digits)))
    } else if lt == LType::Date {
        // a "date" column holding a time (Oracle-like) keeps it
        CVal::Ts(fmt_ts(&dt, digits))
    } else {
        CVal::Ts(fmt_ts(&dt, digits))
    }
}

/// Fill state of a canonical value, kept separately so "empty in the source" is never mistaken
/// for "lost in the destination".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Fill {
    Null,
    Empty,
    Blank,
    Filled,
    Invalid,
}

pub fn fill(v: &CVal) -> Fill {
    match v {
        CVal::Null => Fill::Null,
        CVal::Text(s) if s.is_empty() => Fill::Empty,
        CVal::Text(s) if s.chars().all(char::is_whitespace) => Fill::Blank,
        CVal::Invalid(..) => Fill::Invalid,
        _ => Fill::Filled,
    }
}
