/******************************************************
 * server.js
 ******************************************************/
// 1. Importar módulos
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

// 2. Importar cartas (usa tus archivos blackCards.js y whiteCards.js)
const blackCardsData = require('./blackCards.js');
const whiteCardsData = require('./whiteCards.js');

// 3. Función para barajar arrays
function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// 4. Variables globales
let players = [];
let blackCards = [];
let whiteCards = [];
let currentSubmissions = [];

let currentZarIndex = 0;
let extraDiscardTimer = null;
let discardInterval = null;
let timeLeft = 0;

let gameInProgress = false; // bloquea unirse tras "startGame"
let hostId = null;          // quién es el anfitrión

let extraPhaseActive = false; // Indica si estamos en los 15s extra

// 5. Crear servidor con Express + Socket.IO
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Servir carpeta "public"
app.use(express.static('public'));

// ===================== Reglas de Rondas =====================
function startNewRound() {
  // Salimos de la fase extra, por si quedaba
  extraPhaseActive = false;

  // Retirar al Zar anterior
  players[currentZarIndex].isCzar = false;
  // Avanzar Zar
  currentZarIndex = (currentZarIndex + 1) % players.length;
  players[currentZarIndex].isCzar = true;

  // Siguiente carta negra
  const currentBlackCard = blackCards.shift();

  // Emitir "roundStarted"
  io.emit('roundStarted', {
    blackCard: currentBlackCard,
    players: players.map(({ id, name, points, isCzar }) => ({
      id, name, points, isCzar
    }))
  });

  // Reenviar la mano a cada jugador
  players.forEach(p => {
    p.hasDiscarded = false;
    io.to(p.id).emit('yourHand', { cards: p.cards });
  });

  currentSubmissions = [];
}

function checkAllDiscarded() {
  // Chequeamos solo si estamos en fase extra
  if (!extraPhaseActive) {
    return;
  }
  const stillDiscarding = players.filter(p => !p.hasDiscarded);
  if (stillDiscarding.length === 0) {
    // Todos descartaron antes de que acabe el tiempo
    clearTimeout(extraDiscardTimer);
    clearInterval(discardInterval);
    io.emit('discardPhaseEnded');
    startNewRound();
  } else {
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
    // Si la partida ya arrancó, no permitimos unirse
    if (gameInProgress) {
      socket.emit('errorMessage', {
        message: 'El juego ya está en curso, no puedes unirte ahora.'
      });
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

    // Si no hay host, este socket es el host
    if (!hostId) {
      hostId = socket.id;
      // Notificamos a ese socket que es el host
      io.to(hostId).emit('youAreHost');
    }

    gameInProgress = true;

    // Barajar
    blackCards = shuffleArray([...blackCardsData]);
    whiteCards = shuffleArray([...whiteCardsData]);

    // Repartir 8 cartas a cada jugador
    players.forEach(p => {
      p.cards = whiteCards.splice(0, 8);
      p.points = 0;
      p.isCzar = false;
      p.hasDiscarded = false;
    });

    // Asignar ZAR al primer jugador
    currentZarIndex = 0;
    players[currentZarIndex].isCzar = true;

    const currentBlackCard = blackCards.shift();

    // Emitir roundStarted
    io.emit('roundStarted', {
      blackCard: currentBlackCard,
      players: players.map(({ id, name, points, isCzar }) => ({
        id, name, points, isCzar
      }))
    });

    // Enviar la mano a cada jugador
    players.forEach((pl) => {
      io.to(pl.id).emit('yourHand', { cards: pl.cards });
    });

    currentSubmissions = [];
  });

  // Evento: enviar 1 carta
  socket.on('submitCards', ({ chosenCard }) => {
    const player = players.find(p => p.id === socket.id);
    if (!player) return;
    // El Zar no envía
    if (player.isCzar) {
      return;
    }

    currentSubmissions.push({
      submissionId: `${socket.id}-${chosenCard.id}`,
      playerId: player.id,
      cardId: chosenCard.id
    });

    // Quitar de la mano
    player.cards = player.cards.filter(c => c.id !== chosenCard.id);

    // Si todos los no-Zar enviaron
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

  // Evento: el Zar elige ganador
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

    // Entramos en la fase extra para descartar
    startExtraDiscardPhase();
  });

  // Descartar (una sola vez, hasta 3 cartas)
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
      return; // ignora
    }

    // Quitar
    player.cards = player.cards.filter(c => !discardCardIds.includes(c.id));
    while (player.cards.length < 8 && whiteCards.length > 0) {
      player.cards.push(whiteCards.shift());
    }

    player.hasDiscarded = true;

    io.to(player.id).emit('updateHand', { cards: player.cards });

    checkAllDiscarded();
  });

  // Evento: terminar el juego manualmente (solo host)
  socket.on('endGame', () => {
    if (socket.id !== hostId) {
      io.to(socket.id).emit('errorMessage', {
        message: 'No tienes permiso para terminar la partida.'
      });
      return;
    }

    // Fin de la partida
    gameInProgress = false;
    extraPhaseActive = false;

    // Ordenamos jugadores por puntaje
    const sortedPlayers = [...players].sort((a, b) => b.points - a.points);

    // Emitir puntajes finales
    io.emit('gameEnded', {
      scores: sortedPlayers.map(p => ({
        name: p.name,
        points: p.points
      }))
    });

    // Reseteo total
    players = [];
    hostId = null;
    console.log('Juego terminado manualmente por el host.');
  });

  // Desconexión manual
  socket.on('disconnectPlayer', () => {
    players = players.filter(p => p.id !== socket.id);
    io.emit('updatePlayers', players);

    // Si no queda nadie, reset
    if (players.length === 0) {
      gameInProgress = false;
      hostId = null;
      console.log('No hay jugadores; la partida se resetea.');
    }
  });

  // Desconexión automática (cerró pestaña, etc.)
  socket.on('disconnect', () => {
    players = players.filter(p => p.id !== socket.id);
    io.emit('updatePlayers', players);

    // Si no queda nadie, reset
    if (players.length === 0) {
      gameInProgress = false;
      hostId = null;
      console.log('No hay jugadores; la partida se resetea.');
    }
  });
});

// 7. Escuchar en puerto (Railway usará process.env.PORT)
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
