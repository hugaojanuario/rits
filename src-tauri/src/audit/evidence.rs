//! Evidence files: one record per line, sorted by the canonical key, written by an external
//! merge sort (sorted runs of at most `batch_rows` lines in memory, then a k-way merge), so a
//! table of any size is processed with bounded memory.
//!
//! Record line (tab-separated, all fields ASCII):
//!   key_hex  n  rawkey  row  fk_1..fk_R  field_1..field_F
//! - key_hex: hex of the canonical key encoding (order of the file)
//! - n: multiplicity of the key
//! - rawkey: digest of the raw (pre-normalization) key, or "*" when different raw keys
//!   collapsed into one canonical key (collision introduced by normalization)
//! - row: digest of all compared fields, or "*" (duplicates: fields are ambiguous)
//! - fk_i: canonical key hex of a relationship ("" when NULL), "*" when ambiguous
//! - field_i: N (null) | E (empty) | W:<dg> (spaces only) | V:<dg> | I:<dg> (invalid) | * ,
//!   optionally followed by "|<hex of the canonical value>" when values are stored.

use std::cmp::Ordering;
use std::collections::BinaryHeap;
use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq)]
pub struct Rec {
    pub key: String,
    pub n: u64,
    pub raw: String,
    pub row: String,
    pub fks: Vec<String>,
    pub fields: Vec<String>,
}

impl Rec {
    pub fn parse(line: &str, nfk: usize) -> Result<Rec, String> {
        let mut it = line.split('\t');
        let key = it.next().ok_or("registro vazio")?.to_string();
        let n = it.next().ok_or("registro truncado")?.parse().map_err(|_| "multiplicidade inválida")?;
        let raw = it.next().ok_or("registro truncado")?.to_string();
        let row = it.next().ok_or("registro truncado")?.to_string();
        let rest: Vec<String> = it.map(str::to_string).collect();
        if rest.len() < nfk {
            return Err("registro truncado".into());
        }
        let (fks, fields) = rest.split_at(nfk);
        Ok(Rec { key, n, raw, row, fks: fks.to_vec(), fields: fields.to_vec() })
    }
    pub fn line(&self) -> String {
        let mut s = format!("{}\t{}\t{}\t{}", self.key, self.n, self.raw, self.row);
        for x in self.fks.iter().chain(self.fields.iter()) {
            s.push('\t');
            s.push_str(x);
        }
        s
    }
    /// Merges another record with the same key (duplicates in a dataset).
    pub fn absorb(&mut self, o: Rec) {
        self.n += o.n;
        if self.raw != o.raw {
            self.raw = "*".into();
        }
        self.row = "*".into();
        for (a, b) in self.fks.iter_mut().zip(o.fks) {
            if *a != b {
                *a = "*".into();
            }
        }
        for f in self.fields.iter_mut() {
            *f = "*".into();
        }
    }
}

fn key_of(line: &str) -> &str {
    line.split('\t').next().unwrap_or("")
}

pub fn cmp_lines(a: &str, b: &str) -> Ordering {
    key_of(a).cmp(key_of(b)).then_with(|| a.cmp(b))
}

#[derive(Debug, Default, Clone)]
pub struct SortStats {
    pub runs: u64,
    pub records: u64,
    pub bytes: u64,
    pub input_lines: u64,
}

/// External sorter of record lines.
pub struct Sorter {
    dir: PathBuf,
    prefix: String,
    buf: Vec<String>,
    max_rows: usize,
    runs: Vec<PathBuf>,
    pub disk_used: u64,
    disk_limit: u64,
    pub input_lines: u64,
}

impl Sorter {
    pub fn new(dir: &Path, prefix: &str, max_rows: usize, disk_limit: u64) -> Result<Sorter, String> {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        Ok(Sorter { dir: dir.to_path_buf(), prefix: prefix.into(), buf: vec![], max_rows: max_rows.max(1), runs: vec![], disk_used: 0, disk_limit, input_lines: 0 })
    }

    pub fn push(&mut self, line: String) -> Result<(), String> {
        self.input_lines += 1;
        self.buf.push(line);
        if self.buf.len() >= self.max_rows {
            self.spill()?;
        }
        Ok(())
    }

