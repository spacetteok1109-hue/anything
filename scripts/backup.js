'use strict';
// DB를 날짜별 파일로 백업하고 오래된 백업을 정리합니다. 서버가 켜져 있어도 안전하게 동작합니다.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups');
const KEEP = Number(process.env.BACKUP_KEEP || 30);
const src = path.join(DATA_DIR, 'manpower.db');

if (!fs.existsSync(src)) { console.error('DB 파일이 없습니다: ' + src); process.exit(1); }
fs.mkdirSync(BACKUP_DIR, { recursive: true });

const d = new Date();
const p = (n) => String(n).padStart(2, '0');
const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
const dest = path.join(BACKUP_DIR, `manpower-${stamp}.db`);

const db = new DatabaseSync(src);
db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
db.close();
console.log('백업 완료: ' + dest);

const files = fs.readdirSync(BACKUP_DIR).filter((f) => /^manpower-\d{8}-\d{6}\.db$/.test(f)).sort();
for (const f of files.slice(0, Math.max(0, files.length - KEEP))) {
  fs.unlinkSync(path.join(BACKUP_DIR, f));
  console.log('오래된 백업 삭제: ' + f);
}
