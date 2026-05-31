const mongoose = require('mongoose');
const logger = require('../utils/logger');

async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');

  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10_000,
    maxPoolSize: 20
  });
  logger.info('mongo_connected', { host: mongoose.connection.host, db: mongoose.connection.name });

  mongoose.connection.on('disconnected', () => logger.warn('mongo_disconnected'));
  mongoose.connection.on('error', (err) => logger.error('mongo_error', { err: err.message }));
}

module.exports = { connectDB };