    fn charge(&mut self, n: u64) -> Result<(), String> {
        self.disk_used += n;
        if self.disk_limit > 0 && self.disk_used > self.disk_limit {
            return Err(format!("Limite de disco da auditoria atingido ({} MB). A verificação desta unidade ficou incompleta.", self.disk_limit / 1_048_576));
        }
        Ok(())
    }

    fn spill(&mut self) -> Result<(), String> {
        if self.buf.is_empty() {
            return Ok(());
        }
        self.buf.sort_unstable_by(|a, b| cmp_lines(a, b));
        let p = self.dir.join(format!("{}.run{}", self.prefix, self.runs.len()));
        let mut w = BufWriter::new(File::create(&p).map_err(|e| e.to_string())?);
        let mut bytes = 0u64;
        for l in self.buf.drain(..) {
            bytes += l.len() as u64 + 1;
            w.write_all(l.as_bytes()).and_then(|_| w.write_all(b"\n")).map_err(|e| e.to_string())?;
        }
        w.flush().map_err(|e| e.to_string())?;
        self.runs.push(p);
        self.charge(bytes)
    }

    /// Merges the runs into `out`. With `group`, consecutive records with the same key are
    /// combined (multiplicity, collisions, ambiguity); `nfk` is the number of FK columns.
    pub fn finish(mut self, out: &Path, group: Option<usize>) -> Result<SortStats, String> {
        self.spill()?;
        let mut stats = SortStats { runs: self.runs.len() as u64, input_lines: self.input_lines, ..Default::default() };
        let tmp = out.with_extension("tmp");
        let mut w = BufWriter::new(File::create(&tmp).map_err(|e| e.to_string())?);
        let mut readers: Vec<std::io::Lines<BufReader<File>>> = vec![];
        for r in &self.runs {
            readers.push(BufReader::new(File::open(r).map_err(|e| e.to_string())?).lines());
        }
        struct Item(String, usize);
        impl PartialEq for Item {
            fn eq(&self, o: &Self) -> bool {
                cmp_lines(&self.0, &o.0) == Ordering::Equal
            }
        }
        impl Eq for Item {}
        impl PartialOrd for Item {
            fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
                Some(self.cmp(o))
            }
        }
        impl Ord for Item {
            fn cmp(&self, o: &Self) -> Ordering {
                cmp_lines(&o.0, &self.0).then(o.1.cmp(&self.1))
            }
        }
        let mut heap = BinaryHeap::new();
        for (i, r) in readers.iter_mut().enumerate() {
            if let Some(l) = r.next() {
                heap.push(Item(l.map_err(|e| e.to_string())?, i));
            }
        }
        let mut pending: Option<Rec> = None;
        let mut bytes = 0u64;
        let mut emit = |w: &mut BufWriter<File>, line: &str, stats: &mut SortStats| -> Result<(), String> {
            stats.records += 1;
            bytes += line.len() as u64 + 1;
            w.write_all(line.as_bytes()).and_then(|_| w.write_all(b"\n")).map_err(|e| e.to_string())
        };
        while let Some(Item(line, i)) = heap.pop() {
            if let Some(l) = readers[i].next() {
                heap.push(Item(l.map_err(|e| e.to_string())?, i));
            }
            match group {
                None => emit(&mut w, &line, &mut stats)?,
                Some(nfk) => {
                    let r = Rec::parse(&line, nfk)?;
                    match pending.as_mut() {
                        Some(p) if p.key == r.key => p.absorb(r),
                        _ => {
                            if let Some(p) = pending.take() {
                                emit(&mut w, &p.line(), &mut stats)?;
                            }
                            pending = Some(r);
                        }
                    }
                }
            }
        }
        if let Some(p) = pending.take() {
            emit(&mut w, &p.line(), &mut stats)?;
        }
        w.flush().map_err(|e| e.to_string())?;
        drop(w);
        stats.bytes = bytes;
        self.charge(bytes)?;
        std::fs::rename(&tmp, out).map_err(|e| e.to_string())?;
        for r in &self.runs {
            let _ = std::fs::remove_file(r);
        }
        Ok(stats)
    }

    /// Removes the temporary runs (cancellation/error).
    pub fn abort(self) {
        for r in &self.runs {
            let _ = std::fs::remove_file(r);
        }
    }
}

