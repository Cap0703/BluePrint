/*
====================================================================================
 ____  _            ____       _       _        
| __ )| |_   _  ___|  _ \ _ __(_)_ __ | |_      
|  _ \| | | | |/ _ \ |_) | '__| | '_ \| __|     
| |_) | | |_| |  __/  __/| |  | | | | | |_      
|____/|_|\__,_|\___|_|   |_|  |_|_| |_|\__|  

====================================================================================
 AI-ASSISTED COMMENTS
 All inline comments and JSDoc in this file were generated with the
 assistance of ChatGPT and GitHub Copilot.
 Individual AI-generated comment blocks are tagged with @ai-generated.
====================================================================================
*/



import 'dotenv/config';

const DEBUG_WS = true;  // Set to false to disable verbose logging
process.env.TZ = "America/Los_Angeles";

/**
 * Logs a timestamped WebSocket debug message to the console.
 * Only outputs when DEBUG_WS is true.
 * @ai-generated
 * @param {string} msg - The message to log.
 * @param {object|null} [data=null] - Optional additional data to log alongside the message.
 */
function wsLog(msg, data = null) {
  if (DEBUG_WS) {
    const timestamp = new Date().toISOString();
    if (data) {
      console.log(`[${timestamp}] [WS] ${msg}`, data);
    } else {
      console.log(`[${timestamp}] [WS] ${msg}`);
    }
  }
}

import os from 'os';
import express from 'express';
import { pool, initializeDatabase } from './db.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { spawn } from 'child_process';
import bcryptjs from 'bcryptjs';
import jwt from 'jsonwebtoken';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import crypto from 'crypto';
import { get } from 'http';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { WebSocketServer } from 'ws';
import http from 'http';
import https from 'https';

const useHttps = process.env.USE_HTTPS === 'true';
let server;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const scannerSockets = new Map();

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());
app.use(cookieParser());
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000
  }
}));

if (useHttps) {
  try {
    const key = fs.readFileSync(path.join(os.homedir(), 'certs/key.pem'));
    const cert = fs.readFileSync(path.join(os.homedir(), 'certs/cert.pem'));
    server = https.createServer({ key, cert }, app);
    console.log('✅ HTTPS enabled');
  } catch (err) {
    console.error('❌ HTTPS setup failed:', err.message);
    server = http.createServer(app);
  }
} else {
  server = http.createServer(app);
}

const wss = new WebSocketServer({ server });

