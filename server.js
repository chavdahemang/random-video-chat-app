const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const winston = require('winston');

// ===== LOGGER SETUP =====
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
    new winston.transports.Console({ format: winston.format.simple() })
  ]
});

const app = express();

// ===== RATE LIMITING =====
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP'
});
app.use('/api/', limiter);

// ===== CORS CONFIGURATION FOR PRODUCTION =====
// Reads FRONTEND_URL env var set on Railway; supports comma-separated list of origins
const buildAllowedOrigins = () => {
  const base = [
    'http://localhost:3000',
    'https://localhost:3000'
  ];
  if (process.env.FRONTEND_URL) {
    // Support multiple origins separated by commas
    const envOrigins = process.env.FRONTEND_URL.split(',').map(o => o.trim()).filter(Boolean);
    return [...new Set([...base, ...envOrigins])];
  }
  // In development (no FRONTEND_URL set), allow all
  return process.env.NODE_ENV === 'production' ? base : ['*'];
};

const allowedOrigins = buildAllowedOrigins();
logger.info('Allowed CORS origins:', allowedOrigins);

app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    // Allow all in non-production when no FRONTEND_URL is set
    if (allowedOrigins.includes('*')) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: allowedOrigins.includes('*') ? '*' : allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true
  },
  // Production optimizations
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'],
  allowEIO3: true
});

// ===== CONFIGURATION =====
const MAX_WAITING_USERS = 1000;
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const CONNECTION_TIMEOUT = 60000; // 60 seconds

// ===== DATA STORAGE =====
let waitingUsers = [];
let onlineUsers = new Map(); // socket.id -> { lastHeartbeat, connectedAt }
let activePairs = new Map(); // socket.id -> partnerId
let userMetadata = new Map(); // socket.id -> { ip, userAgent, connectedAt }

// ===== HELPER FUNCTIONS =====
function removeFromWaiting(socketId) {
  const index = waitingUsers.indexOf(socketId);
  if (index > -1) {
    waitingUsers.splice(index, 1);
    return true;
  }
  return false;
}

function addToWaiting(socketId) {
  if (!waitingUsers.includes(socketId) && waitingUsers.length < MAX_WAITING_USERS) {
    waitingUsers.push(socketId);
    return true;
  }
  return false;
}

function cleanupDisconnectedUser(socketId) {
  // Remove from waiting list
  removeFromWaiting(socketId);
  
  // Remove from active pairs
  const partnerId = activePairs.get(socketId);
  if (partnerId) {
    const partnerSocket = io.sockets.sockets.get(partnerId);
    if (partnerSocket && partnerSocket.connected) {
      partnerSocket.emit('partner-left', { reason: 'partner_disconnected' });
      // Add partner back to waiting queue
      addToWaiting(partnerId);
      partnerSocket.emit('waiting');
    }
    activePairs.delete(partnerId);
    activePairs.delete(socketId);
  }
  
  // Clean up metadata
  onlineUsers.delete(socketId);
  userMetadata.delete(socketId);
}

function tryMatch() {
  try {
    // Process as many pairs as possible
    while (waitingUsers.length >= 2) {
      const user1Id = waitingUsers.shift();
      const user2Id = waitingUsers.shift();
      
      const socket1 = io.sockets.sockets.get(user1Id);
      const socket2 = io.sockets.sockets.get(user2Id);
      
      // Verify both sockets are still connected
      if (socket1 && socket2 && socket1.connected && socket2.connected) {
        // Create the pair
        activePairs.set(user1Id, user2Id);
        activePairs.set(user2Id, user1Id);
        
        // Notify both users
        socket1.emit('paired', { 
          partnerId: user2Id, 
          initiator: true,
          timestamp: Date.now()
        });
        
        socket2.emit('paired', { 
          partnerId: user1Id, 
          initiator: false,
          timestamp: Date.now()
        });
        
        logger.info(`Paired users: ${user1Id} with ${user2Id}`);
      } else {
        // If either socket is invalid, put back the valid one
        if (socket1 && socket1.connected) addToWaiting(user1Id);
        if (socket2 && socket2.connected) addToWaiting(user2Id);
      }
    }
  } catch (error) {
    logger.error('Error in tryMatch:', error);
  }
}

// ===== HEARTBEAT SYSTEM =====
setInterval(() => {
  const now = Date.now();
  for (const [socketId, data] of onlineUsers.entries()) {
    if (now - data.lastHeartbeat > CONNECTION_TIMEOUT) {
      const socket = io.sockets.sockets.get(socketId);
      if (socket && socket.connected) {
        logger.warn(`User ${socketId} heartbeat timeout, disconnecting`);
        socket.disconnect(true);
      }
    }
  }
}, HEARTBEAT_INTERVAL);