/// Streaming reader of a sorted evidence file.
pub struct Reader {
    lines: Option<std::io::Lines<BufReader<File>>>,
    nfk: usize,
    pub peeked: Option<Rec>,
    pub read: u64,
}

impl Reader {
    pub fn open(p: Option<&Path>, nfk: usize) -> Result<Reader, String> {
        let lines = match p {
            Some(p) => Some(BufReader::new(File::open(p).map_err(|e| format!("{}: {e}", p.display()))?).lines()),
            None => None,
        };
        let mut r = Reader { lines, nfk, peeked: None, read: 0 };
        r.advance()?;
        Ok(r)
    }
    pub fn advance(&mut self) -> Result<Option<Rec>, String> {
        let prev = self.peeked.take();
        if let Some(l) = self.lines.as_mut().and_then(|x| x.next()) {
            let l = l.map_err(|e| e.to_string())?;
            self.peeked = Some(Rec::parse(&l, self.nfk)?);
            self.read += 1;
        }
        Ok(prev)
    }
    pub fn key(&self) -> Option<&str> {
        self.peeked.as_ref().map(|r| r.key.as_str())
    }
    /// Advances until the key is >= `k`; returns the record with exactly `k`, if any.
    pub fn seek(&mut self, k: &str) -> Result<Option<Rec>, String> {
        while let Some(cur) = self.key() {
            match cur.cmp(k) {
                Ordering::Less => {
                    self.advance()?;
                }
                Ordering::Equal => return self.advance(),
                Ordering::Greater => return Ok(None),
            }
        }
        Ok(None)
    }
}

/// Plain sorted lines of "a\tb" pairs (identity maps).
pub struct PairReader {
    lines: std::io::Lines<BufReader<File>>,
    pub peeked: Option<(String, String)>,
}

impl PairReader {
    pub fn open(p: &Path) -> Result<PairReader, String> {
        let mut r = PairReader { lines: BufReader::new(File::open(p).map_err(|e| e.to_string())?).lines(), peeked: None };
        r.advance()?;
        Ok(r)
    }
    pub fn advance(&mut self) -> Result<Option<(String, String)>, String> {
        let prev = self.peeked.take();
        if let Some(l) = self.lines.next() {
            let l = l.map_err(|e| e.to_string())?;
            let (a, b) = l.split_once('\t').unwrap_or((l.as_str(), ""));
            self.peeked = Some((a.to_string(), b.to_string()));
        }
        Ok(prev)
    }
}

/// Line writer of findings with a byte budget shared with the sorter limits.
pub struct Findings {
    pub path: PathBuf,
    w: BufWriter<File>,
    pub count: u64,
    pub bytes: u64,
    pub examples: Vec<String>,
    max_examples: usize,
}

impl Findings {
    pub fn create(path: PathBuf, max_examples: usize) -> Result<Findings, String> {
        if let Some(d) = path.parent() {
            std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
        }
        let w = BufWriter::new(File::create(&path).map_err(|e| e.to_string())?);
        Ok(Findings { path, w, count: 0, bytes: 0, examples: vec![], max_examples })
    }
    pub fn add(&mut self, line: &str) -> Result<(), String> {
        self.count += 1;
        self.bytes += line.len() as u64 + 1;
        if self.examples.len() < self.max_examples {
            self.examples.push(line.to_string());
        }
        self.w.write_all(line.as_bytes()).and_then(|_| self.w.write_all(b"\n")).map_err(|e| e.to_string())
    }
    pub fn close(mut self) -> Result<(PathBuf, u64, u64), String> {
        self.w.flush().map_err(|e| e.to_string())?;
        Ok((self.path, self.count, self.bytes))
    }
}

/// SHA-256 of a file (streamed).
pub fn file_sha256(p: &Path) -> Result<(String, u64), String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut f = File::open(p).map_err(|e| format!("{}: {e}", p.display()))?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    let mut n = 0u64;
    loop {
        let k = f.read(&mut buf).map_err(|e| e.to_string())?;
        if k == 0 {
            break;
        }
        n += k as u64;
        h.update(&buf[..k]);
    }
    Ok((h.finalize().iter().map(|b| format!("{b:02x}")).collect(), n))
}
