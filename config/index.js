// config/index.js
const path = require("path");
require("dotenv").config();

const ROOT = __dirname.endsWith("config")
  ? path.resolve(__dirname, "..")
  : __dirname;


const DATA_DIR = path.join(ROOT, "data");

// Ensure base data directory exists (used at startup)
async function ensureDataDir() {
  const fs = require("fs");
  await fs.promises.mkdir(DATA_DIR, { recursive: true });
}

module.exports = {
  PORT: process.env.PORT || 3000,
  MODE: process.env.MODE,
  CLIENT_ID: process.env.CLIENT_ID,
  SECRET: process.env.SECRET,
  BASE_URL: process.env.BASE_URL,
  ISSUER_BASE_URL: process.env.ISSUER_BASE_URL,
  ROOT,
  DATA_DIR,
  PUBLIC_DIR: path.join(ROOT, "public"),
  DEFAULT_USER: "anonymous",
  ensureDataDir,
};