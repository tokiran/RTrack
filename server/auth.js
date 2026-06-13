const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET === 'change-me-to-a-long-random-string') {
  console.error(
    'JWT_SECRET is not set. Copy .env.example to .env and set a real secret.'
  );
  process.exit(1);
}

const TOKEN_LIFETIME = '7d';

function signToken(user) {
  return jwt.sign({ sub: user.id, username: user.username }, SECRET, {
    expiresIn: TOKEN_LIFETIME,
  });
}

function verifyToken(token) {
  return jwt.verify(token, SECRET); // throws on invalid/expired
}

module.exports = { signToken, verifyToken };
