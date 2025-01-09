/******************************************************
 * server.js
 ******************************************************/
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

// Cartas
const blackCardsData = require('./blackCards.js');
const whiteCardsData = require('./whiteCards.js');

// Barajar
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

let players = [];
let blackCards = [];
let whiteCards = [];
let currentSubmissions = [];

let currentZarIndex = 0;
let gameInProgress = false;

let discardPhaseActive = false;
let discardTimeLeft = 15;
let discardInterval = null;
let discardTimeout = null;

/******************************************************
 * Rondas
 ******************************************************/
function startNewRound() {
  discardPhaseActive = false;

  // Pasar Zar
  players[currentZarIndex].isCzar = false;
  currentZarIndex = (currentZarIndex + 1) % players.length;
  players[currentZarIndex].isCzar = true;

  const black = blackCards.shift();

  // scoreboard
  const sorted = [...players].sort((a, b) => b.points - a.points);
  const timeLeft = 5;
  io.emit('showIntermediate', {
    timeLeft,
    scores: sorted.map(p => ({ name: p.name, points: p.points }))
  });

  setTimeout(() => {
    players.forEach(p => {
      while (p.cards.length < 8 && whiteCards.length > 0) {
        p.cards.push(whiteCards.shift());
      }
      p.hasDiscarded = false;
    });

    io.emit('roundStarted', {
      blackCard: black,
      players: players.map(p => ({
        id: p.id,
        name: p.name,
        points: p.points,
        isCzar: p.isCzar
      }))
    });

    players.forEach(pl => {
      io.to(pl.id).emit('yourHand', { cards: pl.cards });
    });
    currentSubmissions = [];
  }, timeLeft * 1000);
}

function startDiscardPhase() {
  discardPhaseActive = true;
  discardTimeLeft = 15;
  broadcastStillDiscarding();

  discardInterval = setInterval(() => {
    discardTimeLeft--;
    broadcastStillDiscarding();
    if (discardTimeLeft <= 0) {
      clearInterval(discardInterval);
    }
  }, 1000);

  discardTimeout = setTimeout(() => {
    endDiscardPhase();
  }, discardTimeLeft * 1000);
}

function broadcastStillDiscarding() {
  const still = players.filter(p => !p.hasDiscarded);
  if (still.length === 0) {
    endDiscardPhase();
    return;
  }
  const names = still.map(p => p.name);
  let txt = "";
  if (names.length === 1) {
    txt = names[0];
  } else if (names.length === 2) {
    txt = names.join(" y ");
  } else {
    txt = names.slice(0, -1).join(", ") + " y " + names[names.length - 1];
  }
  io.emit('stillDiscarding', {
    text: `Faltan por descartar/omitir: ${txt}. ${discardTimeLeft}s restantes.`
  });
}

function endDiscardPhase() {
  discardPhaseActive = false;
  clearInterval(discardInterval);
  clearTimeout(discardTimeout);

  io.emit('discardPhaseEnded');
  startNewRound();
}

/******************************************************
 * Socket.IO
 ******************************************************/
