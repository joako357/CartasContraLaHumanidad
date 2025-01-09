/******************************************************
 * server.js
 ******************************************************/
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

// IMPORTA TUS ARCHIVOS DE CARTAS
const blackCardsData = require('./blackCards.js');
const whiteCardsData = require('./whiteCards.js');

// Mezclar arrays
function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

let players = [];             
let blackCards = [];          
let whiteCards = [];          
let currentSubmissions = [];  
let currentZarIndex = 0;      
let extraDiscardTimer = null; 
let discardInterval = null;
let timeLeft = 0;
let gameInProgress = false; // Bloquear uniones al iniciar

let extraPhaseActive = false; // Para saber si estamos en los 15 seg extra

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// ===================== Reglas de Rondas =====================
function startNewRound() {
  // Termina la fase extra, por si quedaba
  extraPhaseActive = false;

  // Retirar Zar anterior
  players[currentZarIndex].isCzar = false;
  // Avanzar Zar
  currentZarIndex = (currentZarIndex + 1) % players.length;
  players[currentZarIndex].isCzar = true;

  // Siguiente carta negra
  const currentBlackCard = blackCards.shift();

  // Emitir roundStarted
  io.emit('roundStarted', {
    blackCard: currentBlackCard,
    players: players.map(({ id, name, points, isCzar }) => ({
      id, name, points, isCzar
    }))
  });

  // Reenviar mano
  players.forEach(p => {
    p.hasDiscarded = false; // reset
    io.to(p.id).emit('yourHand', { cards: p.cards });
  });

  currentSubmissions = [];
}

function checkAllDiscarded() {
  if (!extraPhaseActive) {
    // Si no estamos en la fase extra, no mostramos nada global
    return;
  }
  // En fase extra, sí chequeamos y anunciamos
  const stillDiscarding = players.filter(p => !p.hasDiscarded);
  if (stillDiscarding.length === 0) {
    // Todos descartaron
    clearTimeout(extraDiscardTimer);
    clearInterval(discardInterval);
    io.emit('discardPhaseEnded');
    startNewRound();
  } else {
    // Avisar a todos quién falta
    const names = stillDiscarding.map(p => p.name);
    io.emit('discardingStatus', { stillDiscarding: names });
  }
}

function startExtraDiscardPhase() {
  extraPhaseActive = true;
  timeLeft = 15;

  io.emit('extraDiscardTime', { seconds: timeLeft });

  discardInterval = setInterval(() => {
    timeLeft--;
    io.emit('updateDiscardTime', { timeLeft });
    if (timeLeft <= 0) {
      clearInterval(discardInterval);
    }
  }, 1000);

  extraDiscardTimer = setTimeout(() => {
    io.emit('discardPhaseEnded');
    startNewRound();
  }, 15000);
}

// ===================== Socket.IO =====================
io.on('connection', (socket) => {
  console.log('Nuevo cliente conectado:', socket.id);

  // Unirse
  socket.on('joinGame', (playerName) => {
    if (gameInProgress) {
      socket.emit('errorMessage', { message: 'El juego ya está en curso, no puedes unirte ahora.' });
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
    io.emit('updatePlayers', players);
  });

  // Iniciar partida
  socket.on('startGame', () => {
    if (players.length < 3) {
      io.to(socket.id).emit('errorMessage', {
        message: 'Se necesitan al menos 3 jugadores para iniciar la partida.'
      });
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

    const currentBlackCard = blackCards.shift();
    io.emit('roundStarted', {
      blackCard: currentBlackCard,
      players: players.map(({ id, name, points, isCzar }) => ({
        id, name, points, isCzar
      }))
    });

    players.forEach(p => {
      io.to(p.id).emit('yourHand', { cards: p.cards });
    });

    currentSubmissions = [];
  });

  // Enviar 1 carta
  socket.on('submitCards', ({ chosenCard }) => {
    const player = players.find(p => p.id === socket.id);
    if (!player) return;

    // El Zar no envía cartas
    if (player.isCzar) {
      // ignorar
      return;
    }

    currentSubmissions.push({
      submissionId: `${socket.id}-${chosenCard.id}`,
      playerId: player.id,
      cardId: chosenCard.id
    });

    player.cards = player.cards.filter(c => c.id !== chosenCard.id);

    // check si todos enviaron
    const nonZarPlayers = players.filter(pl => !pl.isCzar);
    if (currentSubmissions.length === nonZarPlayers.length) {
      const submissionsToShow = currentSubmissions.map(s => {
        const cardObj = whiteCardsData.find(w => w.id === s.cardId);
        return {
          submissionId: s.submissionId,
          text: cardObj ? cardObj.text : '???',
          playerId: s.playerId
        };
      });
      io.emit('showSubmissions', submissionsToShow);
    }
  });

  // El Zar elige
  socket.on('selectWinner', (submissionId) => {
    const chosen = currentSubmissions.find(s => s.submissionId === submissionId);
    if (!chosen) return;
    const winner = players.find(p => p.id === chosen.playerId);
    if (!winner) return;

    winner.points++;
    io.emit('roundResult', {
      winnerId: winner.id,
      winnerName: winner.name,
      submissionId,
      pointsWon: 1,
      totalPoints: winner.points
    });

    currentSubmissions = [];
    startExtraDiscardPhase();
  });

  // Descartar (una vez por ronda, hasta 3)
  socket.on('requestDiscard', ({ discardCardIds }) => {
    const player = players.find(p => p.id === socket.id);
    if (!player) return;

    // Si ya descartó
    if (player.hasDiscarded) {
      io.to(player.id).emit('errorMessage', {
        message: 'Solo puedes descartar una vez por ronda.'
      });
      return;
    }

    if (discardCardIds.length > 3) {
      return;
    }

    // Quitar
    player.cards = player.cards.filter(c => !discardCardIds.includes(c.id));
    while (player.cards.length < 8 && whiteCards.length > 0) {
      player.cards.push(whiteCards.shift());
    }

    // Marcamos
    player.hasDiscarded = true;

    // Enviamos mano actualizada
    io.to(player.id).emit('updateHand', { cards: player.cards });

    // checkAllDiscarded SOLO si estamos en fase extra
    checkAllDiscarded();
  });

  // Desconectar manual
  socket.on('disconnectPlayer', () => {
    players = players.filter(p => p.id !== socket.id);
    io.emit('updatePlayers', players);
  });

  // Desconexión
  socket.on('disconnect', () => {
    players = players.filter(p => p.id !== socket.id);
    io.emit('updatePlayers', players);
  });
});

const PORT = process.env.PORT || 3000; 
server.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