const CALENDAR_CACHE_FILE = path.join(__dirname, 'cache', 'calendar_cache.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

const MASTER_KEY = Buffer.from(process.env.MASTER_KEY, 'hex');
let ATTENDANCE_GRACE_PERIOD_MINUTES = Number(process.env.GRACE_PERIOD_MINUTES || 10);

let settings = { gracePeriodMinutes: ATTENDANCE_GRACE_PERIOD_MINUTES };

const frontendSockets = new Set();

/**
 * WebSocket connection handler. Manages scanner and frontend client connections,
 * routes messages between scanners and their associated frontend dashboards,
 * and handles auth, output relay, and command forwarding over the socket.
 * @ai-generated
 * @event connection
 * @param {WebSocket} ws - The newly connected WebSocket client.
 * @param {http.IncomingMessage} req - The HTTP upgrade request.
 */
wss.on('connection', (ws, req) => {
  const connectionId = Math.random().toString(36).substr(2, 9);
  const remoteAddress = req.socket.remoteAddress;
  const pingInterval = setInterval(() => {
  if (ws.readyState === ws.OPEN) ws.ping();
  }, 30000);
  ws.on('close', () => clearInterval(pingInterval));
  
  wsLog(`New connection [${connectionId}] from ${remoteAddress}`, { url: req.url });
  
  let scannerId = null;
  let isFrontend = false;
  let messageCount = 0;
  
  // Handle errors on the socket itself
  ws.on('error', (err) => {
    wsLog(`Socket error [${connectionId}]: ${err.message}`);
  });
  
  // Handle incoming messages
  ws.on('message', (message) => {
    messageCount++;
    wsLog(`Message #${messageCount} [${connectionId}] received, length: ${message.length} bytes`);
    
    try {
      wsLog(`Parsing JSON...`);
      const data = JSON.parse(message.toString());
      wsLog(`Message parsed successfully`, { type: data.type, scannerId: data.scannerId });
      
      if (data.type === 'auth') {
        scannerId = data.scannerId;
        wsLog(`Auth message from scanner [${scannerId}]`, { connectionId });
        scannerSockets.set(scannerId, ws);
        wsLog(`Scanner socket registered`, { scannerId, totalScanners: scannerSockets.size });
      }
      
      if (data.type === 'frontend') {
        isFrontend = true;
        ws.scannerId = data.scannerId;
        wsLog(`Frontend connection for scanner [${data.scannerId}]`, { connectionId });
        frontendSockets.add(ws);
        wsLog(`Frontend socket registered`, { totalFrontends: frontendSockets.size });
      }
      
      if (data.type === 'output') {
        wsLog(`Output message from scanner [${data.scannerId}]`);
        console.log(`[SCANNER ${data.scannerId}] ${data.output}`);
        
        let relayCount = 0;
        frontendSockets.forEach(client => {
          if (client.readyState === 1 && String(client.scannerId) === String(data.scannerId)) {
            try {
              client.send(JSON.stringify({
                type: "output",
                scannerId: data.scannerId,
                output: data.output
              }));
              relayCount++;
            } catch (sendErr) {
              wsLog(`Error relaying to frontend: ${sendErr.message}`);
            }
          }
        });
        wsLog(`Output relayed to ${relayCount} frontend(s)`);
      }

      if (data.type === 'command') {
        const targetScannerId = data.scannerId;
        wsLog(`Command from frontend for scanner [${targetScannerId}]`, { command: data.command });
        
        const scannerSocket = scannerSockets.get(targetScannerId);
        if (scannerSocket && scannerSocket.readyState === 1) {
          try {
            scannerSocket.send(JSON.stringify({
              command: data.command,
              commandId: data.commandId || Math.random()
            }));
            wsLog(`Command sent to scanner [${targetScannerId}]`);
          } catch (sendErr) {
            wsLog(`Error sending command to scanner: ${sendErr.message}`);
          }
        } else {
          wsLog(`Scanner [${targetScannerId}] not connected or not ready`);
          // Notify frontend that scanner is offline
          frontendSockets.forEach(client => {
            if (client.readyState === 1 && String(client.scannerId) === String(targetScannerId)) {
              try {
                client.send(JSON.stringify({
                  type: "error",
                  message: `Scanner ${targetScannerId} is not connected`
                }));
              } catch (err) {
                wsLog(`Error notifying frontend: ${err.message}`);
              }
            }
          });
        }
      }
      
    } catch (parseErr) {
      wsLog(`ERROR: Failed to parse JSON [${connectionId}]`, { 
        error: parseErr.message,
        rawMessage: message.toString().substring(0, 100) 
      });
      try {
        ws.close(1002, 'Invalid JSON');
      } catch (closeErr) {
        wsLog(`Error closing socket: ${closeErr.message}`);
      }
    }
  });
  
  // Handle connection close
  ws.on('close', (code, reason) => {
    wsLog(`Connection closed [${connectionId}]`, { 
      code, 
      reason: reason ? reason.toString() : 'none',
      scannerId,
      isFrontend,
      messagesReceived: messageCount
    });
    
    if (scannerId) {
      scannerSockets.delete(scannerId);
      wsLog(`Scanner ${scannerId} unregistered`, { remaining: scannerSockets.size });
    }
    if (isFrontend) {
      frontendSockets.delete(ws);
      wsLog(`Frontend unregistered`, { remaining: frontendSockets.size });
    }
  });
});

/**
 * Loads application settings from the settings JSON file on disk.
 * If the file doesn't exist or can't be parsed, falls back to defaults and saves them.
 * @ai-generated
 */
function loadSettings() {
  try {
    const data = fs.readFileSync(SETTINGS_FILE, 'utf8');
    settings = JSON.parse(data);
    ATTENDANCE_GRACE_PERIOD_MINUTES = settings.gracePeriodMinutes;
  } catch (err) {
    // Use default, and save it
    saveSettings();
  }
}

/**
 * Persists the current in-memory settings object to the settings JSON file on disk.
 * @ai-generated
 */
function saveSettings() {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

/**
 * Returns the current date as a YYYY-MM-DD string in the America/Los_Angeles timezone.
 * @ai-generated
 * @param {Date} [date=new Date()] - The date to format. Defaults to now.
 * @returns {string} Date string in YYYY-MM-DD format.
 */
function getLosAngelesDateString(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const parts = formatter.formatToParts(date);
  const year = parts.find(part => part.type === 'year')?.value;
  const month = parts.find(part => part.type === 'month')?.value;
  const day = parts.find(part => part.type === 'day')?.value;
  return `${year}-${month}-${day}`;
}

/**
 * Returns the list of courses visible to the given user.
 * Administrators see all courses; teachers only see their assigned courses.
 * @ai-generated
 * @param {object} user - The authenticated user object from the JWT.
 * @param {string} user.role - The user's role ('administrator' or 'teacher').
 * @param {number[]} [user.courses] - Array of assigned course IDs (teachers only).
 * @returns {Promise<object[]>} Array of course objects with id, room, and period.
 */
async function getVisibleCoursesForUser(user) {
  if (!user) return [];
  if (user.role === 'administrator') {
    const result = await pool.query('SELECT id, room, period FROM courses ORDER BY period ASC, room ASC');
    return result.rows;
  }

  const resolvedUser = await resolveUserCourseScope(user);
  const assignedCourseIds = Array.isArray(resolvedUser.courses)
    ? resolvedUser.courses.map(Number).filter(Number.isInteger)
    : [];

  if (!assignedCourseIds.length) {
    return [];
  }

  const result = await pool.query(
    'SELECT id, room, period FROM courses WHERE id = ANY($1::int[]) ORDER BY period ASC, room ASC',
    [assignedCourseIds]
  );
  return result.rows;
}

/**
 * Fetches the latest role and course assignments for a user directly from the database,
 * merging them into the user object to ensure the JWT data isn't stale.
 * @ai-generated
 * @param {object} user - The user object, typically decoded from a JWT.
 * @param {number} user.id - The user's database ID.
 * @returns {Promise<object>} Updated user object with fresh role and courses from the DB.
 */
async function resolveUserCourseScope(user) {
  if (!user?.id) {
    return user || {};
  }

  const result = await pool.query(
    'SELECT id, role, courses FROM users WHERE id = $1',
    [user.id]
  );

  if (!result.rows.length) {
    return user;
  }

  return {
    ...user,
    role: result.rows[0].role || user.role,
    courses: Array.isArray(result.rows[0].courses) ? result.rows[0].courses : []
  };
}

/**
 * Builds a composite string key from a room and period, used to match logs to courses.
 * @ai-generated
 * @param {string} room - The scanner/room identifier.
 * @param {string} period - The class period label.
 * @returns {string} A combined key in the format "room__period".
 */
function buildCourseScopeKey(room, period) {
  return [String(room || '').trim(), String(period || '').trim()].join('__');
}

/**
 * Validates and scopes a teacher's log entry to their assigned course.
 * Admins and scanners pass through without modification.
 * Throws if the teacher has no assignments or the log doesn't match their assigned room/period.
 * @ai-generated
 * @param {object} rawLog - The raw log payload from the request body.
 * @param {string} [rawLog.scanner_location] - The room the log is associated with.
 * @param {string} [rawLog.period] - The period the log is associated with.
 * @param {object} user - The authenticated user making the request.
 * @param {string} user.role - The user's role.
 * @returns {Promise<object>} The log payload, modified with the matched course's room/period if applicable.
 * @throws {Error} If the teacher has no course assignments or the log falls outside their assigned class.
 */
async function applyTeacherLogScope(rawLog, user) {
  if (!user || user.role === 'administrator' || user.role === 'scanner' || user.scanner_id) {
    return { ...(rawLog || {}) };
  }

  const visibleCourses = await getVisibleCoursesForUser(user);
  if (!visibleCourses.length) {
    throw new Error('No class assignments are linked to this teacher account');
  }

  const requestedRoom = normalizeOptionalValue(rawLog?.scanner_location);
  const requestedPeriod = normalizeOptionalValue(rawLog?.period);
  let matchedCourse = null;

  if (requestedRoom && requestedPeriod) {
    matchedCourse = visibleCourses.find(course => buildCourseScopeKey(course.room, course.period) === buildCourseScopeKey(requestedRoom, requestedPeriod));
  } else if (visibleCourses.length === 1) {
    [matchedCourse] = visibleCourses;
  } else {
    throw new Error('Room and period are required for teachers assigned to multiple classes');
  }

  if (!matchedCourse) {
    throw new Error('This log is outside the teacher\'s assigned room and period');
  }

  return {
    ...(rawLog || {}),
    scanner_location: matchedCourse.room,
    period: matchedCourse.period,
    scanner_id: normalizeOptionalValue(rawLog?.scanner_id) || `TEACHER-${user.id}`
  };
}

/**
 * Verifies that the given user has permission to manage (edit/delete) a specific log entry.
 * Admins can manage any log; teachers are restricted to logs within their assigned courses.
 * @ai-generated
 * @param {object} user - The authenticated user.
 * @param {string} user.role - The user's role.
 * @param {number|string} logId - The ID of the log entry to check.
 * @returns {Promise<object>} The log row if the user is authorized.
 * @throws {Error} With statusCode 404 if the log doesn't exist, or 403 if the user lacks permission.
 */
async function assertUserCanManageLog(user, logId) {
  const result = await pool.query('SELECT id, scanner_location, period FROM logs WHERE id = $1', [logId]);
  if (!result.rows.length) {
    const error = new Error('Log entry not found');
    error.statusCode = 404;
    throw error;
  }

  if (!user || user.role === 'administrator') {
    return result.rows[0];
  }

  const visibleCourses = await getVisibleCoursesForUser(user);
  const allowedKeys = new Set(visibleCourses.map(course => buildCourseScopeKey(course.room, course.period)));
  const logKey = buildCourseScopeKey(result.rows[0].scanner_location, result.rows[0].period);

  if (!allowedKeys.has(logKey)) {
    const error = new Error('You can only manage logs for your assigned classes');
    error.statusCode = 403;
    throw error;
  }

  return result.rows[0];
}

/**
 * Filters a list of log entries down to only those matching the given courses.
 * @ai-generated
 * @param {object[]} logs - Full list of log objects to filter.
 * @param {object[]} courses - List of allowed course objects with room and period fields.
 * @returns {object[]} Subset of logs whose room+period matches one of the allowed courses.
 */
function filterLogsForCourses(logs, courses) {
  const allowedKeys = new Set(courses.map(course => buildCourseScopeKey(course.room, course.period)));
  return logs.filter(log => allowedKeys.has(buildCourseScopeKey(log.scanner_location, log.period)));
}

/**
 * Fetches all logs visible to the given user, sorted newest-first.
 * Administrators see all logs; teachers see only logs for their assigned courses.
 * @ai-generated
 * @param {object} user - The authenticated user.
 * @param {string} user.role - The user's role.
 * @returns {Promise<object[]>} Array of log objects sorted chronologically descending.
 */
async function getVisibleLogsForUser(user) {
  const result = await pool.query(`
    SELECT *
    FROM logs
  `);

  if (!user || user.role === 'administrator') {
    return result.rows.sort(compareLogsChronologically);
  }

  const visibleCourses = await getVisibleCoursesForUser(user);
  return filterLogsForCourses(result.rows, visibleCourses).sort(compareLogsChronologically);
}

/**
 * Rate limiter for the login endpoint.
 * Allows a maximum of 10 attempts per 15-minute window, keyed by email + IP address.
 * @ai-generated
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => {
    // Use ipKeyGenerator for correct IPv4/IPv6 handling
    const ip = ipKeyGenerator(req);
    return req.body.email + '_' + ip;
  },
  message: {
    error: 'Too many login attempts. Please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false
});



/*----------------------------------------Authentication Middleware----------------------------------------*/

/**
 * Express middleware that verifies a JWT from either the session or Authorization header.
 * Attaches the decoded user payload to req.user on success.
 * @ai-generated
 * @param {express.Request} req
 * @param {express.Response} res
 * @param {express.NextFunction} next
 */
function verifyToken(req, res, next) {
  const token = req.cookies.auth_token || req.session.user?.token || req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'No authentication token provided' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Express middleware factory that restricts access to users with a specific role.
 * Administrators always pass through regardless of the required role.
 * @ai-generated
 * @param {string} role - The minimum required role (e.g. 'administrator', 'teacher').
 * @returns {express.RequestHandler} Middleware that enforces the role check.
 */
function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (req.user.role !== role && req.user.role !== 'administrator') {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

/**
 * Express middleware that redirects unauthenticated requests to the login page.
 * Used for page routes (not API routes) to guard server-rendered HTML.
 * @ai-generated
 * @param {express.Request} req
 * @param {express.Response} res
 * @param {express.NextFunction} next
 */
function redirectIfNotAuthenticated(req, res, next) {
  // Check for token in: cookies (from page navigation), session, or Authorization header (from API calls)
  const token = req.cookies.auth_token || req.session.user?.token || req.headers.authorization?.split(' ')[1];
  if (token) {
    try {
      req.user = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
    } catch (_) {}
  }
  next(); // Always serve the page — auth.js will redirect if no valid token
}



/*----------------------------------------Calendar Functions----------------------------------------*/
let calendarCache = { data: null, lastUpdated: null, isUpdating: false };

/**
 * Loads the persisted calendar cache from disk into memory.
 * Resets to an empty cache state if the file is missing or unreadable.
 * @ai-generated
 */
function loadCalendarCache() {
  try {
    if (fs.existsSync(CALENDAR_CACHE_FILE)) {
      console.log(' Calendar cache file exists');
      const cacheData = fs.readFileSync(CALENDAR_CACHE_FILE, 'utf8');
      calendarCache = JSON.parse(cacheData);
      console.log('Loaded calendar cache:', {
        hasData: !!calendarCache.data,
        lastUpdated: calendarCache.lastUpdated,
        eventCount: calendarCache.data?.events?.length || 0
      });
    } else {
      console.log('Calendar cache file does not exist:', CALENDAR_CACHE_FILE);
      calendarCache = { data: null, lastUpdated: null, isUpdating: false };
    }
  } catch (error) {
    console.error("Error loading calendar cache:", error);
    calendarCache = { data: null, lastUpdated: null, isUpdating: false };
  }
}

/**
 * Saves new calendar data to both the in-memory cache and the cache file on disk.
 * Updates the lastUpdated timestamp and clears the isUpdating flag.
 * @ai-generated
 * @param {object} data - The calendar data object to cache (should include an events array).
 */
function saveCalendarCache(data) {
  try {
    calendarCache = {
      data: data,
      lastUpdated: new Date().toISOString(),
      isUpdating: false
    };
    fs.writeFileSync(CALENDAR_CACHE_FILE, JSON.stringify(calendarCache, null, 2));
  } catch (error) {
    console.error("Error saving calendar cache:", error);
  }
}

/**
 * Determines whether the calendar cache is stale and needs refreshing.
 * Returns true if there is no lastUpdated timestamp or if more than 10 minutes have elapsed.
 * @ai-generated
 * @returns {boolean} True if the cache should be refreshed, false if it's still fresh.
 */
function shouldUpdateCache() {
  if (!calendarCache.lastUpdated) return true;
  const lastUpdate = new Date(calendarCache.lastUpdated);
  const now = new Date();
  const minutesSinceUpdate = (now - lastUpdate) / (1000 * 60);
  return minutesSinceUpdate >= 10;
}

/**
 * Spawns a Python subprocess to fetch calendar event data from the external API.
 * Parses the stdout JSON result and rejects on non-zero exit codes or parse errors.
 * @ai-generated
 * @param {string|null} [date=null] - Optional date string (YYYY-MM-DD) to fetch events for.
 *                                    Defaults to today if not provided.
 * @returns {Promise<object>} Parsed calendar data object containing a date and events array.
 * @throws {Error} If the Python script is not found, exits with an error, or returns invalid JSON.
 */
async function fetchCalendarFromAPI(date = null) {
  return new Promise((resolve, reject) => {
    const pythonScriptPath = path.join(__dirname, "api/calendar", "fetch_calendar.py");
    if (!fs.existsSync(pythonScriptPath)) {
      console.error('Python script not found at:', pythonScriptPath);
      reject(new Error('Python script not found'));
      return;
    }
    const args = [pythonScriptPath];
    if (date) {
      args.push(date);
    }
    const pythonProcess = spawn('python', args);
    let data = '';
    let error = '';
    pythonProcess.stdout.on('data', (chunk) => {
      data += chunk.toString();
    });
    pythonProcess.stderr.on('data', (chunk) => {
      error += chunk.toString();
      console.error('Python stderr:', chunk.toString());
    });
    pythonProcess.on('close', (code) => {
      //console.log(`Python script exited with code: ${code}`);
      if (code !== 0) {
        reject(new Error(`Python script exited with code ${code}: ${error}`));
        return;
      }
      try {
        const result = JSON.parse(data);
        if (result.error) {
          reject(new Error(result.error));
        } else {
          //console.log('Successfully parsed calendar data for date:', result.date, 'events:', result.events?.length || 0);
          resolve(result);
        }
      } catch (parseError) {
        console.error('Failed to parse calendar data:', parseError.message);
        console.error('Raw data was:', data);
        reject(new Error(`Failed to parse calendar data: ${parseError.message}`));
      }
    });
    pythonProcess.on('error', (err) => {
      //console.error('Python process failed:', err.message);
      reject(new Error(`Python process failed: ${err.message}`));
    });
  });
}

/**
 * Returns a hardcoded set of fallback period objects used when the calendar API is unavailable.
 * Covers 4 standard periods for a typical school day.
 * @ai-generated
 * @returns {object[]} Array of period objects with title, startTime, and endTime fields.
 */
function getFallbackPeriods() {
  console.log('Using fallback period data for testing');
  return [
    {
      title: "Period 1",
      startTime: "08:00",
      endTime: "09:25"
    },
    {
      title: "Period 2",
      startTime: "09:30",
      endTime: "10:50"
    },
    {
      title: "Period 3",
      startTime: "11:10",
      endTime: "12:30"
    },
    {
      title: "Period 4",
      startTime: "13:05",
      endTime: "14:25"
    }
  ];
}

/**
 * Filters a raw list of calendar events down to class periods only,
 * excluding events with titles containing "lunch", "break", or "transition".
 * @ai-generated
 * @param {object[]} events - Raw array of calendar event objects with a title field.
 * @returns {object[]} Filtered array containing only class period events.
 */
function extractPeriods(events) {
  if (!Array.isArray(events)) return [];
  const periods = events.filter(event => {
    const title = (event.title || '').toLowerCase();
    return !(title.includes('lunch') || title.includes('break') || title.includes('transition'));
  });
  if (periods.length === 0) return [];
  return periods;
}

/**
 * Returns the class periods for a specific date, using the cache when available and fresh.
 * Falls back to fetching from the API, then to hardcoded fallback periods on failure.
 * @ai-generated
 * @param {string} dateString - The date to retrieve periods for, in YYYY-MM-DD format.
 * @returns {Promise<object[]>} Array of period objects with title, startTime, and endTime.
 */
async function getPeriodsForDate(dateString) {
  if (
    calendarCache.data &&
    calendarCache.data.date === dateString &&
    !shouldUpdateCache()
  ) {
    const periods = extractPeriods(calendarCache.data.events);
    if (periods.length > 0) {
      return periods;
    }
  }
  try {
    console.log(`fetching calendar for ${dateString}`);
    const data = await fetchCalendarFromAPI(dateString);
    if (data && data.events) {
      saveCalendarCache(data);
      const periods = extractPeriods(data.events);
      if (periods.length > 0) {
        return periods;
      }
    }
  } catch (err) {
    console.error(`failed to retrieve calendar for ${dateString}:`, err);
  }
  return getFallbackPeriods();
}

/**
 * Returns the class periods for today using the in-memory calendar cache.
 * Falls back to hardcoded periods if the cache is empty.
 * @ai-generated
 * @returns {object[]} Array of today's period objects.
 */
function getPeriodsToday() {
  return extractPeriods(calendarCache.data?.events) || getFallbackPeriods();
}

loadCalendarCache();



/*----------------------------------------Log Functions----------------------------------------*/

/**
 * Converts a "HH:MM" or "HH:MM:SS" time string into the total number of minutes since midnight.
 * @ai-generated
 * @param {string} t - A time string in "HH:MM" or "HH:MM:SS" format.
 * @returns {number|null} Total minutes since midnight, or null if the input is falsy.
 */
function timeToMinutes(t) {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Extracts just the time portion from a log timestamp that may include a date prefix.
 * If the value contains a space, returns only the last space-separated segment.
 * @ai-generated
 * @param {string} value - A time or datetime string (e.g. "2024-01-15 08:30:00" or "08:30:00").
 * @returns {string|null} The time portion of the string, or null if the input is falsy.
 */
function extractLogTimeValue(value) {
  if (!value) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  const parts = normalized.split(' ');
  return parts.length > 1 ? parts[parts.length - 1] : normalized;
}

/**
 * Normalizes a date value for log entries, ensuring it is in YYYY-MM-DD format.
 * Returns null for empty or invalid values.
 * @ai-generated
 * @param {string} value - A raw date string from the log payload.
 * @returns {string|null} A normalized YYYY-MM-DD date string, or null if invalid.
 */
function normalizeLogDateValue(value) {
  const normalized = normalizeOptionalValue(value);
  if (!normalized) return null;
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return normalized;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

/**
 * Normalizes a time value for log entries into HH:MM:SS format.
 * Handles 12-hour AM/PM formats by converting to 24-hour, and pads hours/seconds as needed.
 * @ai-generated
 * @param {string} value - A raw time string from the log payload.
 * @returns {string|null} A normalized HH:MM:SS time string, or null if the input is invalid.
 */
function normalizeLogTimeValue(value) {
  const normalized = normalizeOptionalValue(value);
  if (!normalized) return null;
  const extracted = extractLogTimeValue(normalized);
  const converted = convertTo24HourFormat(extracted);
  const match = String(converted).match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return converted;
  const hours = String(match[1]).padStart(2, '0');
  const minutes = match[2];
  const seconds = match[3] || '00';
  return `${hours}:${minutes}:${seconds}`;
}

/**
 * Computes a sortable Unix timestamp (ms) for a log entry based on its date and time fields.
 * Returns NEGATIVE_INFINITY for logs with missing or unparseable timestamps so they sort last.
 * @ai-generated
 * @param {object} log - A log object with date_scanned and time_scanned fields.
 * @returns {number} Unix timestamp in milliseconds, or Number.NEGATIVE_INFINITY if unavailable.
 */
function getLogTimestampValue(log) {
  const dateValue = normalizeLogDateValue(log?.date_scanned);
  const timeValue = normalizeLogTimeValue(log?.time_scanned);
  if (!dateValue || !timeValue) return Number.NEGATIVE_INFINITY;
  const timestamp = Date.parse(`${dateValue}T${timeValue}`);
  return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp;
}

/**
 * Comparator function for sorting log entries in descending chronological order (newest first).
 * Uses the log ID as a tiebreaker when timestamps are identical.
 * @ai-generated
 * @param {object} left - A log object.
 * @param {object} right - Another log object.
 * @returns {number} Negative if right is older, positive if right is newer, 0 if equal.
 */
function compareLogsChronologically(left, right) {
  const timestampDiff = getLogTimestampValue(right) - getLogTimestampValue(left);
  if (timestampDiff !== 0) return timestampDiff;
  return Number(right?.id || 0) - Number(left?.id || 0);
}

/**
 * Normalizes an optional field value by trimming whitespace and returning null
 * for empty strings and common placeholder values like "auto", "null", "auto assign".
 * @ai-generated
 * @param {*} value - Any raw input value to normalize.
 * @returns {string|null} The trimmed string value, or null if it's blank or a placeholder.
 */
function normalizeOptionalValue(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  if (
    !normalized ||
    normalized.toLowerCase() === 'auto' ||
    normalized.toLowerCase() === 'auto assign' ||
    normalized.toLowerCase() === 'null'
  ) {
    return null;
  }
  return normalized;
}

/**
 * Determines the attendance status ('on-time' or 'Late') for a log entry
 * based on the scan time relative to the period's start time and the grace period setting.
 * Returns null if the status cannot be determined (missing period, time, or match).
 * Skips calculation if the log already has a meaningful status.
 * @ai-generated
 * @param {object} log - The log entry to evaluate.
 * @param {string} [log.status] - Existing status value (skips calculation if already set).
 * @param {string} [log.period] - The period title assigned to this log.
 * @param {string} [log.time_scanned] - The time the student was scanned.
 * @param {object[]} periods - Array of period objects with title, startTime, and endTime.
 * @returns {string|null} 'on-time', 'Late', or null if status cannot be assigned.
 */
function assignStatusForLog(log, periods) {
  const normalizedStatus = normalizeOptionalValue(log.status);
  if (!normalizedStatus || normalizedStatus === 'Unknown' || normalizedStatus === 'na') {
    if (!log.period) return null;
    const period = periods.find(p => p.title === log.period);
    if (!period) return null;
    const logTimeStr = extractLogTimeValue(log.time_scanned);
    if (!logTimeStr) return null;
    const scannedMinutes = timeToMinutes(logTimeStr);
    const startMinutes = timeToMinutes(period.startTime);
    if (scannedMinutes === null || startMinutes === null) return null;
    if (scannedMinutes <= startMinutes + ATTENDANCE_GRACE_PERIOD_MINUTES) {
      return 'on-time';
    } else {
      return 'Late';
    }
  }
  return log.status;
}

/**
 * Determines which class period a log entry belongs to based on its scan time.
 * Allows a 10-minute early buffer before each period's start time.
 * Returns null if the scan time doesn't fall within any known period.
 * @ai-generated
 * @param {object} log - The log entry to evaluate.
 * @param {string|number} log.id - The log ID (used for debug logging).
 * @param {string} log.time_scanned - The timestamp of the scan in "HH:MM" or "YYYY-MM-DD HH:MM:SS" format.
 * @param {object[]} periods - Array of period objects with title, startTime, and endTime fields.
 * @returns {string|null} The matched period title (e.g. "Period 1"), or null if no match found.
 */
function assignPeriodForLog(log, periods) {
  //console.log(log.id, 'scanned at', log.time_scanned, 'checking against periods:', periods.map(p => `${p.title} (${p.startTime}-${p.endTime})`));
  if (!log.time_scanned) {
    console.log('No time_scanned for log:', log.id);
    return null;
  }
  const logTime = extractLogTimeValue(log.time_scanned);
  if (!logTime) {
    console.log('Invalid timestamp format for log:', log.id, log.time_scanned);
    return null;
  }
  let earlyBuffer = 10;
  const [logHour, logMinute] = logTime.split(":").map(Number);
  const logTotalMinutes = logHour * 60 + logMinute;
  for (const p of periods) {
    const [startHour, startMinute] = p.startTime.split(":").map(Number);
    const [endHour, endMinute] = p.endTime.split(":").map(Number);
    const startTotalMinutes = startHour * 60 + startMinute;
    const endTotalMinutes = endHour * 60 + endMinute;
    const earlyTotalMinutes = startTotalMinutes - earlyBuffer;
    if (logTotalMinutes >= earlyTotalMinutes && logTotalMinutes <= endTotalMinutes) {
      //console.log(`Assigning period "${p.title}" to log ${log.id} (scanned at ${logTime})`);
      return p.title;
    }
  }
  console.log(`Unable to match any period for log ${log.id} scanned at ${logTime}; considered periods:`, periods);
  return null;
}

/**
 * Batch job that queries all logs missing a status and assigns 'on-time' or 'Late'
 * based on each log's scan time relative to its period's start time.
 * Groups logs by date to minimize calendar API calls.
 * @ai-generated
 * @returns {Promise<void>}
 */
async function assignStatusesToLogs() {
  try {
    const result = await pool.query(`
      SELECT *
      FROM logs
      WHERE status IS NULL
         OR BTRIM(status) = ''
         OR LOWER(BTRIM(status)) IN ('na', 'unknown', 'auto', 'auto assign', 'null')
    `);
    //console.log(`Found ${result.rows.length} logs without assigned statuses`);
    const logsByDate = {};
    result.rows.forEach(log => {
      const date = log.date_scanned;
      if (!logsByDate[date]) {
        logsByDate[date] = [];
      }
      logsByDate[date].push(log);
    });
    for (const date of Object.keys(logsByDate)) {
      const periods = await getPeriodsForDate(date);
      for (const log of logsByDate[date]) {
        const status = assignStatusForLog(log, periods);
        if (status) {
          await pool.query("UPDATE logs SET status = $1 WHERE id = $2", [status, log.id]);
          console.log(`Assigned ${status} to log ${log.id}`);
        } else {
          console.log(`No status assigned for log ${log.id}, leaving blank`);
        }
      }
    }
  } catch (err) {
    console.error("Error assigning statuses:", err);
  }
}

/**
 * Batch job that queries all logs missing a period assignment and assigns the correct
 * period based on each log's scan time. Groups logs by date to minimize calendar API calls.
 * @ai-generated
 * @returns {Promise<void>}
 */
async function assignPeriodsToLogs() {
  try {
    const result = await pool.query("SELECT * FROM logs WHERE period IS NULL OR period = '' OR period = 'na'");
    //console.log(`Found ${result.rows.length} logs without assigned periods`);
    const logsByDate = {};
    result.rows.forEach(log => {
      const date = log.date_scanned;
      if (!logsByDate[date]) {
        logsByDate[date] = [];
      }
      logsByDate[date].push(log);
    });
    for (const date of Object.keys(logsByDate)) {
      const periods = await getPeriodsForDate(date);
      for (const log of logsByDate[date]) {
        const period = assignPeriodForLog(log, periods);
        if (period) {
          await pool.query("UPDATE logs SET period = $1 WHERE id = $2", [period, log.id]);
          console.log(`Assigned ${period} to log ${log.id}`);
        } else {
          console.log(`No period assigned for log ${log.id}, leaving blank`);
        }
      }
    }
  } catch (err) {
    console.error("Error assigning periods:", err);
  }
}

/**
 * Converts a 12-hour time string (e.g. "08:30:00 AM") to 24-hour format (e.g. "08:30:00").
 * Returns the original string unchanged if it doesn't match the expected 12-hour pattern.
 * @ai-generated
 * @param {string} time12h - A time string in "HH:MM:SS AM/PM" format.
 * @returns {string|null} A 24-hour time string, or null if the input is falsy.
 */
function convertTo24HourFormat(time12h) {
  if (!time12h) return null;
  const time = time12h.trim();
  const regex = /^(\d{1,2}):(\d{2}):(\d{2})\s(AM|PM)$/i;
  const match = time.match(regex);
  if (!match) {
    return time;
  }
  let hours = parseInt(match[1]);
  const minutes = match[2];
  const seconds = match[3];
  const period = match[4].toUpperCase();
  if (period === 'PM' && hours !== 12) {
    hours += 12;
  } else if (period === 'AM' && hours === 12) {
    hours = 0;
  }
  return `${String(hours).padStart(2, '0')}:${minutes}:${seconds}`;
}

/**
 * Converts an array of log objects into a CSV-formatted string.
 * Includes a header row and normalizes all time values before output.
 * @ai-generated
 * @param {object[]} logs - Array of log objects to serialize.
 * @returns {string} A CSV string with headers and one row per log entry.
 */
function convertToCsv(logs) {
  const header = [
    'ID',
    'Date Scanned',
    'Time Scanned',
    'Student ID',
    'First Name',
    'Last Name',
    'Period',
    'Scanner Location',
    'Scanner ID',
    'Status'
  ];
  const rows = logs.map(log => [
    log.id,
    log.date_scanned,
    normalizeLogTimeValue(log.time_scanned),
    log.student_id,
    log.first_name,
    log.last_name,
    log.period,
    log.scanner_location,
    log.scanner_id,
    log.status
  ]);
  const csvContent = [header, ...rows]
    .map(row => row.map(escapeCsvValue).join(','))
    .join("\n");
  return csvContent;
}

/**
 * Escapes a single value for safe inclusion in a CSV file.
 * Wraps values in double quotes if they contain commas, quotes, or newline characters.
 * @ai-generated
 * @param {*} value - The raw value to escape.
 * @returns {string} A CSV-safe string representation of the value.
 */
function escapeCsvValue(value) {
  const normalized = value === undefined || value === null ? '' : String(value);
  if (!/[",\n\r]/.test(normalized)) return normalized;
  return `"${normalized.replace(/"/g, '""')}"`;
}

/**
 * Validates and returns a required string field from a raw input value.
 * Throws a descriptive error if the value is missing or blank after trimming.
 * @ai-generated
 * @param {*} value - The raw input value to validate.
 * @param {string} fieldLabel - Human-readable name of the field, used in the error message.
 * @returns {string} The trimmed, non-empty string value.
 * @throws {Error} If the value is blank or missing.
 */
function normalizeRequiredString(value, fieldLabel) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new Error(`${fieldLabel} is required`);
  }
  return normalized;
}

/**
 * Parses a course assignment value into an array of positive integer course IDs.
 * Accepts arrays or delimited strings (pipe, semicolon, or comma separated).
 * @ai-generated
 * @param {string|number[]|string[]|null} courses - Raw course input to parse.
 * @returns {number[]} Array of valid positive integer course IDs.
 */
function parseCourseAssignments(courses) {
  if (courses === undefined || courses === null || courses === '') return [];
  if (Array.isArray(courses)) {
    return courses
      .map(course => Number(course))
      .filter(course => Number.isInteger(course) && course > 0);
  }
  return String(courses)
    .split(/[|;,]/)
    .map(part => Number(part.trim()))
    .filter(course => Number.isInteger(course) && course > 0);
}

/**
 * Parses and validates a set of course IDs against the database,
 * returning only those that actually exist. Deduplicates the input list.
 * @ai-generated
 * @param {string|number[]|string[]|null} courses - Raw course assignment input.
 * @returns {Promise<number[]>} Array of verified course IDs that exist in the database.
 */
async function sanitizeCourseAssignments(courses) {
  const parsedCourseIds = [...new Set(parseCourseAssignments(courses))];
  if (!parsedCourseIds.length) {
    return [];
  }

  const result = await pool.query(
    'SELECT id FROM courses WHERE id = ANY($1::int[])',
    [parsedCourseIds]
  );

  const validCourseIds = new Set(
    result.rows
      .map(row => Number(row.id))
      .filter(Number.isInteger)
  );

  return parsedCourseIds.filter(id => validCourseIds.has(id));
}

/**
 * Creates a new student account in the database with a hashed password.
 * @ai-generated
 * @param {object} payload - The student account data.
 * @param {string} payload.student_id - The student's ID number.
 * @param {string} payload.first_name - The student's first name.
 * @param {string} payload.last_name - The student's last name.
 * @param {string} payload.password - The plain-text password to hash and store.
 * @param {string} [payload.uuid] - Optional device UUID to bind the account to.
 * @returns {Promise<object>} The newly created student record (id, student_id, first_name, last_name).
 * @throws {Error} If any required field is missing.
 */
async function createStudentAccount(payload) {
  let { student_id, first_name, last_name, password, uuid } = payload;
  student_id = normalizeRequiredString(student_id, 'Student ID');
  first_name = normalizeRequiredString(first_name, 'First name');
  last_name = normalizeRequiredString(last_name, 'Last name');
  password = normalizeRequiredString(password, 'Password');
  uuid = normalizeOptionalValue(uuid);

  const hashedPassword = await bcryptjs.hash(password, 10);
  const result = await pool.query(`
    INSERT INTO students (student_id, first_name, last_name, password_hash, uuid)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id, student_id, first_name, last_name
  `, [student_id, first_name, last_name, hashedPassword, uuid]);

  return result.rows[0];
}

/**
 * Creates a new scanner account in the database with a hashed password.
 * Accepts either scanner_password or password as the credential field.
 * @ai-generated
 * @param {object} payload - The scanner account data.
 * @param {string} payload.scanner_id - The scanner's unique identifier.
 * @param {string} payload.scanner_location - The physical room/location of the scanner.
 * @param {string} [payload.scanner_password] - The scanner's plain-text password.
 * @param {string} [payload.password] - Alias for scanner_password.
 * @returns {Promise<object>} The newly created scanner record (id, scanner_id, scanner_location).
 * @throws {Error} If any required field is missing.
 */
async function createScannerAccount(payload) {
  let { scanner_id, scanner_location, scanner_password, password } = payload;
  scanner_id = normalizeRequiredString(scanner_id, 'Scanner ID');
  scanner_location = normalizeRequiredString(scanner_location, 'Scanner location');
  const rawPassword = normalizeRequiredString(scanner_password ?? password, 'Scanner password');

  const hashedPassword = await bcryptjs.hash(rawPassword, 10);
  const result = await pool.query(`
    INSERT INTO scanners (scanner_id, scanner_location, password_hash)
    VALUES ($1, $2, $3)
    RETURNING id, scanner_id, scanner_location
  `, [scanner_id, scanner_location, hashedPassword]);

  return result.rows[0];
}

/**
 * Creates a new web user account (teacher or administrator) in the database.
 * For teacher accounts, validates and sanitizes course assignments against the database.
 * Administrators are created without course assignments.
 * @ai-generated
 * @param {object} payload - The user account data.
 * @param {string} payload.email - The user's email address (stored lowercase).
 * @param {string} payload.first_name - The user's first name.
 * @param {string} payload.last_name - The user's last name.
 * @param {string} payload.password - The plain-text password to hash and store.
 * @param {string} payload.role - The user's role; must be 'teacher' or 'administrator'.
 * @param {string|number[]} [payload.courses] - Course IDs to assign (teachers only).
 * @returns {Promise<object>} The newly created user record.
 * @throws {Error} If any required field is missing or the role is invalid.
 */
async function createWebUserAccount(payload) {
  let { email, first_name, last_name, password, role, courses } = payload;
  email = normalizeRequiredString(email, 'Email').toLowerCase();
  first_name = normalizeRequiredString(first_name, 'First name');
  last_name = normalizeRequiredString(last_name, 'Last name');
  password = normalizeRequiredString(password, 'Password');
  role = normalizeRequiredString(role, 'Role').toLowerCase();
  if (!['teacher', 'administrator'].includes(role)) {
    throw new Error('Role must be teacher or administrator');
  }

  const courseArray = role === 'teacher' ? await sanitizeCourseAssignments(courses) : [];
  const hashedPassword = await bcryptjs.hash(password, 10);
  const result = await pool.query(`
    INSERT INTO users (email, first_name, last_name, password_hash, role, courses)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id, email, first_name, last_name, role, courses
  `, [email, first_name, last_name, hashedPassword, role, courseArray]);

  return result.rows[0];
}

/**
 * Normalizes and validates all fields on a raw log payload, auto-filling student name
 * from the students table or prior logs if missing, and computing the period from the
 * scan time if not already provided.
 * @ai-generated
 * @param {object} rawLog - The raw log data from the request or CSV import.
 * @param {object} [options={}] - Validation options.
 * @param {boolean} [options.requireStudentId=true] - Whether to throw if student_id is missing.
 * @param {boolean} [options.requireScannerFields=true] - Whether to throw if scanner_location or scanner_id is missing.
 * @returns {Promise<object>} A fully normalized log object ready for database insertion.
 * @throws {Error} If required fields are missing based on the options provided.
 */
async function buildPreparedLogEntry(rawLog, options = {}) {
  const {
    requireStudentId = true,
    requireScannerFields = true
  } = options;
  let {
    period,
    scanner_location,
    scanner_id,
    student_id,
    first_name,
    last_name,
    time_scanned,
    date_scanned,
    status
  } = rawLog;

  period = normalizeOptionalValue(period);
  status = normalizeOptionalValue(status);
  first_name = normalizeOptionalValue(first_name);
  last_name = normalizeOptionalValue(last_name);
  scanner_location = normalizeOptionalValue(scanner_location);
  scanner_id = normalizeOptionalValue(scanner_id);
  student_id = normalizeOptionalValue(student_id);
  date_scanned = normalizeLogDateValue(date_scanned);
  time_scanned = normalizeLogTimeValue(time_scanned);

  if (requireStudentId && !student_id) {
    throw new Error('Student ID is required');
  }

  if (requireScannerFields && (!scanner_location || !scanner_id)) {
    throw new Error('Scanner location and scanner ID are required');
  }

  if (student_id && (!first_name || !last_name)) {
    const studentLookup = await pool.query(
      'SELECT first_name, last_name FROM students WHERE CAST(student_id AS TEXT) = $1 LIMIT 1',
      [student_id]
    );
    if (studentLookup.rows.length > 0) {
      first_name = first_name || normalizeOptionalValue(studentLookup.rows[0].first_name);
      last_name = last_name || normalizeOptionalValue(studentLookup.rows[0].last_name);
    } else {
      const priorLogLookup = await pool.query(`
        SELECT first_name, last_name
        FROM logs
        WHERE student_id = $1
          AND first_name IS NOT NULL
          AND BTRIM(first_name) <> ''
          AND last_name IS NOT NULL
          AND BTRIM(last_name) <> ''
        ORDER BY id DESC
        LIMIT 1
      `, [student_id]);
      if (priorLogLookup.rows.length > 0) {
        first_name = first_name || normalizeOptionalValue(priorLogLookup.rows[0].first_name);
        last_name = last_name || normalizeOptionalValue(priorLogLookup.rows[0].last_name);
      }
    }
  }

  if (date_scanned && time_scanned) {
    const fullTimestamp = `${date_scanned} ${time_scanned}`;
    const periods = await getPeriodsForDate(date_scanned);
    const computed = assignPeriodForLog({ id: 'new', time_scanned: fullTimestamp }, periods);
    if (computed) {
      period = period || computed;
    } else {
      console.log('Could not compute period for new log, will fill later');
    }
  }

  return {
    period,
    scanner_location,
    scanner_id,
    student_id,
    first_name,
    last_name,
    time_scanned,
    date_scanned,
    status
  };
}

/**
 * Inserts a fully prepared log entry object into the logs table.
 * Expects the input to already be normalized via buildPreparedLogEntry.
 * @ai-generated
 * @param {object} preparedLog - A normalized log object with all required fields.
 * @returns {Promise<void>}
 */
async function insertPreparedLogEntry(preparedLog) {
  await pool.query(`
    INSERT INTO logs (
      period,
      scanner_location,
      scanner_id,
      student_id,
      first_name,
      last_name,
      time_scanned,
      date_scanned,
      status
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  `, [
    preparedLog.period,
    preparedLog.scanner_location,
    preparedLog.scanner_id,
    preparedLog.student_id,
    preparedLog.first_name,
    preparedLog.last_name,
    preparedLog.time_scanned,
    preparedLog.date_scanned,
    preparedLog.status
  ]);
}



/*-------------------------------------- Encryption Functions --------------------------------------*/

/**
 * Derives a 32-byte AES encryption key for a given date using HMAC-SHA256
 * keyed by the application's MASTER_KEY environment variable.
 * Defaults to the current Los Angeles date if no date is provided.
 * @ai-generated
 * @param {string|null} [dateString=null] - The date to derive the key for (YYYY-MM-DD).
 * @returns {Buffer} A 32-byte derived key for use with AES-256-GCM.
 */
function getDailyKey(dateString = null) {
  const date = dateString || getLosAngelesDateString();
  return crypto
    .createHmac('sha256', MASTER_KEY)
    .update(date)
    .digest()
    .subarray(0, 32);
}

/**
 * Encrypts a plain-text string using AES-256-GCM with a daily rotating key.
 * Generates a random 12-byte IV for each encryption operation.
 * @ai-generated
 * @param {string} text - The plain-text string to encrypt (e.g. a student ID).
 * @returns {{ encryptedData: string, iv: string, authTag: string, date: string }}
 *   An object containing the hex-encoded ciphertext, IV, GCM auth tag, and the date used for key derivation.
 */
function encrypt(text) {
  const key = getDailyKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return {
    encryptedData: encrypted,
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    date: getLosAngelesDateString()
  };
}

/**
 * Decrypts a ciphertext string previously encrypted with the encrypt() function.
 * Derives the daily key using the original encryption date to ensure key alignment.
 * @ai-generated
 * @param {string} encryptedData - Hex-encoded ciphertext.
 * @param {string} ivHex - Hex-encoded initialization vector used during encryption.
 * @param {string} authTagHex - Hex-encoded GCM authentication tag.
 * @param {string} date - The YYYY-MM-DD date used to derive the original encryption key.
 * @returns {string} The decrypted plain-text string.
 * @throws {Error} If the auth tag is invalid or the data has been tampered with.
 */
function decrypt(encryptedData, ivHex, authTagHex, date) {
  const key = getDailyKey(date);
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(ivHex, 'hex')
  );
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}


/*---------------------------------------- App Authentication ----------------------------------------------*/

/**
 * POST /api/students
 * Creates a single new student account.
 * @ai-generated
 * @access Administrator only
 * @body {object} Student fields: student_id, first_name, last_name, password, uuid (optional)
 * @returns {201} The newly created student record.
 */
app.post('/api/students', verifyToken, requireRole('administrator'), async (req, res) => {
  try {
    const createdStudent = await createStudentAccount(req.body);
    res.status(201).json(createdStudent);
  }
  catch (err){
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to create student'});
  }
});

/**
 * POST /api/students/bulk
 * Creates multiple student accounts from an array of student objects.
 * @ai-generated
 * @access Administrator only
 * @body {{ students: object[] }} Array of student payloads to insert.
 * @returns {201} Success message with the number of students inserted.
 */
app.post('/api/students/bulk', verifyToken, requireRole('administrator'), async (req, res) => {
  const rows = Array.isArray(req.body?.students) ? req.body.students : [];
  if (!rows.length) {
    return res.status(400).json({ error: 'No student rows were provided' });
  }

  try {
    for (const row of rows) {
      await createStudentAccount(row);
    }
    res.status(201).json({ message: 'Students uploaded successfully', inserted: rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to upload students' });
  }
});

/**
 * GET /api/students
 * Retrieves all student accounts, ordered by student_id ascending.
 * @ai-generated
 * @access Administrator only
 * @returns {200} Array of student records (id, student_id, first_name, last_name, created_at).
 */
app.get('/api/students', verifyToken, requireRole('administrator'), async (req, res) => {
  try {
    const result = await pool.query('SELECT id, student_id, first_name, last_name, created_at FROM students ORDER BY student_id ASC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch students' });
  }
});

/**
 * GET /api/students/search
 * Searches students by student_id, first_name, or last_name using a partial match.
 * @ai-generated
 * @access Authenticated users
 * @query {string} q - The search term to match against student fields.
 * @returns {200} Array of up to 25 matching student records.
 */
app.get('/api/students/search', verifyToken, async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (!query) {
    return res.json([]);
  }
  try {
    const result = await pool.query(`
      SELECT id, student_id, first_name, last_name, created_at
      FROM students
      WHERE CAST(student_id AS TEXT) ILIKE $1
         OR first_name ILIKE $1
         OR last_name ILIKE $1
      ORDER BY last_name ASC, first_name ASC, student_id ASC
      LIMIT 25
    `, [`%${query}%`]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to search students' });
  }
});

/**
 * GET /api/students/:id
 * Retrieves a single student by their database ID.
 * @ai-generated
 * @access Administrator only
 * @param {string} id - The database ID of the student.
 * @returns {200} The student record, or 404 if not found.
 */
app.get('/api/students/:id', verifyToken, requireRole('administrator'), async (req, res) => {
  try {
    const result = await pool.query('SELECT id, student_id, first_name, last_name, created_at FROM students WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch student' });
  }
});

/**
 * PUT /api/students/:id
 * Updates one or more fields on an existing student account. All fields are optional.
 * Passwords are automatically hashed before storage.
 * @ai-generated
 * @access Administrator only
 * @param {string} id - The database ID of the student to update.
 * @body {object} Any of: student_id, first_name, last_name, password.
 * @returns {200} The updated student record, or 404 if not found.
 */
app.put('/api/students/:id', verifyToken, requireRole('administrator'), async (req, res) => {
  const { student_id, first_name, last_name, password } = req.body;
  try {
    let query = 'UPDATE students SET ';
    let params = [];
    let paramCount = 1;

    if (student_id !== undefined) {
      query += `student_id = $${paramCount}, `;
      params.push(student_id);
      paramCount++;
    }
    if (first_name !== undefined) {
      query += `first_name = $${paramCount}, `;
      params.push(first_name);
      paramCount++;
    }
    if (last_name !== undefined) {
      query += `last_name = $${paramCount}, `;
      params.push(last_name);
      paramCount++;
    }
    if (password !== undefined) {
      const hashedPassword = await bcryptjs.hash(password, 10);
      query += `password_hash = $${paramCount}, `;
      params.push(hashedPassword);
      paramCount++;
    }
    query = query.slice(0, -2);
    query += ` WHERE id = $${paramCount} RETURNING id, student_id, first_name, last_name`;
    params.push(req.params.id);

    const result = await pool.query(query, params);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update student' });
  }
});

/**
 * DELETE /api/students/:id
 * Permanently deletes a student account from the database.
 * @ai-generated
 * @access Administrator only
 * @param {string} id - The database ID of the student to delete.
 * @returns {200} Success message, or 404 if the student was not found.
 */
app.delete('/api/students/:id', verifyToken, requireRole('administrator'), async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM students WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }
    res.json({ message: 'Student deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete student' });
  }
});

/**
 * POST /api/app/auth/login
 * Authenticates a student using their student_id and password.
 * On first login, binds the account to the device's UUID.
 * Subsequent logins from a different UUID are rejected.
 * @ai-generated
 * @access Public
 * @body {{ student_id: string, password: string, uuid: string }}
 * @returns {200} JWT token and basic user info on success.
 */
app.post('/api/app/auth/login', async (req, res) => {
  const { student_id, password, uuid } = req.body;
  if (!student_id || !password) {
    return res.status(400).json({ error: 'Student ID and Password are required' });
  }
  try {
    const result = await pool.query(
      'SELECT * FROM students WHERE student_id = $1',
      [student_id]
    );
    const student = result.rows[0];
    if (result.rowCount === 0) {
      return res.status(401).json({ error: 'Invalid Student ID or password' });
    }
    if (student.uuid && student.uuid !== uuid) {
    return res.status(403).json({ error: 'This device is not authorized' });
  }
    if (!student.uuid) {
      await pool.query(
        `UPDATE students
        SET uuid = $1
        WHERE id = $2 AND uuid IS NULL`,
        [uuid, student.id]
      );
    }
    const passwordMatch = await bcryptjs.compare(
      password,
      student.password_hash
    );
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid Student ID or password' });
    }
    if (student.uuid && student.uuid !== uuid) {
      return res.status(403).json({ error: 'This device is not authorized' });
    }
    if (!student.uuid) {
      await pool.query(
        'UPDATE students SET uuid = $1 WHERE id = $2',
        [uuid, student.id]
      );
    } 
    const token = jwt.sign(
      { 
        id: student_id, 
        uuid: uuid
      },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '24h' }
    );
    req.session.user = {
      id: student_id, 
      uuid: uuid,
      token: token
    };
    res.json({ 
      message: 'Login successful',
      token: token,
      user: {
        id: student_id, 
        uuid: uuid
      }
    });
  } catch (err) {
    console.error('Login Error: ', err);
    return res.status(500).json({ error: 'Server error during login' });
  }
});