io.on('connection', (socket) => {
  console.log("Cliente conectado:", socket.id);

  socket.on('joinGame', (playerName) => {
    if (gameInProgress) {
      socket.emit('errorMessage', { message: "La partida ya comenzó." });
      return;
    }
    players.push({
      id: socket.id,
      name: playerName,
      points: 0,
      cards: [],
      isCzar: false,
      hasDiscarded: false
    });

    io.emit('updatePlayers', {
      players: players.map(p => ({
        name: p.name,
        points: p.points
      }))
    });
  });

  socket.on('startGame', () => {
    if (players.length < 3) {
      socket.emit('errorMessage', { message: "Se necesitan al menos 3 jugadores." });
      return;
    }
    if (gameInProgress) {
      socket.emit('errorMessage', { message: "La partida ya está en curso." });
      return;
    }
    gameInProgress = true;
    blackCards = shuffleArray([...blackCardsData]);
    whiteCards = shuffleArray([...whiteCardsData]);

    players.forEach(p => {
      p.cards = whiteCards.splice(0, 8);
      p.points = 0;
      p.isCzar = false;
      p.hasDiscarded = false;
    });

    currentZarIndex = 0;
    players[currentZarIndex].isCzar = true;

    const black = blackCards.shift();
    io.emit('roundStarted', {
      blackCard: black,
      players: players.map(pl => ({
        id: pl.id,
        name: pl.name,
        points: pl.points,
        isCzar: pl.isCzar
      }))
    });
    players.forEach(pl => {
      io.to(pl.id).emit('yourHand', { cards: pl.cards });
    });
    currentSubmissions = [];
  });

  // ENVIAR CARTA
  socket.on('sendCard', (cardId) => {
    const pl = players.find(p => p.id === socket.id);
    if (!pl || pl.isCzar) return;

    // Elimina de la mano
    pl.cards = pl.cards.filter(c => c.id !== cardId);

    // Submissions
    if (!currentSubmissions) currentSubmissions = [];
    currentSubmissions.push({
      submissionId: socket.id + "-" + cardId,
      playerId: pl.id,
      cardId
    });

    const nonZar = players.filter(x => !x.isCzar);
    if (currentSubmissions.length === nonZar.length) {
      const arr = currentSubmissions.map(s => {
        const cObj = whiteCardsData.find(xx => xx.id === s.cardId);
        return {
          submissionId: s.submissionId,
          text: cObj ? cObj.text : "???",
          playerId: s.playerId
        };
      });
      io.emit('showSubmissions', arr);
    }
  });

  // El Zar elige
  socket.on('selectWinner', (submissionId) => {
    const chosen = currentSubmissions.find(s => s.submissionId === submissionId);
    if (!chosen) return;
    const w = players.find(p => p.id === chosen.playerId);
    if (!w) return;

    w.points++;
    const cData = whiteCardsData.find(cc => cc.id === parseInt(chosen.cardId));
    const winnerCardText = cData ? cData.text : "???";

    io.emit('roundResult', {
      winnerId: w.id,
      winnerName: w.name,
      pointsWon: 1,
      totalPoints: w.points,
      winnerCardText
    });
    io.emit('hideSubmissions');
    currentSubmissions = [];

    startDiscardPhase();
  });

  // DESCARTAR (una sola vez)
  socket.on('discardCards', (cardIds) => {
    const pl = players.find(p => p.id === socket.id);
    if (!pl) return;
    if (pl.hasDiscarded) {
      socket.emit('errorMessage', { message: "Solo descartas una vez." });
      return;
    }
    // Elimina todas las cartas elegidas
    pl.cards = pl.cards.filter(cc => !cardIds.includes(cc.id));

    // Marca
    pl.hasDiscarded = true;

    io.to(pl.id).emit('updateHand', { cards: pl.cards });

    if (discardPhaseActive) {
      broadcastStillDiscarding();
    }
  });

  socket.on('omitDiscard', () => {
    const pl = players.find(p => p.id === socket.id);
    if (!pl) return;
    if (pl.hasDiscarded) return;

    pl.hasDiscarded = true;
    if (discardPhaseActive) {
      broadcastStillDiscarding();
    }
  });

  // Terminar
  socket.on('endGame', (pass) => {
    if (pass !== "joaquin") {
      socket.emit('errorMessage', { message: "Contraseña incorrecta." });
      return;
    }
    gameInProgress = false;
    discardPhaseActive = false;
    clearTimeout(discardTimeout);
    clearInterval(discardInterval);

    const sorted = [...players].sort((a, b) => b.points - a.points);
    io.emit('gameEnded', {
      scores: sorted.map(s => ({ name: s.name, points: s.points }))
    });
    players = [];
  });

  socket.on('disconnectPlayer', () => {
    players = players.filter(p => p.id !== socket.id);
    io.emit('updatePlayers', {
      players: players.map(px => ({ name: px.name, points: px.points }))
    });
    if (players.length === 0) {
      gameInProgress = false;
    }
  });

  socket.on('disconnect', () => {
    players = players.filter(p => p.id !== socket.id);
    io.emit('updatePlayers', {
      players: players.map(px => ({ name: px.name, points: px.points }))
    });
    if (players.length === 0) {
      gameInProgress = false;
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor en http://localhost:${PORT}`);
});