// ===== SOCKET.IO EVENT HANDLERS =====
io.on('connection', (socket) => {
  const connectedAt = Date.now();
  
  // Store metadata
  userMetadata.set(socket.id, {
    ip: socket.handshake.address,
    userAgent: socket.handshake.headers['user-agent'],
    connectedAt
  });
  
  onlineUsers.set(socket.id, {
    lastHeartbeat: connectedAt,
    connectedAt
  });
  
  logger.info(`User connected: ${socket.id}`, {
    ip: socket.handshake.address,
    userAgent: socket.handshake.headers['user-agent']
  });
  
  // Broadcast online users count
  io.emit("online-users", onlineUsers.size);
  
  // ===== HEARTBEAT HANDLER =====
  socket.on('heartbeat', () => {
    if (onlineUsers.has(socket.id)) {
      onlineUsers.set(socket.id, {
        ...onlineUsers.get(socket.id),
        lastHeartbeat: Date.now()
      });
    }
  });
  
  // ===== FIND PARTNER HANDLER =====
  socket.on('find-partner', () => {
    try {
      logger.info(`${socket.id} looking for partner. Queue size: ${waitingUsers.length}`);
      
      // Remove from any existing waiting or pairing
      removeFromWaiting(socket.id);
      
      const existingPartner = activePairs.get(socket.id);
      if (existingPartner) {
        socket.emit('error', { message: 'Already in a call. Please end current call first.' });
        return;
      }
      
      // Add to waiting queue
      if (addToWaiting(socket.id)) {
        socket.emit('waiting');
        tryMatch();
      } else {
        socket.emit('error', { message: 'Server is busy. Please try again later.' });
      }
    } catch (error) {
      logger.error('Error in find-partner:', error);
      socket.emit('error', { message: 'Internal server error' });
    }
  });
  
  // ===== SIGNAL HANDLER =====
  socket.on('signal', ({ to, signal }) => {
    try {
      // Verify the connection still exists
      const partnerId = activePairs.get(socket.id);
      if (partnerId !== to) {
        logger.warn(`Signal mismatch: ${socket.id} trying to signal ${to} but paired with ${partnerId}`);
        return;
      }
      
      const targetSocket = io.sockets.sockets.get(to);
      if (targetSocket && targetSocket.connected) {
        targetSocket.emit('signal', {
          from: socket.id,
          signal: signal,
          timestamp: Date.now()
        });
      } else {
        logger.warn(`Target socket ${to} not found for signal from ${socket.id}`);
        socket.emit('error', { message: 'Partner disconnected' });
      }
    } catch (error) {
      logger.error('Error in signal handler:', error);
    }
  });
  
  // ===== SKIP HANDLER =====
  socket.on('skip', () => {
    try {
      logger.info(`${socket.id} skipped`);
      
      const partnerId = activePairs.get(socket.id);
      
      if (partnerId) {
        // User was in an active call
        const partnerSocket = io.sockets.sockets.get(partnerId);
        
        if (partnerSocket && partnerSocket.connected) {
          partnerSocket.emit('partner-left', { reason: 'user_skipped' });
          // Add partner back to waiting queue
          if (addToWaiting(partnerId)) {
            partnerSocket.emit('waiting');
          }
        }
        
        // Clean up the pair
        activePairs.delete(partnerId);
        activePairs.delete(socket.id);
        
        // Add current user back to waiting queue
        if (addToWaiting(socket.id)) {
          socket.emit('waiting');
        }
        
        // Try to match remaining users
        tryMatch();
      } else {
        // User was just waiting (Cancel button)
        removeFromWaiting(socket.id);
        logger.info(`${socket.id} canceled waiting`);
        socket.emit('waiting-cancelled');
      }
    } catch (error) {
      logger.error('Error in skip handler:', error);
      socket.emit('error', { message: 'Failed to skip partner' });
    }
  });
  
  // ===== CHAT MESSAGE HANDLER =====
  socket.on("chat-message", ({ to, message }) => {
    try {
      // Validate message
      if (!message || message.length > 500) {
        socket.emit('error', { message: 'Invalid message length' });
        return;
      }
      
      // Sanitize message (basic XSS prevention)
      const sanitizedMessage = message
        .replace(/[<>]/g, '')
        .substring(0, 500);
      
      const partner = io.sockets.sockets.get(to);
      if (partner && partner.connected) {
        partner.emit("chat-message", {
          from: socket.id,
          message: sanitizedMessage,
          timestamp: Date.now()
        });
      }
    } catch (error) {
      logger.error('Error in chat-message:', error);
    }
  });
  
  // ===== DISCONNECT HANDLER =====
  socket.on('disconnect', (reason) => {
    try {
      logger.info(`User disconnected: ${socket.id}, reason: ${reason}`);
      
      cleanupDisconnectedUser(socket.id);
      
      // Broadcast updated online count
      io.emit("online-users", onlineUsers.size);
      
      // Try to match remaining users
      tryMatch();
    } catch (error) {
      logger.error('Error in disconnect handler:', error);
    }
  });
  
  // ===== ERROR HANDLER =====
  socket.on('error', (error) => {
    logger.error(`Socket error for ${socket.id}:`, error);
  });
});

// ===== HEALTH CHECK ENDPOINT =====
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: Date.now(),
    onlineUsers: onlineUsers.size,
    waitingUsers: waitingUsers.length,
    activePairs: activePairs.size / 2,
    uptime: process.uptime()
  });
});

// ===== METRICS ENDPOINT (protected, for monitoring) =====
app.get('/metrics', (req, res) => {
  // Add authentication in production
  res.json({
    onlineUsers: onlineUsers.size,
    waitingUsers: waitingUsers.length,
    activeCalls: activePairs.size / 2,
    totalConnections: onlineUsers.size,
    memoryUsage: process.memoryUsage(),
    uptime: process.uptime()
  });
});

// ===== ERROR HANDLING MIDDLEWARE =====
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ===== GRACEFUL SHUTDOWN =====
process.on('SIGTERM', () => {
  logger.info('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT signal received: closing HTTP server');
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
});

// ===== START SERVER =====
const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
  logger.info(`🚀 Server running on port ${PORT}`);
  logger.info(`Health check: http://localhost:${PORT}/health`);
  
  // Get all network interfaces
  const networkInterfaces = require('os').networkInterfaces();
  Object.keys(networkInterfaces).forEach((interfaceName) => {
    networkInterfaces[interfaceName].forEach((details) => {
      if (details.family === 'IPv4' && !details.internal) {
        logger.info(`Network: http://${details.address}:${PORT}`);
      }
    });
  });
});

// ===== UNHANDLED REJECTIONS =====
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});