/**
 * POST /api/app/encrypt_student_id
 * Encrypts a student ID using the current daily AES-256-GCM key.
 * Used by the mobile app to generate a secure QR code payload for scanning.
 * @ai-generated
 * @access Authenticated students
 * @body {{ student_id: string }}
 * @returns {200} Encrypted payload object: { encryptedData, iv, authTag, date }.
 */
app.post('/api/app/encrypt_student_id', verifyToken, (req, res) => {
  const { student_id } = req.body;
  if (!student_id) {
    return res.status(400).json({ error: 'Student ID is required' });
  }
  try {
    const encrypted = encrypt(student_id);
    res.json(encrypted);
  } catch (err) {
    console.error('Encryption error:', err);
    res.status(500).json({ error: 'Failed to encrypt student ID' });
  }
});

/**
 * POST /api/scanner/decrypt
 * Decrypts an encrypted student ID payload that was generated by the mobile app.
 * Used by the scanner to recover the student ID from a scanned QR code.
 * @ai-generated
 * @access Authenticated (scanner)
 * @body {{ encryptedData: string, iv: string, authTag: string, date: string }}
 * @returns {200} The decrypted student ID: { student_id }.
 */
app.post('/api/scanner/decrypt', verifyToken, (req, res) => {
  const { encryptedData, iv, authTag, date } = req.body;
  try {
    const studentID = decrypt(encryptedData, iv, authTag, date);
    res.json({ student_id: studentID });
  } catch (err) {
    res.status(400).json({ error: 'Decryption failed' });
  }
});

