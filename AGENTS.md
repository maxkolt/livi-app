# AGENTS.md

## Cursor Cloud specific instructions

### Project overview

LiVi is a mobile video chat app: React Native/Expo frontend + Node.js/Express backend with Socket.IO. See `README.md` and `docs/RUN_WITHOUT_DOCKER.md` for standard usage.

### Backend (`/backend`)

- **Dev server**: `npm run dev` (uses `ts-node-dev`, port 3000)
- **Build**: `npm run build` (TypeScript compilation)
- **TypeScript check**: `npx tsc --noEmit`
- **Health check**: `curl http://localhost:3000/health`
- Requires `backend/.env` with at minimum `MONGO_URI`. LiveKit vars (`LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_URL`) are recommended but the server starts without them (logs warnings).
- Redis is optional for local dev; the backend falls back to in-memory stores when `REDIS_URL` is not set.

### MongoDB (required)

- Must run as a **replica set** (even single-node) because the backend uses Mongoose transactions (`identity:attach` flow).
- Start: `mongod --dbpath /data/db --bind_ip 127.0.0.1 --port 27017 --replSet rs0`
- Initialize once: `mongosh --eval "rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: '127.0.0.1:27017' }] })"`
- Connection string with replica set: `mongodb://127.0.0.1:27017/livi-dev?replicaSet=rs0`

### Frontend (`/frontend`)

- **Install**: `npm install` (runs `postinstall` patch script; some patch warnings are expected and harmless)
- **TypeScript check**: `npx tsc --noEmit` (3 pre-existing type errors in `ChatScreen.tsx`, `HomeScreen.tsx`, `pushNotifications.ts` — not caused by setup)
- **Tests**: `npm test` (jest; no test files exist currently)
- This is a React Native/Expo app — it cannot be tested in a browser. It requires a physical device or emulator with a dev-client build.

### Key caveats

- The `backend/.env` file is git-ignored. Each agent session needs to create it if not present.
- Some frontend `postinstall` patches may warn about already-applied or version-mismatched patches — this is normal and does not break functionality.
- No ESLint config exists in this repo. TypeScript (`tsc --noEmit`) serves as the primary static analysis tool.
