require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ── Cloudinary 설정 (환경변수 없으면 백업 비활성) ────────────────
const CLOUDINARY_ENABLED = !!(
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
);
if (CLOUDINARY_ENABLED) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

async function uploadToCloudinary(localPath) {
  if (!CLOUDINARY_ENABLED) return null;
  try {
    const result = await cloudinary.uploader.upload(localPath, { resource_type: 'auto' });
    return result.secure_url;
  } catch (e) {
    console.error('Cloudinary 백업 실패:', e.message);
    return null;
  }
}

// ── 파일 업로드 설정 ───────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
});

const USE_PG = !!process.env.DATABASE_URL;
let pool;

if (USE_PG) {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
}

// ── JSON fallback ──────────────────────────────────────────────
const DB_FILE = path.join(process.env.USER_DATA_PATH || __dirname, 'db.json');
function readDb() {
  if (!fs.existsSync(DB_FILE)) return { cases: [], statements: [], evidence: [], votes: [] };
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function writeDb(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ── DB 초기화 ──────────────────────────────────────────────────
async function initDb() {
  if (!USE_PG) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cases (
      id TEXT PRIMARY KEY,
      case_number TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      plaintiff TEXT NOT NULL,
      defendant TEXT NOT NULL,
      case_type TEXT DEFAULT '형사',
      status TEXT DEFAULT 'in_progress',
      verdict TEXT,
      punishment TEXT,
      verdict_reason TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS statements (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL REFERENCES cases(id),
      author TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      file_url TEXT,
      file_backup_url TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS evidence (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL REFERENCES cases(id),
      submitted_by TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      file_url TEXT,
      file_backup_url TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS votes (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL REFERENCES cases(id),
      voter TEXT NOT NULL,
      vote TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // 기존 테이블에 새 컬럼 추가 (이미 있으면 무시)
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE cases ADD COLUMN IF NOT EXISTS case_type TEXT DEFAULT '형사';
      ALTER TABLE cases ADD COLUMN IF NOT EXISTS punishment TEXT;
      ALTER TABLE cases ADD COLUMN IF NOT EXISTS case_number TEXT;
      ALTER TABLE statements ADD COLUMN IF NOT EXISTS file_url TEXT;
      ALTER TABLE statements ADD COLUMN IF NOT EXISTS file_backup_url TEXT;
      ALTER TABLE evidence ADD COLUMN IF NOT EXISTS file_url TEXT;
      ALTER TABLE evidence ADD COLUMN IF NOT EXISTS file_backup_url TEXT;
    EXCEPTION WHEN others THEN NULL;
    END $$;
  `);
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// ── 파일 업로드 ────────────────────────────────────────────────
app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });
  const localUrl = `/uploads/${req.file.filename}`;
  const backupUrl = await uploadToCloudinary(req.file.path);
  res.json({
    url: localUrl,
    backup_url: backupUrl,
    originalname: req.file.originalname,
    mimetype: req.file.mimetype,
  });
});

// ── 사건 ──────────────────────────────────────────────────────
app.get('/api/cases', async (req, res) => {
  if (USE_PG) {
    const { rows } = await pool.query('SELECT * FROM cases ORDER BY created_at DESC');
    return res.json(rows);
  }
  res.json(readDb().cases.slice().reverse());
});

app.post('/api/cases', async (req, res) => {
  const { title, description, plaintiff, defendant, case_type = '형사', case_number = null } = req.body;
  if (!title || !description || !plaintiff || !defendant)
    return res.status(400).json({ error: '모든 항목을 입력해주세요.' });
  const id = uuidv4();
  if (USE_PG) {
    const { rows } = await pool.query(
      'INSERT INTO cases (id,case_number,title,description,plaintiff,defendant,case_type) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [id, case_number || null, title, description, plaintiff, defendant, case_type]
    );
    io.emit('case_created', rows[0]);
    return res.json(rows[0]);
  }
  const db = readDb();
  const c = { id, case_number: case_number || null, title, description, plaintiff, defendant, case_type, status: 'in_progress', verdict: null, punishment: null, verdict_reason: null, created_at: new Date().toISOString() };
  db.cases.push(c);
  writeDb(db);
  io.emit('case_created', c);
  res.json(c);
});

app.get('/api/cases/:id', async (req, res) => {
  if (USE_PG) {
    const { rows: cases } = await pool.query('SELECT * FROM cases WHERE id=$1', [req.params.id]);
    if (!cases.length) return res.status(404).json({ error: '사건을 찾을 수 없습니다.' });
    const { rows: statements } = await pool.query('SELECT * FROM statements WHERE case_id=$1 ORDER BY created_at', [req.params.id]);
    const { rows: evidence } = await pool.query('SELECT * FROM evidence WHERE case_id=$1 ORDER BY created_at', [req.params.id]);
    const { rows: votes } = await pool.query('SELECT * FROM votes WHERE case_id=$1', [req.params.id]);
    return res.json({ ...cases[0], statements, evidence, votes });
  }
  const db = readDb();
  const c = db.cases.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '사건을 찾을 수 없습니다.' });
  res.json({
    ...c,
    statements: db.statements.filter(x => x.case_id === req.params.id).sort((a, b) => a.created_at.localeCompare(b.created_at)),
    evidence: db.evidence.filter(x => x.case_id === req.params.id).sort((a, b) => a.created_at.localeCompare(b.created_at)),
    votes: db.votes.filter(x => x.case_id === req.params.id),
  });
});

// ── 발언 ──────────────────────────────────────────────────────
app.post('/api/cases/:id/statements', async (req, res) => {
  const { author, role, content, file_url = null, file_backup_url = null } = req.body;
  if (!author || !role || !content) return res.status(400).json({ error: '입력값을 확인해주세요.' });
  if (USE_PG) {
    const { rows: c } = await pool.query('SELECT status FROM cases WHERE id=$1', [req.params.id]);
    if (!c.length) return res.status(404).json({ error: '사건 없음' });
    if (c[0].status === 'closed') return res.status(400).json({ error: '이미 종결된 사건입니다.' });
    const { rows } = await pool.query(
      'INSERT INTO statements (id,case_id,author,role,content,file_url,file_backup_url) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [uuidv4(), req.params.id, author, role, content, file_url, file_backup_url]
    );
    io.to(req.params.id).emit('new_statement', rows[0]);
    return res.json(rows[0]);
  }
  const db = readDb();
  const c = db.cases.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '사건 없음' });
  if (c.status === 'closed') return res.status(400).json({ error: '이미 종결된 사건입니다.' });
  const stmt = { id: uuidv4(), case_id: req.params.id, author, role, content, file_url, file_backup_url, created_at: new Date().toISOString() };
  db.statements.push(stmt);
  writeDb(db);
  io.to(req.params.id).emit('new_statement', stmt);
  res.json(stmt);
});

// ── 증거 ──────────────────────────────────────────────────────
app.post('/api/cases/:id/evidence', async (req, res) => {
  const { submitted_by, title, content = '', file_url = null, file_backup_url = null } = req.body;
  if (!submitted_by || !title || (!content && !file_url)) return res.status(400).json({ error: '입력값을 확인해주세요.' });
  if (USE_PG) {
    const { rows: c } = await pool.query('SELECT status FROM cases WHERE id=$1', [req.params.id]);
    if (!c.length) return res.status(404).json({ error: '사건 없음' });
    if (c[0].status === 'closed') return res.status(400).json({ error: '이미 종결된 사건입니다.' });
    const { rows } = await pool.query(
      'INSERT INTO evidence (id,case_id,submitted_by,title,content,file_url,file_backup_url) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [uuidv4(), req.params.id, submitted_by, title, content, file_url, file_backup_url]
    );
    io.to(req.params.id).emit('new_evidence', rows[0]);
    return res.json(rows[0]);
  }
  const db = readDb();
  const c = db.cases.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '사건 없음' });
  if (c.status === 'closed') return res.status(400).json({ error: '이미 종결된 사건입니다.' });
  const ev = { id: uuidv4(), case_id: req.params.id, submitted_by, title, content, file_url, file_backup_url, created_at: new Date().toISOString() };
  db.evidence.push(ev);
  writeDb(db);
  io.to(req.params.id).emit('new_evidence', ev);
  res.json(ev);
});

// ── 투표 ──────────────────────────────────────────────────────
app.post('/api/cases/:id/votes', async (req, res) => {
  const { voter, vote } = req.body;
  if (!voter || !vote) return res.status(400).json({ error: '입력값을 확인해주세요.' });
  if (USE_PG) {
    const { rows: c } = await pool.query('SELECT status FROM cases WHERE id=$1', [req.params.id]);
    if (!c.length) return res.status(404).json({ error: '사건 없음' });
    if (c[0].status === 'closed') return res.status(400).json({ error: '이미 종결된 사건입니다.' });
    const { rows: ex } = await pool.query('SELECT id FROM votes WHERE case_id=$1 AND voter=$2', [req.params.id, voter]);
    if (ex.length) return res.status(400).json({ error: '이미 투표하셨습니다.' });
    await pool.query('INSERT INTO votes (id,case_id,voter,vote) VALUES ($1,$2,$3,$4)', [uuidv4(), req.params.id, voter, vote]);
    const { rows: votes } = await pool.query('SELECT * FROM votes WHERE case_id=$1', [req.params.id]);
    io.to(req.params.id).emit('vote_update', votes);
    return res.json({ success: true, votes });
  }
  const db = readDb();
  const c = db.cases.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '사건 없음' });
  if (c.status === 'closed') return res.status(400).json({ error: '이미 종결된 사건입니다.' });
  if (db.votes.find(x => x.case_id === req.params.id && x.voter === voter))
    return res.status(400).json({ error: '이미 투표하셨습니다.' });
  const voteObj = { id: uuidv4(), case_id: req.params.id, voter, vote, created_at: new Date().toISOString() };
  db.votes.push(voteObj);
  writeDb(db);
  const votes = db.votes.filter(x => x.case_id === req.params.id);
  io.to(req.params.id).emit('vote_update', votes);
  res.json({ success: true, votes });
});

// ── 판결 ──────────────────────────────────────────────────────
app.post('/api/cases/:id/verdict', async (req, res) => {
  const { verdict, punishment, verdict_reason } = req.body;
  if (!verdict || !verdict_reason) return res.status(400).json({ error: '판결과 이유를 입력해주세요.' });
  if (USE_PG) {
    const { rows: c } = await pool.query('SELECT status FROM cases WHERE id=$1', [req.params.id]);
    if (!c.length) return res.status(404).json({ error: '사건 없음' });
    if (c[0].status === 'closed') return res.status(400).json({ error: '이미 종결된 사건입니다.' });
    const { rows } = await pool.query(
      "UPDATE cases SET verdict=$1, punishment=$2, verdict_reason=$3, status='closed' WHERE id=$4 RETURNING *",
      [verdict, punishment || null, verdict_reason, req.params.id]
    );
    io.to(req.params.id).emit('verdict', rows[0]);
    return res.json(rows[0]);
  }
  const db = readDb();
  const c = db.cases.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '사건 없음' });
  if (c.status === 'closed') return res.status(400).json({ error: '이미 종결된 사건입니다.' });
  c.verdict = verdict;
  c.punishment = punishment || null;
  c.verdict_reason = verdict_reason;
  c.status = 'closed';
  writeDb(db);
  io.to(req.params.id).emit('verdict', c);
  res.json(c);
});

// ── 판결 아카이브 ────────────────────────────────────────────
app.get('/api/verdicts', async (req, res) => {
  if (USE_PG) {
    const { rows } = await pool.query(`
      SELECT c.*,
        COUNT(v.id)::int AS vote_total,
        COUNT(CASE WHEN v.vote IN ('유죄','원고승') THEN 1 END)::int AS vote_yes,
        COUNT(CASE WHEN v.vote IN ('무죄','피고승') THEN 1 END)::int AS vote_no
      FROM cases c
      LEFT JOIN votes v ON v.case_id = c.id
      WHERE c.status = 'closed'
      GROUP BY c.id
      ORDER BY c.created_at DESC
    `);
    return res.json(rows);
  }
  const db = readDb();
  const closed = db.cases.filter(x => x.status === 'closed').slice().reverse();
  res.json(closed.map(c => {
    const votes = db.votes.filter(v => v.case_id === c.id);
    return {
      ...c,
      vote_total: votes.length,
      vote_yes: votes.filter(v => ['유죄','원고승'].includes(v.vote)).length,
      vote_no: votes.filter(v => ['무죄','피고승'].includes(v.vote)).length,
    };
  }));
});

// ── 소켓 ──────────────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.on('join_case', (caseId) => socket.join(caseId));
  socket.on('leave_case', (caseId) => socket.leave(caseId));
});

async function start(port) {
  const p = port || process.env.PORT || 3000;
  await initDb();
  return new Promise((resolve, reject) => {
    server.listen(p, () => {
      console.log(`\n⚖️  디스코드 모의법원 서버 가동 중`);
      console.log(`   DB 모드: ${USE_PG ? 'PostgreSQL' : 'JSON 파일 (로컬)'}`);
      console.log(`   http://localhost:${p}\n`);
      resolve(p);
    }).on('error', reject);
  });
}

if (require.main === module) {
  start().catch(err => {
    console.error('서버 시작 실패:', err.message);
    process.exit(1);
  });
}

module.exports = { start };