/**
 * POST /api/scanner/log
 * Accepts an encrypted NFC payload from a scanner, decrypts the student ID,
 * and creates a log entry in one atomic operation.
 * @access Authenticated (scanner)
 * @body {{ encryptedData, iv, authTag, date, scanner_location, scanner_id, time_scanned, date_scanned }}
 * @returns {201} Created log with the resolved student_id.
 */
app.post('/api/scanner/log', verifyToken, async (req, res) => {
  const { encryptedData, iv, authTag, date,
          scanner_location, scanner_id,
          time_scanned, date_scanned } = req.body;

  if (!encryptedData || !iv || !authTag || !date) {
    return res.status(400).json({ error: 'Missing encrypted payload fields' });
  }

  let student_id;
  try {
    student_id = decrypt(encryptedData, iv, authTag, date);
  } catch {
    return res.status(400).json({ error: 'Decryption failed — tag may be expired or tampered' });
  }

  try {
    const preparedLog = await buildPreparedLogEntry({
      student_id,
      scanner_location: scanner_location ?? req.user.scanner_id,
      scanner_id:       scanner_id       ?? req.user.scanner_id,
      time_scanned,
      date_scanned,
      method: 'nfc',
      status: null
    });
    await insertPreparedLogEntry(preparedLog);
    await assignPeriodsToLogs();
    await assignStatusesToLogs();
    res.status(201).json({ message: 'Log created', student_id });
  } catch (err) {
    console.error('[scanner/log]', err);
    res.status(500).json({ error: err.message || 'Failed to save log' });
  }
});

