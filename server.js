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

let players = [];             // Lista de jugadores
let blackCards = [];          // Mazo barajado de cartas negras
let whiteCards = [];          // Mazo barajado de cartas blancas
let currentSubmissions = [];  // Cartas enviadas en esta ronda
let currentZarIndex = 0;      // Índice del Zar
let extraDiscardTimer = null; // Para el setTimeout
let timeLeft = 0;             // Tiempo que queda en la fase de descarte
let discardInterval = null;   // Para el setInterval

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// Inicia una nueva ronda
function startNewRound() {
  // 1. Retirar al Zar anterior
  players[currentZarIndex].isCzar = false;

  // 2. Avanzar el Zar
  currentZarIndex = (currentZarIndex + 1) % players.length;
  players[currentZarIndex].isCzar = true;

  // 3. Sacar carta negra
  const currentBlackCard = blackCards.shift();

  // 4. Avisar roundStarted
  io.emit('roundStarted', {
    blackCard: currentBlackCard,
    players: players.map(({ id, name, points, isCzar }) => ({
      id, name, points, isCzar
    }))
  });

  // 5. Reenviar la mano a cada jugador
  players.forEach((p) => {
    p.hasDiscarded = false;  // Reset “hasDiscarded” al comenzar ronda
    io.to(p.id).emit('yourHand', { cards: p.cards });
  });

  // 6. Limpiar submissions
  currentSubmissions = [];
}

// Verifica si todos ya descartaron
function checkAllDiscarded() {
  const stillDiscarding = players.filter(p => p.hasDiscarded === false && !p.isCzar);
  // El Zar también puede descartar, si quieres...  
  // Podrías excluir al Zar si no debe descartar. Ajusta según tu regla.
  if (stillDiscarding.length === 0) {
    // Todos descartaron => terminar la fase extra
    clearTimeout(extraDiscardTimer);
    clearInterval(discardInterval);
    io.emit('discardPhaseEnded');
    startNewRound();
  } else {
    // Avisar quién está descartando
    const names = stillDiscarding.map(p => p.name);
    io.emit('discardingStatus', { 
      stillDiscarding: names
    });
  }
}

// Maneja la fase de descarte extra (15s) después de elegir ganador
function startExtraDiscardPhase() {
  timeLeft = 15;
  // Avisar a todos
  io.emit('extraDiscardTime', { seconds: timeLeft });

  // Repetir cada segundo para actualizar “timeLeft” y checkAllDiscarded
  discardInterval = setInterval(() => {
    timeLeft--;
    if (timeLeft <= 0) {
      clearInterval(discardInterval);
    }
    io.emit('updateDiscardTime', { timeLeft });
  }, 1000);

  // Cuando pase el tiempo, iniciamos la siguiente ronda (si no acabó antes)
  extraDiscardTimer = setTimeout(() => {
    io.emit('discardPhaseEnded');
    startNewRound();
  }, 15000);
}

// Conexiones
io.on('connection', (socket) => {
  console.log('Nuevo cliente conectado:', socket.id);

  // Unirse
  socket.on('joinGame', (playerName) => {
    players.push({
      id: socket.id,
      name: playerName,
      points: 0,
      cards: [],
      isCzar: false,
      hasDiscarded: false // Para saber si ya descartó
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

    // Barajar
    blackCards = shuffleArray([...blackCardsData]);
    whiteCards = shuffleArray([...whiteCardsData]);

    // Repartir 8 cartas a cada jugador
    players.forEach((p) => {
      p.cards = whiteCards.splice(0, 8);
      p.points = 0;
      p.isCzar = false;
      p.hasDiscarded = false;
    });

    // Asignar ZAR
    currentZarIndex = 0;
    players[currentZarIndex].isCzar = true;

    // Sacar carta negra
    const currentBlackCard = blackCards.shift();

    // Emitir roundStarted
    io.emit('roundStarted', {
      blackCard: currentBlackCard,
      players: players.map(({ id, name, points, isCzar }) => ({
        id, name, points, isCzar
      }))
    });

    // Enviar mano
    players.forEach((pl) => {
      io.to(pl.id).emit('yourHand', { cards: pl.cards });
    });

    currentSubmissions = [];
  });

  // submitCards -> 1 carta
  socket.on('submitCards', ({ chosenCard }) => {
    const player = players.find(p => p.id === socket.id);
    if (!player || player.isCzar) {
      return;
    }

    // Agregamos la submission
    currentSubmissions.push({
      submissionId: `${socket.id}-${chosenCard.id}`,
      playerId: player.id,
      cardId: chosenCard.id
    });

    // Quitar de la mano
    player.cards = player.cards.filter(c => c.id !== chosenCard.id);

    // Revisa si TODOS los no-Zar enviaron
    const nonZarPlayers = players.filter(p => !p.isCzar);
    if (currentSubmissions.length === nonZarPlayers.length) {
      // Todos enviaron -> mostrar
      const submissionsToShow = currentSubmissions.map((s) => {
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

    // Sumar punto
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

    // Iniciar fase extra de descarte
    startExtraDiscardPhase();
  });

  // Descartar en cualquier momento (hasta 3)
  socket.on('requestDiscard', ({ discardCardIds }) => {
    const player = players.find(p => p.id === socket.id);
    if (!player) return;

    if (player.hasDiscarded) {
        // ignorar o mandar un mensaje
        io.to(player.id).emit('errorMessage', { message: 'Solo puedes descartar una vez por ronda.' });
        return;
      }

    if (discardCardIds.length > 3) {
      return; // ignora
    }

    // Quitar
    player.cards = player.cards.filter(c => !discardCardIds.includes(c.id));

    // Repartir hasta 8
    while (player.cards.length < 8 && whiteCards.length > 0) {
      player.cards.push(whiteCards.shift());
    }

    // Marcar que ya descartó
    player.hasDiscarded = true;

    // Actualizar mano
    io.to(player.id).emit('updateHand', { cards: player.cards });

    // Chequear si todos ya descartaron
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

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
