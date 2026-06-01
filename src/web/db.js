import pkg from 'pg';
const { Pool } = pkg;
import bcrypt from 'bcrypt';

export const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
    database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: Number(process.env.DB_PORT)
});

export async function initializeDatabase() {
    await initWebUsers();
    await initAppUsers();
    await initCourses();
    await initUserSettings();
    await initNotifications();
    await initLogs();
    await initScanners();
    await initMap();
}

async function initAppUsers() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS students (
                id SERIAL PRIMARY KEY,
                uuid TEXT UNIQUE,
                student_id int,
                password_hash VARCHAR(255) NOT NULL,
                first_name VARCHAR(100),
                last_name VARCHAR(100),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('App student table initialized');
    } catch (err) {
        console.error('Error initializing web user table:', err);
    } finally {
        client.release();
    }
}

async function initWebUsers() {
  const client = await pool.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        first_name VARCHAR(100),
        last_name VARCHAR(100),
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(50) NOT NULL CHECK (role IN ('teacher', 'administrator')),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        courses TEXT[] DEFAULT '{}',
        device_tokens TEXT[] DEFAULT '{}'
      );
    `);
    console.log('Web user table initialized.');
    const { rows } = await client.query('SELECT COUNT(*) FROM users');
    const userCount = parseInt(rows[0].count);

    if (userCount === 0) {
      const hashedPassword = await bcrypt.hash('1Likepigs', 10);
      await client.query(
        `
        INSERT INTO users 
        (email, first_name, last_name, password_hash, role)
        VALUES ($1, $2, $3, $4, $5)
        `,
        [
          'c.oldoerp26@bosco.org',
          'Conrad',
          'Oldoerp',
          hashedPassword,
          'administrator'
        ]
      );

      console.log('Default administrator created.');
    }

  } catch (err) {
    console.error('Error initializing web user table:', err);
  } finally {
    client.release();
  }
}

async function initLogs() {
  const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS logs (
                id SERIAL PRIMARY KEY,
                period TEXT,
                scanner_location TEXT,
                scanner_id TEXT,
                student_id TEXT,
                first_name TEXT,
                last_name TEXT,
                time_scanned TEXT,
                date_scanned TEXT,
                status TEXT
            );
        `);
        console.log('Logs table initialized.');
    }
    catch (err) {
        console.error('Error initializing logs table:', err);
    }
    finally {
        client.release();
    }
}

async function initScanners() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS scanners (
                id SERIAL PRIMARY KEY,
                scanner_id TEXT UNIQUE,
                scanner_location TEXT,
                password_hash VARCHAR(255) NOT NULL,
                scanner_status TEXT,
                last_sync TEXT,
                battery_level TEXT
            );
            `);
        console.log('Scanners table initialized.');
    }
    catch (err) {
        console.error('Error initializing scanners table:', err);
    }
    finally {
        client.release();
    }
}

async function initMap() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS map_layouts (
        id INTEGER PRIMARY KEY DEFAULT 1,
        data JSONB NOT NULL DEFAULT '{"rooms":[],"scanners":[]}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT single_row CHECK (id = 1)
      );
    `);
    console.log('Map layouts table initialized (global).');
  } catch (err) {
    console.error('Error initializing map table:', err);
  } finally {
    client.release();
  }
}

async function initCourses() {
  const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS courses (
                id SERIAL PRIMARY KEY,
                room VARCHAR(50) NOT NULL,
                period VARCHAR(50) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(room, period)
            );
        `);
        console.log('Courses table initialized.');
    } catch (err) {
        console.error('Error initializing courses table:', err);
    } finally {
        client.release();
    }
}

async function initUserSettings() {
  const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS user_settings (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                capacity_alerts BOOLEAN DEFAULT true,
                unexpected_appearance_alerts BOOLEAN DEFAULT true,
                grace_period_minutes INTEGER DEFAULT 5,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id)
            );
        `);
        console.log('User settings table initialized.');
    } catch (err) {
        console.error('Error initializing user settings table:', err);
    } finally {
        client.release();
    }
}

async function initNotifications() {
  const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS notifications (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                title VARCHAR(255) NOT NULL,
                message TEXT,
                type VARCHAR(50),
                is_read BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('Notifications table initialized.');
    } catch (err) {
        console.error('Error initializing notifications table:', err);
    } finally {
        client.release();
    }
}