/**
 * POST /api/app/students/:id/reset_uuid
 * Clears the bound device UUID for a student, allowing them to log in from a new device.
 * @ai-generated
 * @access Administrator only
 * @param {string} id - The database ID of the student.
 * @returns {200} Success message, or 404 if the student was not found.
 */
app.post('/api/app/students/:id/reset_uuid', verifyToken, requireRole('administrator'), async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('UPDATE students SET uuid = NULL WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }
    res.json({ message: 'UUID reset successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to reset UUID' });
  }
});


/*---------------------------------------- Scanner Authentication ----------------------------------------------*/

/**
 * POST /api/scanners
 * Creates a single new scanner account.
 * @ai-generated
 * @access Administrator only
 * @body {{ SCANNER_ID: string, SCANNER_LOCATION: string, SCANNER_PASSWORD: string }}
 * @returns {201} The newly created scanner record.
 */
app.post('/api/scanners', verifyToken, requireRole('administrator'), async (req, res) => {
  try {
    const createdScanner = await createScannerAccount({
      scanner_id: req.body.SCANNER_ID,
      scanner_location: req.body.SCANNER_LOCATION,
      scanner_password: req.body.SCANNER_PASSWORD
    });
    res.status(201).json(createdScanner);
  }
  catch (err){
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to create scanner'});
  }
});

/**
 * POST /api/scanners/bulk
 * Creates multiple scanner accounts from an array of scanner objects.
 * @ai-generated
 * @access Administrator only
 * @body {{ scanners: object[] }} Array of scanner payloads to insert.
 * @returns {201} Success message with the number of scanners inserted.
 */
app.post('/api/scanners/bulk', verifyToken, requireRole('administrator'), async (req, res) => {
  const rows = Array.isArray(req.body?.scanners) ? req.body.scanners : [];
  if (!rows.length) {
    return res.status(400).json({ error: 'No scanner rows were provided' });
  }

  try {
    for (const row of rows) {
      await createScannerAccount(row);
    }
    res.status(201).json({ message: 'Scanners uploaded successfully', inserted: rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to upload scanners' });
  }
});

/**
 * GET /api/scanners
 * Retrieves all scanner accounts with their current status and battery level.
 * @ai-generated
 * @access Administrator only
 * @returns {200} Array of scanner records (id, scanner_id, scanner_location, scanner_status, last_sync, battery_level).
 */
app.get('/api/scanners', verifyToken, requireRole('administrator'), async (req, res) => {
  try {
    const result = await pool.query('SELECT id, scanner_id, scanner_location, scanner_status, last_sync, battery_level FROM scanners ORDER BY scanner_id ASC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch scanners' });
  }
});

/**
 * GET /api/scanners/:id
 * Retrieves a single scanner by its database ID.
 * @ai-generated
 * @access Administrator only
 * @param {string} id - The database ID of the scanner.
 * @returns {200} The scanner record, or 404 if not found.
 */
app.get('/api/scanners/:id', verifyToken, requireRole('administrator'), async (req, res) => {
  try {
    const result = await pool.query('SELECT id, scanner_id, scanner_location, scanner_status, last_sync, battery_level FROM scanners WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Scanner not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch scanner' });
  }
});

