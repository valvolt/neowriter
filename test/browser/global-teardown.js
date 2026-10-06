const path = require('path');
const fs = require('fs').promises;

module.exports = async function globalTeardown() {
  const dataTestDir = path.join(__dirname, '..', '..', 'data_test');
  try {
    await fs.rm(dataTestDir, { recursive: true, force: true });
  } catch (e) {
    // Not a fatal error if the directory doesn't exist
  }
};
