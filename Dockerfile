FROM node:22-slim

WORKDIR /app

# Install dependencies
RUN apt-get update \
    && apt-get install -y --no-install-recommends git openssh-client ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

RUN git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"

RUN npm install -g openclaw@latest

# Copy workspace
COPY . .

# OpenClaw expects some identity/state paths under ~/.openclaw.
# In our container we persist state at /app/state, so point ~/.openclaw -> /app/state.
RUN rm -rf /home/node/.openclaw \
    && ln -s /app/state /home/node/.openclaw

# Start the Gateway (heartbeats + cron run inside it)
CMD ["openclaw", "gateway"]