/**
 * PUT /api/scanners/:id
 * Updates one or more fields on an existing scanner account. All fields are optional.
 * @ai-generated
 * @access Administrator only
 * @param {string} id - The database ID of the scanner to update.
 * @body {object} Any of: scanner_id, scanner_location, scanner_password.
 * @returns {200} The updated scanner record, or 404 if not found.
 */
app.put('/api/scanners/:id', verifyToken, requireRole('administrator'), async (req, res) => {
  const { scanner_id, scanner_location, scanner_password } = req.body;
  try {
    let query = 'UPDATE scanners SET ';
    let params = [];
    let paramCount = 1;
    if (scanner_id !== undefined) {
      query += `scanner_id = $${paramCount}, `;
      params.push(scanner_id);
      paramCount++;
    }
    if (scanner_location !== undefined) {
      query += `scanner_location = $${paramCount}, `;
      params.push(scanner_location);
      paramCount++;
    }
    if (scanner_password !== undefined) {
      const hashedPassword = await bcryptjs.hash(scanner_password, 10);
      query += `password_hash = $${paramCount}, `;
      params.push(hashedPassword);
      paramCount++;
    }
    query = query.slice(0, -2);
    query += ` WHERE id = $${paramCount} RETURNING id, scanner_id, scanner_location`;
    params.push(req.params.id);
    const result = await pool.query(query, params);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Scanner not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update scanner' });
  }
});

/**
 * DELETE /api/scanners/:id
 * Permanently deletes a scanner account from the database.
 * @ai-generated
 * @access Administrator only
 * @param {string} id - The database ID of the scanner to delete.
 * @returns {200} Success message, or 404 if the scanner was not found.
 */
app.delete('/api/scanners/:id', verifyToken, requireRole('administrator'), async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM scanners WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Scanner not found' });
    }
    res.json({ message: 'Scanner deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete scanner' });
  }
});

/**
 * POST /api/scanner/auth/login
 * Authenticates a scanner device using its scanner_id and password.
 * Returns a JWT token with the scanner role for subsequent authenticated requests.
 * @ai-generated
 * @access Public
 * @body {{ SCANNER_ID: string, SCANNER_LOCATION: string, SCANNER_PASSWORD: string }}
 * @returns {200} JWT token and scanner info on success.
 */
app.post('/api/scanner/auth/login', async (req, res) => {
  const {SCANNER_ID, SCANNER_LOCATION, SCANNER_PASSWORD} = req.body;
  try {
    const result = await pool.query(
      'SELECT * FROM scanners WHERE scanner_id = $1',
      [SCANNER_ID]
    );
    if (result.rowCount === 0) {
      return res.status(401).json({ error: 'Invalid Scanner ID or password' });
    }
    const scanner = result.rows[0];
    const passwordMatch = await bcryptjs.compare(
      SCANNER_PASSWORD,
      scanner.password_hash
    );
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid Scanner ID or password' });
    }
    const token = jwt.sign(
      { 
        id: scanner.id,
        scanner_id: scanner.scanner_id,
        role: 'scanner'
      },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '24h' }
    );
    req.session.user = {
      id: scanner.id,
      scanner_id: scanner.scanner_id,
      role: 'scanner',
      token: token
    };
    res.json({ 
      message: 'Login successful',
      token: token,
      user: {
        id: scanner.id,
        scanner_id: scanner.scanner_id,
        role: 'scanner'
      }
    });
  } catch (err) {
    console.error('Login Error:', err);
    return res.status(500).json({ error: 'Server error during login' });
  }
});

/**
 * GET /api/scanner/key_me
 * Returns the current daily AES key derived from the master key and today's date.
 * Used by scanner devices that need to perform local decryption.
 * @ai-generated
 * @access Authenticated
 * @returns {200} The current daily key as a Buffer: { key }.
 */
app.get('/api/scanner/key_me', verifyToken, async (req, res) => {
  try {
    const result = getDailyKey();
    res.json({
      key: result
    });
  } catch (err) {
    console.error('Error fetching daily key:', err);
    res.status(500).json({ error: 'Failed to fetch daily key' });
  }
});

const scannerTerminalSessions = {};

/**
 * Returns the in-memory terminal session object for a given scanner ID.
 * Creates a new default session if one doesn't already exist.
 * @ai-generated
 * @param {string} scannerId - The scanner's database ID.
 * @returns {object} The session object tracking mode, command queue, output history, etc.
 */
function getScannerSession(scannerId) {
  if (!scannerTerminalSessions[scannerId]) {
    scannerTerminalSessions[scannerId] = {
      mode: 'scanner',
      commandQueue: [],
      nextCommandId: 1,
      lastOutput: '',
      lastOutputTime: null,
      outputVersion: 0,
      outputHistory: [],
      scannerLastSeenAt: null
    };
  }
  return scannerTerminalSessions[scannerId];
}

/**
 * Normalizes a raw mode string to either 'enroll' or 'scanner'.
 * @ai-generated
 * @param {string} mode - Raw mode string from a scanner message or command.
 * @returns {'enroll'|'scanner'} The normalized mode value.
 */
function normalizeScannerMode(mode) {
  const value = String(mode || '').trim().toLowerCase();
  if (value === 'enroll' || value === 'enrollment') return 'enroll';
  return 'scanner';
}

/**
 * Determines the new scanner mode based on a terminal command string.
 * Returns the current mode unchanged if the command doesn't trigger a mode switch.
 * @ai-generated
 * @param {string} command - The terminal command sent to the scanner.
 * @param {string} currentMode - The scanner's current mode ('scanner' or 'enroll').
 * @returns {'enroll'|'scanner'} The resulting mode after processing the command.
 */
function modeFromTerminalCommand(command, currentMode) {
  const value = String(command || '').trim().toLowerCase();
  if (value === 'enroll' || value === 'mode enroll' || value === 'enter enroll') {
    return 'enroll';
  }
  if (value === 'scanner' || value === 'scan' || value === 'mode scanner' || value === 'exit' || value === 'cancel') {
    return 'scanner';
  }
  return currentMode;
}

/**
 * POST /api/scanners/:id/terminal
 * Sends a command to a specific scanner via WebSocket or queues it if the scanner is offline.
 * Optimistically updates the server-side session mode for mode-switching commands.
 * @ai-generated
 * @access Administrator only
 * @param {string} id - The scanner's database ID.
 * @body {{ command: string }} The command string to send.
 * @returns {200} Confirmation with command ID and current session mode.
 */
app.post('/api/scanners/:id/terminal', verifyToken, requireRole('administrator'), async (req, res) => {
  const scannerId = req.params.id;
  const { command } = req.body;
  if (typeof command !== 'string') {
    return res.status(400).json({ error: 'Command must be a string' });
  }
  console.log(`[BACKEND] Received command for scanner ${req.params.id}:`, req.body.command);
  const session = getScannerSession(scannerId);
  const cmd = command.trim();
  
  // Update server-side session mode optimistically so GET /terminal/output
  // returns the correct mode immediately, before the scanner echoes it back.
  if (cmd === 'set mode enroll') {
    session.mode = 'enroll';
  } else if (cmd === 'set mode scanner') {
    session.mode = 'scanner';
  }
  
  const commandId = session.nextCommandId++;
  const ws = scannerSockets.get(scannerId);

  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({
      command: cmd,
      commandId
    }));
  } else {
    // fallback to queue (offline scanner)
    session.commandQueue.push({ command: cmd, commandId });
  }
  const MAX_QUEUE_SIZE = 5;
  if (session.commandQueue.length > MAX_QUEUE_SIZE) {
    session.commandQueue.shift(); // remove oldest
  }
  
  res.json({ 
    message: 'Command queued for scanner',
    pending: true,
    mode: session.mode,
    commandId: commandId
  });
});

/**
 * GET /api/scanners/:id/terminal
 * Polled by the scanner device to receive the next queued command.
 * Updates the scanner's last-seen timestamp on each poll.
 * @ai-generated
 * @access Authenticated
 * @param {string} id - The scanner's database ID.
 * @returns {200} The next queued command (or null), along with the current session mode and command ID.
 * Had help from CHATGPT to figure out the polling mechanism and command queue management for offline scanners.
 */
app.get('/api/scanners/:id/terminal', verifyToken, (req, res) => {
  const scannerId = req.params.id;
  const session = getScannerSession(scannerId);
  session.scannerLastSeenAt = new Date();
  
  if (session.commandQueue.length > 0) {
    const next = session.commandQueue.shift();  // remove from front
    res.json({ 
      command: next.command,
      mode: session.mode,
      commandId: next.commandId
    });
  } else {
    res.json({ 
      command: null,
      mode: session.mode,
      commandId: session.nextCommandId  // or just 0
    });
  }
});

/**
 * POST /api/scanners/:id/heartbeat
 * Called by scanner devices on a regular interval to report they are online.
 * Updates the scanner's last_sync timestamp and optionally its battery level.
 * @ai-generated
 * @access Authenticated
 * @param {string} id - The scanner's database ID.
 * @body {{ battery_level?: number }} Optional battery level (0–100).
 * @returns {200} Success message.
 */
app.post('/api/scanners/:id/heartbeat', verifyToken, async (req, res) => {
  const { id } = req.params;
  const { battery_level } = req.body;

  try {
    let query = `UPDATE scanners SET last_sync = NOW(), scanner_status = 'online'`;
    const params = [id];
    if (battery_level !== undefined && !isNaN(battery_level)) {
      query += `, battery_level = $2`;
      params.push(battery_level);
    }
    query += ` WHERE id = $1`;
    await pool.query(query, params);
    res.json({ message: 'Heartbeat received' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update heartbeat' });
  }
});

/**
 * POST /api/scanners/:id/terminal/output
 * Receives terminal output from a scanner device and stores it in the session history.
 * Also updates the scanner's mode and last-seen timestamp.
 * @ai-generated
 * @access Authenticated
 * @param {string} id - The scanner's database ID.
 * @body {{ output: string, mode: string, commandId?: number }}
 * @returns {200} Confirmation with the current session mode.
 */
app.post('/api/scanners/:id/terminal/output', verifyToken, async (req, res) => {
  const scannerId = req.params.id;
  const { output, mode, commandId } = req.body;
  console.log(`[SCANNER ${req.params.id}] ${output}`);
  const session = getScannerSession(scannerId);
  const now = new Date();
  session.scannerLastSeenAt = now;
  session.mode = normalizeScannerMode(mode || session.mode);

  if (typeof output === 'string' && output.trim() !== '') {
    session.lastOutput = output;
    session.lastOutputTime = now;
    session.outputVersion += 1;
    session.outputHistory.push({
      version: session.outputVersion,
      output,
      timestamp: now,
      commandId: commandId ?? null
    });
    if (session.outputHistory.length > 50) {
      session.outputHistory = session.outputHistory.slice(-50);
    }
  }

  res.json({ message: 'Output received', mode: session.mode });
});

/**
 * GET /api/scanners/:id/terminal/output
 * Polls for new terminal output from a scanner since a given version number.
 * Returns the latest output, version info, current mode, and the scanner's last-seen timestamp.
 * @ai-generated
 * @access Administrator only
 * @param {string} id - The scanner's database ID.
 * @query {number} [afterVersion=0] - Only return output entries with a version greater than this.
 * @returns {200} Output history entries, latest output string, current mode, and timestamps.
 */
app.get('/api/scanners/:id/terminal/output', verifyToken, requireRole('administrator'), (req, res) => {
  const scannerId = req.params.id;
  const session = getScannerSession(scannerId);
  const afterVersion = Number(req.query.afterVersion || 0);
  const entries = session.outputHistory.filter(entry => entry.version > afterVersion);
  res.json({ 
    output: session.lastOutput || '', 
    timestamp: session.lastOutputTime || null,
    mode: session.mode,
    outputVersion: session.outputVersion,
    scannerLastSeenAt: session.scannerLastSeenAt || null,
    entries
  });
});


/*---------------------------------------API Endpoints---------------------------------------*/

/*-------Authentication Endpoints-------*/

/**
 * POST /api/auth/login
 * Authenticates a web user (teacher or administrator) by email and password.
 * Subject to rate limiting (10 attempts per 15 minutes per email+IP).
 * @ai-generated
 * @access Public
 * @body {{ email: string, password: string }}
 * @returns {200} JWT token and user info (id, email, role, name, courses) on success.
 */
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const user = result.rows[0];
    const passwordMatch = await bcryptjs.compare(password, user.password_hash);

    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const token = jwt.sign(
      { 
        id: user.id, 
        email: user.email, 
        role: user.role,
        firstName: user.first_name,
        lastName: user.last_name,
        courses: Array.isArray(user.courses) ? user.courses : []
      },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '24h' }
    );
    req.session.user = {
      id: user.id,
      email: user.email,
      role: user.role,
      firstName: user.first_name,
      lastName: user.last_name,
      courses: Array.isArray(user.courses) ? user.courses : [],
      token: token
    };
    // Set token as HTTP-only cookie for page navigation requests
    res.cookie('auth_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 24 * 60 * 60 * 1000,
      sameSite: 'lax'
    });
    res.json({ 
      message: 'Login successful',
      token: token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        firstName: user.first_name,
        lastName: user.last_name,
        courses: Array.isArray(user.courses) ? user.courses : []
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error during login' });
  }
});

