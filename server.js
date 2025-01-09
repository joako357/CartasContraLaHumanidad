/******************************************************
 * server.js
 ******************************************************/
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

// Tus archivos de cartas
const blackCardsData = require('./blackCards.js');
const whiteCardsData = require('./whiteCards.js');

// Función para barajar
function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

let players = [];             // Lista de jugadores
let blackCards = [];          // Mazo barajado (cartas negras)
let whiteCards = [];          // Mazo barajado (cartas blancas)
let currentSubmissions = [];  // Cartas enviadas en la ronda

let currentZarIndex = 0;
let gameInProgress = false;
let hostId = null;

// Manejo de descarte tras elegir ganador
let discardTimer = null;      // setTimeout
let discardInterval = null;   // setInterval
let discardTimeLeft = 0;
let discardPhaseActive = false;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

/******************************************************
 * Manejo de Rondas
 ******************************************************/
function startNewRound() {
  // Quitar descartar
  discardPhaseActive = false;

  // Pasar al siguiente Zar
  players[currentZarIndex].isCzar = false;
  currentZarIndex = (currentZarIndex + 1) % players.length;
  players[currentZarIndex].isCzar = true;

  // Sacar la siguiente carta negra
  const currentBlackCard = blackCards.shift();

  io.emit('showIntermediate', {  // Pantalla intermedia por 3s
    message: "Siguiente ronda en 3 segundos..."
  });

  setTimeout(() => {
    // Enviamos roundStarted
    io.emit('roundStarted', {
      blackCard: currentBlackCard,
      players: players.map(p => ({
        id: p.id,
        name: p.name,
        points: p.points,
        isCzar: p.isCzar
      }))
    });

    // Resetear “hasDiscarded” para la nueva ronda y reenviar manos
    players.forEach(pl => {
      pl.hasDiscarded = false;
      io.to(pl.id).emit('yourHand', { cards: pl.cards });
    });

    currentSubmissions = [];

  }, 3000);
}

function startDiscardPhase() {
  discardPhaseActive = true;
  discardTimeLeft = 10; // Ajusta a tu gusto (10 seg)

  // Anunciamos: “X, Y, Z todavía no descartaron. Tienen N seg…”
  broadcastStillDiscarding();

  // Contador decreciente
  discardInterval = setInterval(() => {
    discardTimeLeft--;
    broadcastStillDiscarding();

    if (discardTimeLeft <= 0) {
      clearInterval(discardInterval);
    }
  }, 1000);

  // Al acabar el tiempo, si alguien no descartó, se queda con su mano
  discardTimer = setTimeout(() => {
    discardPhaseActive = false;
    clearInterval(discardInterval);

    // Todos finalizan la fase de descarte
    io.emit('discardPhaseEnded');
    // Iniciar la siguiente ronda
    startNewRound();
  }, discardTimeLeft * 1000);
}

// Emite quiénes faltan descartar y tiempo restante
function broadcastStillDiscarding() {
  const still = players.filter(p => !p.hasDiscarded);
  if (still.length === 0) {
    // Nadie falta, terminamos antes
    clearTimeout(discardTimer);
    clearInterval(discardInterval);
    discardPhaseActive = false;
    io.emit('discardPhaseEnded');
    startNewRound();
    return;
  }
  // Mandamos la lista y el tiempo
  io.emit('stillDiscarding', {
    names: still.map(p => p.name),
    timeLeft: discardTimeLeft
  });
}

/******************************************************
 * Socket.IO main logic
 ******************************************************/
io.on('connection', (socket) => {
  console.log('Cliente conectado:', socket.id);

  // Unirse al lobby
  socket.on('joinGame', (playerName) => {
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

    // Solo mostrar nombres en el lobby
    io.emit('updatePlayers', {
      players: players.map(p => ({ name: p.name }))
    });
  });

  // Iniciar la partida
  socket.on('startGame', () => {
    if (players.length < 3) {
      io.to(socket.id).emit('errorMessage', {
        message: 'Se necesitan al menos 3 jugadores para iniciar la partida.'
      });
      return;
    }

    if (!hostId) {
      hostId = socket.id;
      io.to(hostId).emit('youAreHost');
    }

    gameInProgress = true;

    // Barajar mazos
    blackCards = shuffleArray([...blackCardsData]);
    whiteCards = shuffleArray([...whiteCardsData]);

    // Repartir
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
  });

  // Enviar 1 carta
  socket.on('submitCards', ({ chosenCard }) => {
    const player = players.find(p => p.id === socket.id);
    if (!player || player.isCzar) return;

    currentSubmissions.push({
      submissionId: socket.id + '-' + chosenCard.id,
      playerId: player.id,
      cardId: chosenCard.id
    });

    // Quitar la carta
    player.cards = player.cards.filter(c => c.id !== chosenCard.id);

    // Si todos los no-Zar enviaron
    const nonZarPlayers = players.filter(x => !x.isCzar);
    if (currentSubmissions.length === nonZarPlayers.length) {
      const submissionsToShow = currentSubmissions.map(s => {
        const cardObj = whiteCardsData.find(w => w.id === s.cardId);
        return {
          submissionId: s.submissionId,
          text: cardObj ? cardObj.text : "???",
          playerId: s.playerId
        };
      });
      io.emit('showSubmissions', submissionsToShow);
    }
  });

  // El Zar elige ganador
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

    // Aquí empieza la fase de descarte SOLO después de que el Zar elige
    startDiscardPhase();
  });

  // Descartar
  socket.on('requestDiscard', ({ discardCardIds }) => {
    const player = players.find(p => p.id === socket.id);
    if (!player) return;

    if (player.hasDiscarded) {
      io.to(player.id).emit('errorMessage', {
        message: 'Solo puedes descartar una vez por ronda.'
      });
      return;
    }
    if (discardCardIds.length > 3) {
      return;
    }

    player.cards = player.cards.filter(c => !discardCardIds.includes(c.id));
    while (player.cards.length < 8 && whiteCards.length > 0) {
      player.cards.push(whiteCards.shift());
    }
    player.hasDiscarded = true;

    io.to(player.id).emit('updateHand', { cards: player.cards });

    if (discardPhaseActive) {
      broadcastStillDiscarding();
    }
  });

  // Terminar el juego (host)
  socket.on('endGame', () => {
    if (socket.id !== hostId) {
      io.to(socket.id).emit('errorMessage', {
        message: 'No tienes permiso para terminar la partida.'
      });
      return;
    }

    gameInProgress = false;
    discardPhaseActive = false;
    clearTimeout(discardTimer);
    clearInterval(discardInterval);

    // Puntajes finales
    const sorted = [...players].sort((a, b) => b.points - a.points);

    io.emit('gameEnded', {
      scores: sorted.map(p => ({ name: p.name, points: p.points }))
    });

    // Reset
    players = [];
    hostId = null;
    console.log("Partida terminada por el host.");
  });

  // Desconexión voluntaria
  socket.on('disconnectPlayer', () => {
    players = players.filter(p => p.id !== socket.id);
    io.emit('updatePlayers', {
      players: players.map(px => ({ name: px.name }))
    });

    if (players.length === 0) {
      gameInProgress = false;
      hostId = null;
      console.log('No hay jugadores, se resetea la partida.');
    }
  });

  // Desconexión real
  socket.on('disconnect', () => {
    players = players.filter(p => p.id !== socket.id);
    io.emit('updatePlayers', {
      players: players.map(px => ({ name: px.name }))
    });

    if (players.length === 0) {
      gameInProgress = false;
      hostId = null;
      console.log('No hay jugadores, se resetea la partida.');
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
