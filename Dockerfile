FROM node:18-slim

# Install Python and required system dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    procps \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Create symlink for python
RUN ln -s /usr/bin/python3 /usr/bin/python

# Install PM2 globally
RUN npm install -g pm2

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy all source files
COPY . .

# Create required directories
RUN mkdir -p uploads bots

# Expose port (Hugging Face uses 7860)
EXPOSE 7860

# Set environment variables
ENV NODE_ENV=production
ENV PORT=7860

# Start the application
CMD ["node", "server.js"]
