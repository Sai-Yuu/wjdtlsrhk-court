const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cases (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      plaintiff TEXT NOT NULL,
      defendant TEXT NOT NULL,
      status TEXT DEFAULT 'in_progress',
      verdict TEXT,
      verdict_reason TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS statements (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL REFERENCES cases(id),
      author TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS evidence (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL REFERENCES cases(id),
      submitted_by TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
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
  console.log('DB 초기화 완료');
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// === 사건 ===
app.get('/api/cases', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM cases ORDER BY created_at DESC');
  res.json(rows);
});

app.post('/api/cases', async (req, res) => {
  const { title, description, plaintiff, defendant } = req.body;
  if (!title || !description || !plaintiff || !defendant)
    return res.status(400).json({ error: '모든 항목을 입력해주세요.' });
  const id = uuidv4();
  const { rows } = await pool.query(
    'INSERT INTO cases (id, title, description, plaintiff, defendant) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [id, title, description, plaintiff, defendant]
  );
  io.emit('case_created', rows[0]);
  res.json(rows[0]);
});

app.get('/api/cases/:id', async (req, res) => {
  const { rows: cases } = await pool.query('SELECT * FROM cases WHERE id=$1', [req.params.id]);
  if (!cases.length) return res.status(404).json({ error: '사건을 찾을 수 없습니다.' });
  const { rows: statements } = await pool.query('SELECT * FROM statements WHERE case_id=$1 ORDER BY created_at', [req.params.id]);
  const { rows: evidence } = await pool.query('SELECT * FROM evidence WHERE case_id=$1 ORDER BY created_at', [req.params.id]);
  const { rows: votes } = await pool.query('SELECT * FROM votes WHERE case_id=$1', [req.params.id]);
  res.json({ ...cases[0], statements, evidence, votes });
});

// === 발언 ===
app.post('/api/cases/:id/statements', async (req, res) => {
  const { author, role, content } = req.body;
  if (!author || !role || !content) return res.status(400).json({ error: '입력값을 확인해주세요.' });
  const { rows: cases } = await pool.query('SELECT status FROM cases WHERE id=$1', [req.params.id]);
  if (!cases.length) return res.status(404).json({ error: '사건 없음' });
  if (cases[0].status === 'closed') return res.status(400).json({ error: '이미 종결된 사건입니다.' });
  const id = uuidv4();
  const { rows } = await pool.query(
    'INSERT INTO statements (id, case_id, author, role, content) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [id, req.params.id, author, role, content]
  );
  io.to(req.params.id).emit('new_statement', rows[0]);
  res.json(rows[0]);
});

// === 증거 ===
app.post('/api/cases/:id/evidence', async (req, res) => {
  const { submitted_by, title, content } = req.body;
  if (!submitted_by || !title || !content) return res.status(400).json({ error: '입력값을 확인해주세요.' });
  const { rows: cases } = await pool.query('SELECT status FROM cases WHERE id=$1', [req.params.id]);
  if (!cases.length) return res.status(404).json({ error: '사건 없음' });
  if (cases[0].status === 'closed') return res.status(400).json({ error: '이미 종결된 사건입니다.' });
  const id = uuidv4();
  const { rows } = await pool.query(
    'INSERT INTO evidence (id, case_id, submitted_by, title, content) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [id, req.params.id, submitted_by, title, content]
  );
  io.to(req.params.id).emit('new_evidence', rows[0]);
  res.json(rows[0]);
});

// === 투표 ===
app.post('/api/cases/:id/votes', async (req, res) => {
  const { voter, vote } = req.body;
  if (!voter || !vote) return res.status(400).json({ error: '입력값을 확인해주세요.' });
  const { rows: cases } = await pool.query('SELECT status FROM cases WHERE id=$1', [req.params.id]);
  if (!cases.length) return res.status(404).json({ error: '사건 없음' });
  if (cases[0].status === 'closed') return res.status(400).json({ error: '이미 종결된 사건입니다.' });
  const { rows: existing } = await pool.query(
    'SELECT id FROM votes WHERE case_id=$1 AND voter=$2', [req.params.id, voter]
  );
  if (existing.length) return res.status(400).json({ error: '이미 투표하셨습니다.' });
  await pool.query(
    'INSERT INTO votes (id, case_id, voter, vote) VALUES ($1,$2,$3,$4)',
    [uuidv4(), req.params.id, voter, vote]
  );
  const { rows: votes } = await pool.query('SELECT * FROM votes WHERE case_id=$1', [req.params.id]);
  io.to(req.params.id).emit('vote_update', votes);
  res.json({ success: true, votes });
});

// === 판결 ===
app.post('/api/cases/:id/verdict', async (req, res) => {
  const { verdict, verdict_reason } = req.body;
  if (!verdict || !verdict_reason) return res.status(400).json({ error: '판결과 이유를 입력해주세요.' });
  const { rows: cases } = await pool.query('SELECT status FROM cases WHERE id=$1', [req.params.id]);
  if (!cases.length) return res.status(404).json({ error: '사건 없음' });
  if (cases[0].status === 'closed') return res.status(400).json({ error: '이미 종결된 사건입니다.' });
  const { rows } = await pool.query(
    "UPDATE cases SET verdict=$1, verdict_reason=$2, status='closed' WHERE id=$3 RETURNING *",
    [verdict, verdict_reason, req.params.id]
  );
  io.to(req.params.id).emit('verdict', rows[0]);
  res.json(rows[0]);
});

// === 소켓 ===
io.on('connection', (socket) => {
  socket.on('join_case', (caseId) => socket.join(caseId));
  socket.on('leave_case', (caseId) => socket.leave(caseId));
});

const PORT = process.env.PORT || 3000;
initDb().then(() => {
  server.listen(PORT, () => {
    console.log(`\n⚖️  디스코드 모의법원 서버 가동 중`);
    console.log(`   http://localhost:${PORT}\n`);
  });
}).catch(err => {
  console.error('DB 연결 실패:', err.message);
  process.exit(1);
});