/**
 * POST /api/auth/logout
 * Destroys the current user session, effectively logging out the web user.
 * @ai-generated
 * @access Authenticated
 * @returns {200} Success message on logout.
 */
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('auth_token');
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Could not log out' });
    }
    res.json({ message: 'Logged out successfully' });
  });
});

/**
 * GET /api/auth/me
 * Returns the current authenticated user's profile, fetched fresh from the database.
 * @ai-generated
 * @access Authenticated
 * @returns {200} User record (id, email, first_name, last_name, role, created_at, courses).
 */
app.get('/api/auth/me', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, email, first_name, last_name, role, created_at, courses FROM users WHERE id = $1',
      [req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching user:', err);
    res.status(500).json({ error: 'Server error' });
  }
});



/*-------User Management Endpoints-------*/

/**
 * POST /api/users
 * Creates a single new web user account (teacher or administrator).
 * @ai-generated
 * @access Administrator only
 * @body {{ email, first_name, last_name, password, role, courses? }}
 * @returns {201} The newly created user record.
 */
app.post('/api/users', verifyToken, requireRole('administrator'), async (req, res) => {
  try {
    const createdUser = await createWebUserAccount(req.body);
    res.status(201).json(createdUser);
  } catch (err) {
    console.error(err);
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Email already exists' });
    }
    res.status(500).json({ error: err.message || 'Failed to create user' });
  }
});

/**
 * POST /api/users/bulk
 * Creates multiple web user accounts from an array of user objects.
 * @ai-generated
 * @access Administrator only
 * @body {{ users: object[] }} Array of user payloads to insert.
 * @returns {201} Success message with the number of users inserted.
 */
app.post('/api/users/bulk', verifyToken, requireRole('administrator'), async (req, res) => {
  const rows = Array.isArray(req.body?.users) ? req.body.users : [];
  if (!rows.length) {
    return res.status(400).json({ error: 'No user rows were provided' });
  }

  try {
    for (const row of rows) {
      await createWebUserAccount(row);
    }
    res.status(201).json({ message: 'Users uploaded successfully', inserted: rows.length });
  } catch (err) {
    console.error(err);
    if (err.code === '23505') {
      return res.status(400).json({ error: 'One or more emails already exist' });
    }
    res.status(500).json({ error: err.message || 'Failed to upload users' });
  }
});

/**
 * GET /api/users
 * Retrieves all web user accounts, ordered by email ascending.
 * @ai-generated
 * @access Administrator only
 * @returns {200} Array of user records (id, email, first_name, last_name, role, created_at, courses).
 */
