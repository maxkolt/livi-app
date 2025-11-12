// cleanup-test-users.js
// Скрипт для очистки тестовых пользователей из MongoDB

const mongoose = require('mongoose');
require('dotenv').config();

// Подключаемся к MongoDB
const MONGO_URI = process.env.MONGO_DB || process.env.MONGODB_URI || process.env.MONGO_URI || '';

if (!MONGO_URI) {
  console.error('Missing MONGO_URI environment variable');
  process.exit(1);
}

// Схема пользователя
const userSchema = new mongoose.Schema({
  nick: String,
  avatar: String,
  friends: [mongoose.Schema.Types.ObjectId],
  friendRequests: [mongoose.Schema.Types.ObjectId],
}, { timestamps: true, collection: 'users' });

const User = mongoose.model('User', userSchema);

async function cleanupTestUsers() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGO_URI);
    console.log('Connected to MongoDB');

    // Находим всех пользователей с тестовыми никнеймами
    const testUsers = await User.find({
      nick: { $regex: /^TestUser_/ }
    });

    console.log(`Found ${testUsers.length} test users:`);
    testUsers.forEach(user => {
      console.log(`- ${user._id}: ${user.nick}`);
    });

    if (testUsers.length === 0) {
      console.log('No test users found');
      return;
    }

    // Удаляем тестовых пользователей
    const result = await User.deleteMany({
      nick: { $regex: /^TestUser_/ }
    });

    console.log(`Deleted ${result.deletedCount} test users`);

    // Показываем оставшихся пользователей
    const remainingUsers = await User.find({});
    console.log(`\nRemaining users (${remainingUsers.length}):`);
    remainingUsers.forEach(user => {
      console.log(`- ${user._id}: ${user.nick || '(no nick)'}`);
    });

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

cleanupTestUsers();
