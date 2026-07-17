# Minimal Dockerfile for Neo Writer
FROM node:20-alpine

# Create app directory
WORKDIR /usr/src/app

# Install dependencies (use package-lock.json when present)
COPY package*.json ./
RUN npm ci --only=production

# Copy app sources
COPY . .

# Ensure data directory exists and is writable by the node user
RUN mkdir -p data && chown -R node:node /usr/src/app/data

# Run as non-root user
USER node

EXPOSE 3000
ENV PORT=3000

CMD ["npm", "start"]