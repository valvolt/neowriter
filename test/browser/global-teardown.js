const path = require('path');
const fs = require('fs').promises;

module.exports = async function globalTeardown() {
  await Promise.all([
    fs.rm(path.join(__dirname, '..', '..', 'data_test'), { recursive: true, force: true }).catch(() => {}),
    fs.rm(path.join(__dirname, '..', '..', 'data_test_hosted'), { recursive: true, force: true }).catch(() => {}),
  ]);
};