app.get('/api/users', verifyToken, requireRole('administrator'), async (req, res) => {
  try {
    const result = await pool.query('SELECT id, email, first_name, last_name, role, created_at, courses FROM users ORDER BY email ASC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

/**
 * GET /api/users/:id
 * Retrieves a single web user by their database ID.
 * @ai-generated
 * @access Administrator only
 * @param {string} id - The database ID of the user.
 * @returns {200} The user record, or 404 if not found.
 */
app.get('/api/users/:id', verifyToken, requireRole('administrator'), async (req, res) => {
  try {
    const result = await pool.query('SELECT id, email, first_name, last_name, role, created_at, courses FROM users WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

/**
 * PUT /api/users/:id
 * Updates one or more fields on an existing web user account. All fields are optional.
 * For teachers, re-validates course assignments when courses or role are changed.
 * @ai-generated
 * @access Administrator only
 * @param {string} id - The database ID of the user to update.
 * @body {object} Any of: email, first_name, last_name, password, role, courses.
 * @returns {200} The updated user record, or 404 if not found.
 */
app.put('/api/users/:id', verifyToken, requireRole('administrator'), async (req, res) => {
  const { email, first_name, last_name, password, role, courses } = req.body;
  try {
    let existingUserRole = null;
    if (courses !== undefined && role === undefined) {
      const existingUser = await pool.query('SELECT role FROM users WHERE id = $1', [req.params.id]);
      if (!existingUser.rows.length) {
        return res.status(404).json({ error: 'User not found' });
      }
      existingUserRole = existingUser.rows[0].role;
    }

    let query = 'UPDATE users SET ';
    let params = [];
    let paramCount = 1;
    if (email !== undefined) {
      query += `email = $${paramCount}, `;
      params.push(email.toLowerCase());
      paramCount++;
    }
    if (first_name !== undefined) {
      query += `first_name = $${paramCount}, `;
      params.push(first_name);
      paramCount++;
    }
    if (last_name !== undefined) {
      query += `last_name = $${paramCount}, `;
      params.push(last_name);
      paramCount++;
    }
    if (password !== undefined) {
      const hashedPassword = await bcryptjs.hash(password, 10);
      query += `password_hash = $${paramCount}, `;
      params.push(hashedPassword);
      paramCount++;
    }
    if (role !== undefined) {
      if (!['teacher', 'administrator'].includes(role)) {
        return res.status(400).json({ error: 'Invalid role' });
      }
      query += `role = $${paramCount}, `;
      params.push(role);
      paramCount++;
    }
    if (courses !== undefined) {
      const effectiveRole = role !== undefined ? role : existingUserRole;
      const courseArray = effectiveRole === 'teacher'
        ? await sanitizeCourseAssignments(courses)
        : [];
      query += `courses = $${paramCount}, `;
      params.push(courseArray);
      paramCount++;
    }
    query = query.slice(0, -2);
    query += ` WHERE id = $${paramCount} RETURNING id, email, first_name, last_name, role, courses`;
    params.push(req.params.id);
    const result = await pool.query(query, params);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

/**
 * DELETE /api/users/:id
 * Permanently deletes a web user account from the database.
 * @ai-generated
 * @access Administrator only
 * @param {string} id - The database ID of the user to delete.
 * @returns {200} Success message, or 404 if the user was not found.
 */
app.delete('/api/users/:id', verifyToken, requireRole('administrator'), async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM users WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ message: 'User deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});



/*---------------------------- Current Class Map Endpoints ----------------------------*/

/**
 * POST /api/map-layout
 * Saves or replaces the campus map layout (rooms and scanner positions).
 * Uses an upsert so there is always exactly one map layout stored (id=1).
 * @ai-generated
 * @access Authenticated
 * @body {object} The full map layout object (rooms, scanners, etc.).
 * @returns {200} Success message.
 */
app.post('/api/map-layout', verifyToken, async (req, res) => {
  try {
    const mapData = req.body;
    await pool.query(`
      INSERT INTO map_layouts (id, data)
      VALUES (1, $1)
      ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, created_at = CURRENT_TIMESTAMP
    `, [JSON.stringify(mapData)]);
    res.json({ message: 'Map saved successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save map' });
  }
});

/**
 * GET /api/map-layout
 * Retrieves the saved campus map layout.
 * Returns an empty layout if no map has been saved yet.
 * @ai-generated
 * @access Authenticated
 * @returns {200} The map layout object, or { rooms: [], scanners: [] } if none exists.
 */
app.get('/api/map-layout', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT data FROM map_layouts WHERE id = 1
    `);
    if (result.rows.length === 0) {
      return res.json({ rooms: [], scanners: [] });
    }
    res.json(result.rows[0].data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load map' });
  }
});


/*-------Courses Endpoints-------*/

/**
 * POST /api/courses
 * Creates a new course with a room and period. Room+period combinations must be unique.
 * @ai-generated
 * @access Administrator only
 * @body {{ room: string, period: string }}
 * @returns {201} The newly created course (id, room, period).
 */
app.post('/api/courses', verifyToken, requireRole('administrator'), async (req, res) => {
  const { room, period } = req.body;
  if (!room || !period) {
    return res.status(400).json({ error: 'Room and period are required' });
  }
  try {
    const result = await pool.query(`
      INSERT INTO courses (room, period)
      VALUES ($1, $2)
      RETURNING id, room, period
    `, [room, period]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === '23505') {
      return res.status(400).json({ error: 'This course already exists' });
    }
    res.status(500).json({ error: 'Failed to create course' });
  }
});

/**
 * GET /api/courses
 * Returns the list of courses visible to the authenticated user.
 * Administrators see all courses; teachers see only their assigned courses.
 * @ai-generated
 * @access Authenticated
 * @returns {200} Array of course objects (id, room, period).
 */
app.get('/api/courses', verifyToken, async (req, res) => {
  try {
    const courses = await getVisibleCoursesForUser(req.user);
    res.json(courses);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch courses' });
  }
});

/**
 * DELETE /api/courses/:id
 * Deletes a course and removes it from all teacher course assignments.
 * @ai-generated
 * @access Administrator only
 * @param {string} id - The database ID of the course to delete.
 * @returns {200} Success message, or 404 if the course was not found.
 */
app.delete('/api/courses/:id', verifyToken, requireRole('administrator'), async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM courses WHERE id = $1 RETURNING id', [req.params.id]);
    await pool.query('UPDATE users SET courses = array_remove(courses, $1) WHERE $1 = ANY(courses)', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Course not found' });
    }
    res.json({ message: 'Course deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete course' });
  }
});

/*-------Calendar Endpoints-------*/

/**
 * GET /api/calendar/today
 * Returns today's class periods, using the calendar cache when available.
 * Falls back to hardcoded default periods if the API or cache is unavailable.
 * @ai-generated
 * @access Public
 * @returns {200} Object containing { events, lastUpdated, date }.
 */
app.get('/api/calendar/today', async (req, res) => {
  try {
    const today = getLosAngelesDateString();
    const periods = await getPeriodsForDate(today);
    res.json({
      events: periods,
      lastUpdated: calendarCache.lastUpdated,
      date: today
    });
  } catch (err) {
    console.error(err);
    res.json({
      events: getFallbackPeriods(),
      lastUpdated: new Date().toISOString(),
      date: getLosAngelesDateString()
    });
  }
});

/**
 * PUT /api/courses/:id
 * Updates the room and/or period of an existing course.
 * @ai-generated
 * @access Administrator only
 * @param {string} id - The database ID of the course to update.
 * @body {{ room: string, period: string }}
 * @returns {200} The updated course record, or 404 if not found.
 */
app.put('/api/courses/:id', verifyToken, requireRole('administrator'), async (req, res) => {
  const { room, period } = req.body;
  if (!room || !period) {
    return res.status(400).json({ error: 'Room and period are required' });
  }

  try {
    const result = await pool.query(`
      UPDATE courses
      SET room = $1, period = $2
      WHERE id = $3
      RETURNING id, room, period
    `, [room, period, req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Course not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === '23505') {
      return res.status(400).json({ error: 'This course already exists' });
    }
    res.status(500).json({ error: 'Failed to update course' });
  }
});



/*-------Log Endpoints-------*/

/**
 * GET /api/logs
 * Returns all attendance logs visible to the authenticated user, sorted newest-first.
 * @ai-generated
 * @access Authenticated
 * @returns {200} Array of log objects.
 */
app.get('/api/logs', verifyToken, async (req, res) => {
  try {
    const logs = await getVisibleLogsForUser(req.user);
    res.json(logs);
  } catch (err) {
    console.error('Error fetching logs:', err);
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

/**
 * GET /api/logs/csv
 * Exports all visible logs as a downloadable CSV file.
 * @ai-generated
 * @access Authenticated
 * @returns {200} CSV file attachment (Content-Disposition: attachment; filename=logs.csv).
 */
app.get('/api/logs/csv', verifyToken, async (req, res) => {
  try {
    const logs = await getVisibleLogsForUser(req.user);
    const csv = convertToCsv(logs);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=logs.csv');
    res.send(csv);
  } catch (err) {
    console.error('Error fetching logs for CSV:', err);
    res.status(500).json({ error: 'Failed to fetch logs for CSV' });
  }
});

/**
 * POST /api/logs
 * Creates a single new attendance log entry.
 * Applies teacher scope restrictions, normalizes the payload, and triggers
 * period and status auto-assignment after insertion.
 * @ai-generated
 * @access Authenticated
 * @body {object} Log fields: student_id, scanner_location, scanner_id, time_scanned, date_scanned, etc.
 * @returns {201} Success message on creation.
 */
app.post('/api/logs', verifyToken, async (req, res) => {
  try {
    const scopedPayload = await applyTeacherLogScope(req.body, req.user);
    const preparedLog = await buildPreparedLogEntry(scopedPayload);
    await insertPreparedLogEntry(preparedLog);
    await assignPeriodsToLogs();
    await assignStatusesToLogs();
    res.status(201).json({ message: 'Log entry created successfully' });
  } catch (err) {
    console.error('Error creating log entry:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to create log entry' });
  }
});

/**
 * POST /api/logs/bulk
 * Imports multiple attendance log entries from an array (typically from a CSV upload).
 * Applies teacher scope restrictions per entry and triggers period/status assignment after all inserts.
 * @ai-generated
 * @access Authenticated
 * @body {{ logs: object[] }} Array of log payloads to insert.
 * @returns {201} Success message with the number of logs inserted.
 */
app.post('/api/logs/bulk', verifyToken, async (req, res) => {
  const incomingLogs = Array.isArray(req.body?.logs) ? req.body.logs : [];
  if (!incomingLogs.length) {
    return res.status(400).json({ error: 'No log rows were provided' });
  }

  try {
    for (let index = 0; index < incomingLogs.length; index += 1) {
      const scopedPayload = await applyTeacherLogScope(incomingLogs[index], req.user);
      const preparedLog = await buildPreparedLogEntry(scopedPayload, {
        requireStudentId: true,
        requireScannerFields: false
      });
      await insertPreparedLogEntry(preparedLog);
    }
    await assignPeriodsToLogs();
    await assignStatusesToLogs();
    res.status(201).json({ message: 'CSV logs uploaded successfully', inserted: incomingLogs.length });
  } catch (err) {
    console.error('Error uploading CSV logs:', err);
    res.status(500).json({ error: err.message || 'Failed to upload CSV logs' });
  }
});

/**
 * DELETE /api/logs/:id
 * Deletes a single log entry. Teachers may only delete logs within their assigned courses.
 * @ai-generated
 * @access Authenticated
 * @param {string} id - The database ID of the log entry to delete.
 * @returns {200} Success message, or 403/404 if unauthorized or not found.
 */
app.delete('/api/logs/:id', verifyToken, async (req, res) => {
  const logId = req.params.id;
  try {
    await assertUserCanManageLog(req.user, logId);
    await pool.query('DELETE FROM logs WHERE id = $1', [logId]);
    res.json({ message: 'Log entry deleted successfully' });
  } catch (err) {
    console.error('Error deleting log entry:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to delete log entry' });
  }
});

/**
 * POST /api/admin/logs/clear
 * Deletes all log entries from the database. This action is irreversible.
 * @ai-generated
 * @access Administrator only
 * @returns {200} Success message with the count of deleted rows.
 */
app.post('/api/admin/logs/clear', verifyToken, requireRole('administrator'), async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM logs');
    res.json({ message: 'All logs deleted successfully', deleted: result.rowCount || 0 });
  } catch (err) {
    console.error('Error clearing logs:', err);
    res.status(500).json({ error: 'Failed to clear logs' });
  }
});

/**
 * POST /api/admin/reindex
 * Runs REINDEX DATABASE on the configured PostgreSQL database to rebuild indexes.
 * The database name is read from the DB_NAME environment variable and validated
 * to prevent SQL injection before use in the query.
 * @ai-generated
 * @access Administrator only
 * @returns {200} Success message with the database name, or 500 if misconfigured.
 */
app.post('/api/admin/reindex', verifyToken, requireRole('administrator'), async (req, res) => {
  const databaseName = String(process.env.DB_NAME || '').trim();
  if (!databaseName || !/^[a-zA-Z0-9_]+$/.test(databaseName)) {
    return res.status(500).json({ error: 'Database name is not configured for reindexing' });
  }

  try {
    await pool.query(`REINDEX DATABASE ${databaseName}`);
    res.json({ message: `Database ${databaseName} reindexed successfully` });
  } catch (err) {
    console.error('Error reindexing database:', err);
    res.status(500).json({ error: 'Failed to reindex database' });
  }
});

/**
 * POST /api/logs/assign-periods
 * Manually triggers the batch job that assigns periods to all logs currently missing one.
 * @ai-generated
 * @access Authenticated
 * @returns {200} Success message on completion.
 */
app.post('/api/logs/assign-periods', verifyToken, async (req, res) => {
  try {
    await assignPeriodsToLogs();
    res.json({ message: 'Periods assigned to all eligible logs' });
  } catch (err) {
    console.error('Error assigning periods:', err);
    res.status(500).json({ error: 'Failed to assign periods' });
  }
});

/**
 * POST /api/logs/assign-statuses
 * Manually triggers the batch job that assigns attendance statuses to all logs currently missing one.
 * @ai-generated
 * @access Authenticated
 * @returns {200} Success message on completion.
 */
app.post('/api/logs/assign-statuses', verifyToken, async (req, res) => {
  try {
    await assignStatusesToLogs();
    res.json({ message: 'Statuses assigned to all eligible logs' });
  } catch (err) {
    console.error('Error assigning statuses:', err);
    res.status(500).json({ error: 'Failed to assign statuses' });
  }
});

/**
 * GET /api/logs/analytics
 * Returns aggregated attendance totals grouped by student, scanner location, and period.
 * Results are scoped to the authenticated user's visible courses.
 * @ai-generated
 * @access Authenticated
 * @returns {200} Array of aggregated records sorted alphabetically by student name and period.
 */
app.get('/api/logs/analytics', verifyToken, async (req, res) => {
  try {
    const visibleLogs = await getVisibleLogsForUser(req.user);
    const totals = new Map();

    visibleLogs.forEach(log => {
      const key = [
        log.first_name || '',
        log.last_name || '',
        log.scanner_location || '',
        log.student_id || '',
        log.period || ''
      ].join('__');

      if (!totals.has(key)) {
        totals.set(key, {
          first_name: log.first_name,
          last_name: log.last_name,
          scanner_location: log.scanner_location,
          student_id: log.student_id,
          period: log.period,
          total: 0
        });
      }

      totals.get(key).total += 1;
    });

    res.json(
      Array.from(totals.values()).sort((left, right) =>
        `${left.first_name || ''}${left.last_name || ''}${left.period || ''}`.localeCompare(
          `${right.first_name || ''}${right.last_name || ''}${right.period || ''}`
        )
      )
    );
  } catch (err) {
    console.error('Error fetching analytics:', err);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

/**
 * GET /api/logs/:room
 * Returns all visible logs filtered to a specific scanner room/location.
 * @ai-generated
 * @access Authenticated
 * @param {string} room - The scanner_location value to filter by.
 * @returns {200} Array of log objects for the specified room.
 */
app.get('/api/logs/:room', verifyToken, async (req, res) => {
  const { room } = req.params;
  try {
    const visibleLogs = await getVisibleLogsForUser(req.user);
    res.json(visibleLogs.filter(log => String(log.scanner_location || '') === String(room)));
  } catch (err) {
    console.error('Error fetching logs for room and period:', err);
    res.status(500).json({ error: 'Failed to fetch logs for room and period' });
  }
});

/**
 * GET /api/logs/:room/:period
 * Returns all visible logs filtered to a specific room and class period.
 * @ai-generated
 * @access Authenticated
 * @param {string} room - The scanner_location value to filter by.
 * @param {string} period - The period label to filter by (e.g. "Period 1").
 * @returns {200} Array of log objects for the specified room and period.
 */
app.get('/api/logs/:room/:period', verifyToken, async (req, res) => {
  const { room, period } = req.params;
  try {
    const visibleLogs = await getVisibleLogsForUser(req.user);
    res.json(
      visibleLogs.filter(log =>
        String(log.scanner_location || '') === String(room) &&
        String(log.period || '') === String(period)
      )
    );
  } catch (err) {
    console.error('Error fetching logs for room and period:', err);
    res.status(500).json({ error: 'Failed to fetch logs for room and period' });
  }
});

/**
 * GET /api/logs/:room/:period/:date
 * Returns all visible logs filtered to a specific room, period, and date.
 * @ai-generated
 * @access Authenticated
 * @param {string} room - The scanner_location value to filter by.
 * @param {string} period - The period label to filter by (e.g. "Period 1").
 * @param {string} date - The date_scanned value to filter by (YYYY-MM-DD).
 * @returns {200} Array of log objects for the specified room, period, and date.
 */
app.get('/api/logs/:room/:period/:date', verifyToken, async (req, res) => {
  const { room, period, date } = req.params;
  try {
    const visibleLogs = await getVisibleLogsForUser(req.user);
    res.json(
      visibleLogs.filter(log =>
        String(log.scanner_location || '') === String(room) &&
        String(log.period || '') === String(period) &&
        String(log.date_scanned || '') === String(date)
      )
    );
  } catch (err) {
    console.error('Error fetching logs for room and period:', err);
    res.status(500).json({ error: 'Failed to fetch logs for room and period' });
  }
});



/*---------------------------------------- Settings Endpoints ----------------------------------------------*/

/**
 * GET /api/settings/grace-period
 * Returns the current attendance grace period setting in minutes.
 * @ai-generated
 * @access Administrator only
 * @returns {200} { value: number } — The current grace period in minutes.
 */
app.get('/api/settings/grace-period', verifyToken, requireRole('administrator'), (req, res) => {
  res.json({ value: ATTENDANCE_GRACE_PERIOD_MINUTES });
});

/**
 * PUT /api/settings/grace-period
 * Updates the attendance grace period setting and persists it to disk.
 * @ai-generated
 * @access Administrator only
 * @body {{ value: number }} The new grace period in minutes (must be >= 0).
 * @returns {200} { success: true } on success.
 */
app.put('/api/settings/grace-period', verifyToken, requireRole('administrator'), (req, res) => {
  const { value } = req.body;
  if (isNaN(value) || value < 0) {
    return res.status(400).json({ error: 'Invalid value' });
  }
  settings.gracePeriodMinutes = Number(value);
  saveSettings();
  ATTENDANCE_GRACE_PERIOD_MINUTES = Number(value);
  res.json({ success: true });
});

/*----------------------------------------Routes----------------------------------------*/
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/', redirectIfNotAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/room', redirectIfNotAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pages', 'room.html'));
});

app.get('/profile', redirectIfNotAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pages', 'profile.html'));
});

app.get('/analytics', redirectIfNotAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pages', 'analytics.html'));
});

app.get('/master_logs', redirectIfNotAuthenticated, requireRole('administrator'), (req, res) => {
res.sendFile(path.join(__dirname, 'public', 'pages', 'master_logs.html'));
});

app.get('/my_logs', redirectIfNotAuthenticated, (req, res) => {
res.sendFile(path.join(__dirname, 'public', 'pages', 'teacher_logs.html'));
});

app.get('/calendar', redirectIfNotAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pages', 'calendar.html'));
});

app.get('/map', redirectIfNotAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pages', 'current_class_map.html'));
});

app.get('/lookup', redirectIfNotAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pages', 'student_lookup.html'));
});

app.get('/scanners', redirectIfNotAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pages', 'connected_scanners.html'));
});

app.get('/app_settings', redirectIfNotAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pages', 'app_settings.html'));
});

app.get('/admin', redirectIfNotAuthenticated, requireRole('administrator'), (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pages', 'admin.html'));
});

app.use(express.static(path.join(__dirname, "public")));

/*----------------------------------------Start Server----------------------------------------*/

/**
 * Initializes the database, starts the periodic scanner offline-check interval,
 * loads persisted settings, and begins listening on the configured PORT.
 * @ai-generated
 * @returns {Promise<void>}
 */
async function startServer() {
  await initializeDatabase();
  setInterval(async () => {
    try {
      await pool.query(`
        UPDATE scanners 
        SET scanner_status = 'offline' 
        WHERE (last_sync IS NOT NULL)
          AND (last_sync::timestamp) < NOW() - INTERVAL '2 minutes'
          AND scanner_status = 'online'
      `);
    } catch (err) {
      console.error('Offline checker error:', err);
    }
  }, 30 * 1000);
  loadSettings();
  server.listen(process.env.PORT, () => {
    console.log(`Server running on port ${process.env.PORT}`);
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}
export {
  getFallbackPeriods,
  extractPeriods,
  assignPeriodForLog,
  getPeriodsForDate,
  calendarCache
};