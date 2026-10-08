# Minimal Dockerfile for Neo Writer
FROM node:22-alpine

# Create app directory
WORKDIR /usr/src/app

# Install all dependencies (including devDeps needed for the build step below)
COPY package*.json ./
RUN npm ci

# Copy app sources
COPY . .

# Copy vendored browser libraries from devDeps — versions pinned by package-lock.json
RUN cp node_modules/dompurify/dist/purify.min.js public/purify.min.js \
 && cp node_modules/mermaid/dist/mermaid.min.js public/mermaid.min.js \
 && cp node_modules/marked/marked.min.js public/marked.min.js

# Drop devDependencies from the final image
RUN npm prune --omit=dev

# Ensure data directory exists and is writable by the node user
RUN mkdir -p data && chown -R node:node /usr/src/app/data

# Run as non-root user
USER node

EXPOSE 3000
ENV PORT=3000

CMD ["npm", "start"]
