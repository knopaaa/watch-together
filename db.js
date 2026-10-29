const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'watch-db.json');
let data = { rooms: {}, messages: {} };

// Загружаем базу при старте
if (fs.existsSync(DB_FILE)) {
  try {
    data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    console.error('Ошибка чтения БД, создаём новую');
  }
}

// Функция сохранения на диск (вызывается после каждого изменения)
function save() {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
}

module.exports = {
  saveRoom(id, video) {
    data.rooms[id] = video;
    save();
  },
  loadRoom(id) {
    return data.rooms[id] || null;
  },
  saveMessage(roomId, name, color, text) {
    if (!data.messages[roomId]) data.messages[roomId] = [];
    data.messages[roomId].push({ name, color, text, ts: Date.now() });
    // Храним только последние 200 сообщений в комнате
    if (data.messages[roomId].length > 200) data.messages[roomId].shift();
    save();
  },
  getMessages(roomId, limit = 100) {
    return (data.messages[roomId] || []).slice(-limit);
  }
};