const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dbDir = path.join(__dirname, '../data');
const usersPath = path.join(dbDir, 'users.db');

const sessions = new Map();

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function initAuthDb() {
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  if (!fs.existsSync(usersPath)) {
    const defaultUsers = [
      {
        id: 'usr-admin',
        username: 'admin',
        password: hashPassword('admin123'),
        role: 'admin',
        assignedDevices: [] // Admin has access to all devices
      }
    ];
    fs.writeFileSync(usersPath, JSON.stringify(defaultUsers, null, 2), 'utf8');
  }
}

function getUsers() {
  initAuthDb();
  try {
    const content = fs.readFileSync(usersPath, 'utf8');
    return JSON.parse(content) || [];
  } catch (error) {
    console.error('Error reading users.db:', error);
    return [];
  }
}

function saveUsers(users) {
  initAuthDb();
  try {
    fs.writeFileSync(usersPath, JSON.stringify(users, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error('Error writing to users.db:', error);
    return false;
  }
}

function authenticate(username, password) {
  const users = getUsers();
  const cleanUsername = String(username || '').trim().toLowerCase();
  const user = users.find(u => u.username.toLowerCase() === cleanUsername);
  
  if (!user) return null;
  
  const hashed = hashPassword(password);
  if (user.password !== hashed) return null;
  
  // Create secure session token
  const token = crypto.randomBytes(24).toString('hex');
  const userSessionProfile = {
    id: user.id,
    username: user.username,
    role: user.role,
    assignedDevices: user.assignedDevices || []
  };
  
  sessions.set(token, userSessionProfile);
  return { token, user: userSessionProfile };
}

function getSession(token) {
  if (!token) return null;
  return sessions.get(token) || null;
}

function removeSession(token) {
  if (!token) return false;
  return sessions.delete(token);
}

function createUser(userData) {
  const users = getUsers();
  const username = String(userData.username || '').trim();
  
  // Check duplicate username
  const exists = users.some(u => u.username.toLowerCase() === username.toLowerCase());
  if (exists) {
    throw new Error('El nombre de usuario ya existe.');
  }
  
  const newUser = {
    id: `usr-${Date.now()}`,
    username,
    password: hashPassword(userData.password || '123456'),
    role: userData.role === 'admin' ? 'admin' : 'user',
    assignedDevices: Array.isArray(userData.assignedDevices) ? userData.assignedDevices : []
  };
  
  users.push(newUser);
  saveUsers(users);
  
  return {
    id: newUser.id,
    username: newUser.username,
    role: newUser.role,
    assignedDevices: newUser.assignedDevices
  };
}

function updateUser(id, data) {
  const users = getUsers();
  const index = users.findIndex(u => String(u.id) === String(id));
  if (index === -1) {
    throw new Error('Usuario no encontrado.');
  }
  
  // Check unique username if username is changing
  if (data.username && data.username.toLowerCase() !== users[index].username.toLowerCase()) {
    const exists = users.some(u => u.username.toLowerCase() === data.username.toLowerCase());
    if (exists) {
      throw new Error('El nombre de usuario ya existe.');
    }
    users[index].username = String(data.username).trim();
  }
  
  if (data.password) {
    users[index].password = hashPassword(data.password);
  }
  
  if (data.role) {
    users[index].role = data.role === 'admin' ? 'admin' : 'user';
  }
  
  if (Array.isArray(data.assignedDevices)) {
    users[index].assignedDevices = data.assignedDevices;
  }
  
  saveUsers(users);
  
  // Update active sessions if the user is logged in
  for (const [token, sessionUser] of sessions.entries()) {
    if (String(sessionUser.id) === String(id)) {
      sessions.set(token, {
        id: users[index].id,
        username: users[index].username,
        role: users[index].role,
        assignedDevices: users[index].assignedDevices
      });
    }
  }
  
  return {
    id: users[index].id,
    username: users[index].username,
    role: users[index].role,
    assignedDevices: users[index].assignedDevices
  };
}

function deleteUser(id) {
  if (id === 'usr-admin') {
    throw new Error('No se puede eliminar el usuario administrador por defecto.');
  }
  
  const users = getUsers();
  const filtered = users.filter(u => String(u.id) !== String(id));
  saveUsers(filtered);
  
  // Clear any active sessions for deleted user
  for (const [token, sessionUser] of sessions.entries()) {
    if (String(sessionUser.id) === String(id)) {
      sessions.delete(token);
    }
  }
  
  return true;
}

module.exports = {
  authenticate,
  getSession,
  removeSession,
  getUsers,
  createUser,
  updateUser,
  deleteUser
};
