**Packages Used by the Website**

This file documents the npm (and other) packages used by the web server in this repository, what each one does, and where it is used in the codebase.

- **express**: Web framework for routing, middleware and static file serving.
  - Used in: `server.js` (app, routes, `app.use`, `express.static`).

- **dotenv**: Loads environment variables from a `.env` file.
  - Used in: `server.js` via `import 'dotenv/config'`. Also used by Python calendar scripts (`python-dotenv`).

- **bcryptjs**: Pure-JavaScript password hashing and verification.
  - Used in: `server.js` for hashing and comparing passwords for students, scanners and web users (`bcryptjs.hash`, `bcryptjs.compare`).

- **bcrypt**: Native (C++) password hashing library.
  - Used in: `db.js` (some seeding/hashing actions). Note: both `bcrypt` and `bcryptjs` appear in the project — consider standardizing on one.

- **jsonwebtoken**: Create and verify JWTs (tokens).
  - Used in: `server.js` (token creation for web users, students and scanners; `verifyToken` middleware uses it).

- **express-session**: Server-side session management for Express.
  - Used in: `server.js` to store `req.session.user` after logins.

- **express-rate-limit**: Rate limiting middleware to protect endpoints.
  - Used in: `server.js` (login rate limiter, and other places where rate limiting is applied).

- **ws**: WebSocket server implementation.
  - Used in: `server.js` to handle real-time connections between scanners and frontend (`WebSocketServer`, socket handling, ping/pong, messages).

- **pg**: PostgreSQL client.
  - Used in: `db.js` and throughout `server.js` via the `pool` to run SQL queries (users, students, scanners, logs, courses, etc.).

- **node-fetch**: Fetch API for Node.js.
  - Declared in `package.json` but not referenced in `src/web` server code — appears unused (safe to remove unless you plan future server-side HTTP requests).

- **cors**: Cross-Origin Resource Sharing middleware.
  - Used in: `server.js` (`app.use(cors())`) but missing from `package.json` — add to dependencies so installs work.

Other non-npm dependencies used by helper scripts:

- **requests** (Python): Used by `src/web/api/calendar/*.py` scripts to call external calendar APIs.
- **python-dotenv**: Python equivalent of `dotenv`, used by the calendar scripts to load environment variables.

Notes & Recommendations

- Duplicate hashing libs: both `bcrypt` and `bcryptjs` are present; pick one to avoid confusion. `bcrypt` (native) is faster but requires native compilation; `bcryptjs` is pure JS and easier to install.
- `cors` is used but not listed in `package.json` — add it (`npm install cors --save`).
- `node-fetch` is declared but not used in `src/web`. Remove it if not needed.

If you want, I can:
- Add `cors` to `src/web/package.json` and run `npm install` in the workspace, or
- Remove `node-fetch` from `package.json`, or
- Replace `bcryptjs`/`bcrypt` usage to standardize on a single library.

File references:
- Main server file: [server.js](server.js)
- DB client: [db.js](db.js)
- Package manifest: [package.json](package.json)

Frontend scripts and browser-side functionality

- The frontend is implemented with plain JavaScript (no bundled frontend framework or npm packages).
- Key frontend scripts (located under `public/js/`) and their roles:
  - `navbar.js`: UI for the top navigation and user/session controls (login state, links).
  - `auth.js`: Handles login/logout flows, token storage (`localStorage`) and redirect behavior.
  - `analytics.js`: Fetches analytics from `/api/logs/analytics`, filters data and renders metric cards, tables and small bar charts using DOM and CSS.
  - `dashboard.js`: Dashboard page logic, renders simple donut/mini charts and trend visualizations using DOM/SVG/CSS.
  - `map.js`: The current-class map editor and renderer. Implements a draggable, layer-based map canvas, room tiles, scanner dots, and save/load via `/api/map-layout`. This is a custom DOM-based map — no Leaflet/Mapbox/etc.
  - `logs.js`, `teacher_logs.js`, `student_lookup.js`, `room.js`, `profile.js`, `scanners.js`, `calendar.js`, `analytics.js`: Page-specific UI, forms, table rendering, CSV export, and API calls (all using the browser `fetch` API).
  - `scanners.js`: Also opens a browser `WebSocket` to `/ws` for real-time scanner/frontend communication.

- Browser APIs used (no external libs):
  - `fetch` for HTTP requests to the backend APIs.
  - `WebSocket` for real-time updates between scanners and frontend (`public/js/scanners.js`).
  - `localStorage` for storing `auth_token` and small client state.
  - DOM manipulation and CSS for charts and the map editor — charts are hand-drawn via HTML/CSS (no Chart.js / D3 dependency).

Summary (frontend):
- There are no frontend npm packages in use; everything is implemented with vanilla JS and standard browser APIs. The map editor and charts are custom implementations, not third-party mapping/charting libraries.

