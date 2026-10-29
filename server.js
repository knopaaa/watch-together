const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e7
});

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.get('/r/:roomId', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

/** roomId -> { video, time, playing, users: Map<socketId, {name,color}>, vkReady: Map<socketId,bool> } */
const rooms = new Map();

function getRoom(id) {
  if (!rooms.has(id)) {
    const savedVideo = db.loadRoom(id);
    rooms.set(id, {
      video: savedVideo || null,
      time: 0,
      playing: false,
      users: new Map()
    });
  }
  return rooms.get(id);
}

const usersArr = (room) => Array.from(room.users.values());

io.on('connection', (socket) => {
  // ---------- ВХОД В КОМНАТУ ----------
  socket.on('join', ({ roomId, name }) => {
    if (!roomId || !name) return;
    roomId = String(roomId).trim().slice(0, 32);
    name = String(name).trim().slice(0, 24);

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.name = name;

    const room = getRoom(roomId);
    const color = '#' + Math.floor(Math.random() * 0xffffff)
      .toString(16).padStart(6, '0');
    socket.data.color = color;
    room.users.set(socket.id, { name, color });

    // новичку — состояние + история чата
    socket.emit('init', {
      video: room.video,
      time: room.time,
      playing: room.playing,
      users: usersArr(room),
      history: db.getMessages(roomId, 100)
    });

    io.to(roomId).emit('users', usersArr(room));
    io.to(roomId).emit('system', { text: `${name} подключился` });
  });

  // ---------- СИНХРОНИЗАЦИЯ ПЛЕЕРА ----------
    socket.on('sync', (data) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = getRoom(roomId);

    // Обновляем время и статус (играет/пауза)
    if (typeof data.time === 'number') room.time = data.time;
    if (typeof data.playing === 'boolean') room.playing = data.playing;

    // Отправляем всем, КРОМЕ того, кто нажал
    socket.to(roomId).emit('sync', {
      time: room.time,
      playing: room.playing,
      by: socket.data.name
    });
  });

  // ---------- СМЕНА ВИДЕО ----------
  socket.on('setVideo', (video) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = getRoom(roomId);
    room.video = video;
    room.time = 0;
    room.playing = false;
    db.saveRoom(roomId, video);
    io.to(roomId).emit('setVideo', video);
    io.to(roomId).emit('system', { text: `${socket.data.name} сменил видео` });
  });

  // ---------- ЧАТ ----------
  socket.on('chat', (text) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    text = String(text).slice(0, 500).trim();
    if (!text) return;
    const payload = {
      name: socket.data.name,
      color: socket.data.color,
      text,
      ts: Date.now()
    };
    db.saveMessage(roomId, payload.name, payload.color, payload.text);
    io.to(roomId).emit('chat', payload);
  });

  // ---------- ВСПЛЫВАЮЩИЕ ЭМОДЗИ ----------
  socket.on('reaction', (emoji) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const allowed = ['❤️', '😂', '😮', '😢', '👍', '🔥', '💀', '🎉', '😍', '🤯'];
    if (!allowed.includes(emoji)) return;
    io.to(roomId).emit('reaction', {
      emoji,
      from: socket.data.name,
      id: Math.random().toString(36).slice(2)
    });
  });

  // ---------- WebRTC SIGNALING (screen-share) ----------
  socket.on('rtc-offer', (payload) => {
    socket.to(socket.data.roomId).emit('rtc-offer', { ...payload, from: socket.id });
  });
  socket.on('rtc-answer', (payload) => {
    socket.to(socket.data.roomId).emit('rtc-answer', { ...payload, from: socket.id });
  });
  socket.on('rtc-ice', (payload) => {
    socket.to(socket.data.roomId).emit('rtc-ice', { ...payload, from: socket.id });
  });
  socket.on('rtc-stop', () => {
    socket.to(socket.data.roomId).emit('rtc-stop');
  });

  // ---------- ОТКЛЮЧЕНИЕ ----------
  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = getRoom(roomId);
    room.users.delete(socket.id);
    io.to(roomId).emit('users', usersArr(room));
    if (socket.data.name) {
      io.to(roomId).emit('system', { text: `${socket.data.name} отключился` });
    }
    if (room.users.size === 0) rooms.delete(roomId);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Сервер: http://localhost:${PORT}`);
});
