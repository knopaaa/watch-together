const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');

// На Render (Linux) используем папку /tmp, на Windows - текущую папку
const dbPath = process.env.NODE_ENV === 'production' 
  ? path.join(os.tmpdir(), 'watch.db') 
  : path.join(__dirname, 'watch.db');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    video_json TEXT,
    updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT,
    text TEXT NOT NULL,
    ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_room_ts ON messages(room_id, ts);
`);

const stmts = {
  upsertRoom: db.prepare(`
    INSERT INTO rooms (id, video_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET video_json=excluded.video_json, updated_at=excluded.updated_at
  `),
  getRoom: db.prepare('SELECT * FROM rooms WHERE id = ?'),
  insertMsg: db.prepare(
    'INSERT INTO messages (room_id, name, color, text, ts) VALUES (?, ?, ?, ?, ?)'
  ),
  getMsgs: db.prepare(
    'SELECT name, color, text, ts FROM messages WHERE room_id = ? ORDER BY ts DESC LIMIT ?'
  )
};

module.exports = {
  saveRoom(id, video) {
    try { stmts.upsertRoom.run(id, JSON.stringify(video), Date.now()); } catch(e) { console.error(e); }
  },
  loadRoom(id) {
    try {
      const row = stmts.getRoom.get(id);
      if (!row || !row.video_json) return null;
      return JSON.parse(row.video_json);
    } catch(e) { return null; }
  },
  saveMessage(roomId, name, color, text) {
    try { stmts.insertMsg.run(roomId, name, color, text, Date.now()); } catch(e) { console.error(e); }
  },
  getMessages(roomId, limit = 100) {
    try { return stmts.getMsgs.all(roomId, limit).reverse(); } catch(e) { return []; }
  }
};
