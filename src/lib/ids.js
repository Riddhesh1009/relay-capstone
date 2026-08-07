const { v4: uuidv4 } = require('uuid');

function id(prefix) {
  return `${prefix}_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
}

module.exports = { id };
